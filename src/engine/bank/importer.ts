/**
 * Bank statement import: decides what each transaction is (a purchase, a refund, or not spending such as a
 * transfer, your paycheck, a card payment or a bill already in your plan), guards against duplicates, and files
 * purchases into budgets when it's sure. Everything else waits in "To review".
 *
 * Duplicates are stopped four ways:
 *  - a transaction seen in an earlier import is skipped (bank id for QFX/OFX; date, amount and text for CSV,
 *    counting identical same-day purchases separately);
 *  - the same purchase from a different file type (CSV one time, QFX the next) is matched by store, amount and date;
 *  - a purchase you already logged by hand is linked to that log instead of being added again;
 *  - pending transactions are left out, so a hold and its final charge can't both count.
 */
import { DAY_MS, parseISOToMs, type IsoDate } from '../dates';
import { newId } from '../loans';
import { round2 } from '../money';
import { occurrencesForRange } from '../schedule';
import { MISC_ID, type AppData, type BankTxn, type RecurringItem, type SpendEntry } from '../types';
import { buildModel, predict, type Model, type Prediction } from './learn';
import { billPhrase, describeMerchant, GENERAL_STORES, nameWords, plainWords, sameStore, type MerchantInfo, type MerchantKind } from './merchant';
import type { ParsedStatement, RawTxn } from './statement';

export type ItemAction = 'log' | 'review' | 'skip' | 'match';
export interface PlanItem {
  txn: BankTxn;
  action: ItemAction;
  /** Budget for 'log'. */
  extraId?: string;
  /** Your log for 'match'. */
  matchEntryId?: string;
  refund: boolean;
  prediction?: Prediction;
}
export interface ImportPlan {
  items: PlanItem[];
  alreadyImported: number;
  pending: number;
  skippedRows: number;
  from?: IsoDate;
  to?: IsoDate;
  account?: string;
}

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
};
const dayDiff = (a: IsoDate, b: IsoDate) => Math.round((parseISOToMs(a) - parseISOToMs(b)) / DAY_MS);
const format = (id: string) => id.split(':')[0];

/** Stable ids, so importing the same transactions again is recognized. */
export function txnIds(txns: RawTxn[]): string[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    if (t.fitid) return `ofx:${t.account || ''}:${t.fitid}`;
    const text = (t.source === 'pdf' ? `${t.account || ''}|${t.description}|${t.memo || ''}` : t.description).toLowerCase().replace(/\s+/g, ' ').trim();
    const base = `${t.source || 'csv'}|${t.date}|${t.flow.toFixed(2)}|${text}`;
    const k = seen.get(base) || 0;
    seen.set(base, k + 1);
    // CSV ids keep their original form so files imported before PDFs were supported are still recognized.
    return t.source === 'pdf' ? `pdf:${fnv(base)}:${k}` : `csv:${fnv(base.slice(4))}:${k}`;
  });
}

const STRUCTURAL: MerchantKind[] = ['transfer', 'cardPayment', 'payroll', 'interest'];

/** Store, key and kind for a transaction: its text, the second line when the first names no store, and what the
 *  statement's transaction type says (a transfer is a transfer whatever its text). */
export function merchantOf(t: RawTxn): MerchantInfo {
  let m = describeMerchant(t.memo && /^(pos|debit|purchase|card)\b/i.test(t.description) ? `${t.description} ${t.memo}` : t.description);
  if (t.memo && !m.key && !m.kind) {
    const alt = describeMerchant(t.memo);
    if (alt.key || alt.kind) m = alt;
  }
  const hint = t.kindHint;
  if (!hint || hint === m.kind) return m;
  if (STRUCTURAL.includes(hint)) return { ...m, kind: hint, key: m.known ? m.key : hint };
  if (hint === 'fee') return m.kind === 'atm' ? { name: 'ATM fee', key: 'atmfee', kind: 'fee', known: false } : { ...m, kind: 'fee' };
  if (hint === 'atm' && !m.kind) return { name: 'ATM withdrawal', key: 'atm', kind: 'atm', known: false };
  return m;
}

interface BillRef { id: string; key: string; known: boolean; name: string; amount: number; debt: boolean; words: string[]; strict: boolean }
interface Ctx { data: AppData; model: Model; today: IsoDate; bills: BillRef[]; usedEntries: Set<string> }

/** The words of a transaction's text, padded with spaces so whole words can be looked up. */
const textOf = (m: MerchantInfo, t: { description: string; memo?: string }) => ` ${m.key} ${plainWords(t.description)} ${plainWords(t.memo || '')} `.replace(/\s+/g, ' ');
/** Bills like electric vary, but not tenfold. */
const nearAmount = (amt: number, base: number) => !(base > 0) || (amt >= base * 0.5 && amt <= base * 2);

interface BillHit { sure?: { id: string; name: string }; guess?: { id: string; name: string; amount: number } }

/** One of your bills (or loans): sure, or a guess when the name fits but the amount is far from the plan's. */
function billMatch(ctx: Ctx, t: RawTxn, m: MerchantInfo): BillHit {
  const words = textOf(m, t);
  const amt = round2(-t.flow);
  let guess: BillHit['guess'];
  // Bank text you said is a bill (closest remembered amount first, when several bills share it).
  const links = (ctx.data.bank.billLinks || []).slice().sort((a, b) => Math.abs(a.amount - amt) - Math.abs(b.amount - amt));
  for (const l of links) {
    const b = l.text && words.includes(` ${l.text} `) ? ctx.data.bills.find((x) => x.id === l.billId) : undefined;
    if (!b) continue;
    if (nearAmount(amt, l.amount) || nearAmount(amt, Number(b.amount) || 0)) return { sure: { id: b.id, name: b.name } };
    guess ??= { id: b.id, name: b.name, amount: Number(b.amount) || 0 };
  }
  // The bill's name in the text and a similar amount. A bill named after a store where you also shop
  // ("Google Play Pass", "Amazon Prime") needs its whole name in the text.
  for (const b of ctx.bills) {
    const named = b.strict ? b.words.length > 0 && b.words.every((w) => words.includes(` ${w} `)) : sameStore(b.key, m.key) || words.includes(` ${b.key} `);
    if ((b.key.length < 4 && !b.known) || !named) continue;
    if (nearAmount(amt, b.amount)) return { sure: { id: b.id, name: b.name } };
    if (!b.debt) guess ??= { id: b.id, name: b.name, amount: b.amount };
  }
  // Same amount within a few days of a bill's date.
  const ms = parseISOToMs(t.date);
  const occ = occurrencesForRange(ms - 4 * DAY_MS, ms + 4 * DAY_MS, ctx.data.bills, ctx.data.settings);
  for (const list of occ.values()) for (const o of list) if (Math.abs(Number(o.amount) - amt) < 0.005) return { sure: { id: o.id, name: o.name } };
  return { guess };
}

/**
 * A log you entered yourself for this same purchase.
 *  - sure (linked without asking): the exact amount, the same store or a note naming none, within a few days;
 *  - maybe (you're asked): within a few days, the exact amount at another store or the same store at a close
 *    amount (a tip); or the exact amount at the same store logged up to two weeks away from the bank's date
 *    (a purchase logged days later, dated the day it was logged).
 */
function findManualLog(ctx: Ctx, t: RawTxn, m: MerchantInfo, refund: boolean): { sure?: SpendEntry; maybe?: SpendEntry } {
  const amt = round2(Math.abs(t.flow));
  let sure: SpendEntry | undefined, maybe: SpendEntry | undefined, late: SpendEntry | undefined;
  let bestSure = 99, bestMaybe = 99, bestLate = 99;
  for (const e of ctx.data.spendEntries) {
    if (e.bankTxnId || ctx.usedEntries.has(e.id) || (e.amount < 0) !== refund) continue;
    const dd = dayDiff(t.date, e.date);
    const ad = Math.abs(dd);
    if (ad > 14) continue;
    const near = dd >= -2 && dd <= 5; // the bank usually posts on or after the day you logged it
    const noteStore = describeMerchant(e.note || '');
    // A note without a store name ("gas") fits any store; "gas station food" fits any gas station.
    const storeOk = !noteStore.key || sameStore(noteStore.key, m.key) || (noteStore.kind === 'gas' && m.kind === 'gas');
    const exact = Math.abs(Math.abs(e.amount) - amt) < 0.005;
    if (near && exact && storeOk) { if (ad < bestSure) { sure = e; bestSure = ad; } }
    else if (near && (exact || (sameStore(noteStore.key, m.key) && Math.abs(Math.abs(e.amount) - amt) <= amt * 0.25))) { if (ad < bestMaybe) { maybe = e; bestMaybe = ad; } }
    else if (exact && storeOk && ad < bestLate) { late = e; bestLate = ad; }
  }
  return { sure, maybe: maybe ?? late };
}

function baseTxn(id: string, t: RawTxn, m: MerchantInfo): BankTxn {
  return {
    id, date: t.date, amount: round2(t.flow),
    // A PDF's second line is the bank's own text for the store (the first is its tidied name).
    description: t.memo && (t.source === 'pdf' || /^(pos|debit|purchase|card)\b/i.test(t.description)) ? (t.source === 'pdf' ? t.memo : `${t.description} ${t.memo}`) : t.description,
    merchant: m.name || t.description.slice(0, 40), merchantKey: m.key, ...(m.kind ? { kind: m.kind } : {}), bankCategory: t.bankCategory, account: t.account,
    status: 'review', how: '', entryIds: [], importedAt: '',
  };
}

function classify(ctx: Ctx, id: string, t: RawTxn): PlanItem {
  const m = merchantOf(t);
  const txn = baseTxn(id, t, m);
  const skip = (how: string): PlanItem => ({ txn: { ...txn, status: 'skipped', how }, action: 'skip', refund: false });
  const rule = m.key ? ctx.data.bank.rules.find((r) => sameStore(r.key, m.key)) : undefined;
  if (rule?.action === 'skip') return skip('rule');
  const moneyIn = t.flow > 0;

  if (m.kind === 'transfer') return skip('transfer');
  if (m.kind === 'cardPayment') return skip('card payment');
  if (moneyIn) {
    const s = ctx.data.settings;
    const isPay = m.kind === 'payroll' || [s.pay.paycheckCap, s.pay2?.paycheckCap].some((cap) => cap && Math.abs(Number(cap) - t.flow) < 1);
    if (isPay) return skip('paycheck');
    if (m.kind === 'interest' || m.kind === 'p2p' || !m.key || !ctx.model.byKey.has(m.key)) return skip('money in');
  }
  let billGuess: BillHit['guess'];
  if (!moneyIn) {
    const bill = billMatch(ctx, t, m);
    if (bill.sure) return { ...skip('bill'), txn: { ...txn, status: 'skipped', how: `bill:${bill.sure.name}`, billId: bill.sure.id } };
    billGuess = bill.guess;
  }

  const refund = moneyIn;
  const { sure, maybe } = findManualLog(ctx, t, m, refund);
  if (sure) {
    ctx.usedEntries.add(sure.id);
    return { txn: { ...txn, status: 'logged', how: 'matched' }, action: 'match', matchEntryId: sure.id, refund };
  }
  const prediction = predict(ctx.model, m, Math.abs(t.flow), t.bankCategory);
  const withSuggest = { ...txn, suggest: prediction.suggestions.map((s) => ({ extraId: s.extraId, p: round2(s.p) })), maybeSameAs: maybe?.id, ...(billGuess ? { billGuess } : {}) };
  if (rule?.action === 'budget' && rule.extraId && ctx.model.budgets.has(rule.extraId) && !maybe && !billGuess) {
    return { txn: { ...withSuggest, status: 'logged', how: 'rule' }, action: 'log', extraId: rule.extraId, refund, prediction };
  }
  const mustAsk = rule?.action === 'ask' || m.kind === 'p2p' || m.kind === 'fee' || !!maybe || !!billGuess;
  if (!mustAsk && prediction.auto) {
    return { txn: { ...withSuggest, status: 'logged', how: 'auto' }, action: 'log', extraId: prediction.suggestions[0].extraId, refund, prediction };
  }
  return { txn: withSuggest, action: 'review', refund, prediction };
}

/** What an import would do, without changing anything. */
export function planImport(data: AppData, parsed: ParsedStatement, today: IsoDate, opts: { includePending?: boolean } = {}): ImportPlan {
  const model = buildModel(data, today);
  const bills = [
    ...data.bills.map((b) => ({ id: b.id, name: b.name, amount: Number(b.amount) || 0, debt: false })),
    ...data.debts.map((x) => ({ id: x.id, name: x.name, amount: round2(Number(x.minPayment || 0) + Number(x.extraPayment || 0)), debt: true })),
  ].map((b) => {
    const info = describeMerchant(b.name);
    return { ...b, key: info.key, known: info.known, words: nameWords(b.name), strict: GENERAL_STORES.has(info.key) || model.byKey.has(info.key) };
  }).filter((b) => b.key);
  const ctx: Ctx = { data, model, today, bills, usedEntries: new Set() };
  const known = new Set(data.bank.txns.map((t) => t.id));
  const ids = txnIds(parsed.txns);
  const items: PlanItem[] = [];
  let alreadyImported = 0, pending = 0;
  parsed.txns.forEach((t, i) => {
    if (t.pending && !opts.includePending) { pending++; return; }
    const id = ids[i];
    if (known.has(id)) { alreadyImported++; return; }
    // Same transaction from the other file type (CSV vs QFX/OFX).
    const key = merchantOf(t).key;
    const crossFormat = data.bank.txns.some((o) => format(o.id) !== format(id) && Math.abs(o.amount - t.flow) < 0.005 && Math.abs(dayDiff(o.date, t.date)) <= 3 && (!key || !o.merchantKey || sameStore(o.merchantKey, key)));
    if (crossFormat) { alreadyImported++; return; }
    items.push(classify(ctx, id, t));
  });
  const dates = items.map((x) => x.txn.date).sort();
  return { items, alreadyImported, pending, skippedRows: parsed.skippedRows, from: dates[0], to: dates[dates.length - 1], account: parsed.account };
}

function budgetName(d: AppData, id: string) {
  return id === MISC_ID ? 'Misc' : d.extras.find((x) => x.id === id)?.name || 'Budget';
}

function makeEntry(d: AppData, t: BankTxn, extraId: string, amount: number, refund: boolean, nowIso: string, note?: string): SpendEntry {
  const a = round2(Math.abs(amount));
  return {
    id: newId('xs'), extraId, extraName: budgetName(d, extraId), amount: refund ? -a : a, entryType: refund ? 'refund' : 'spend',
    date: t.date, note: note ?? t.merchant, createdAt: nowIso, merchant: t.merchant, merchantKey: t.merchantKey, bankTxnId: t.id,
  };
}

export interface ImportCounts { logged: number; matched: number; review: number; skipped: number }

/** Saves an import plan into the data (use inside update()). */
export function applyImport(d: AppData, plan: ImportPlan, nowIso: string): ImportCounts {
  const counts: ImportCounts = { logged: 0, matched: 0, review: 0, skipped: 0 };
  for (const item of plan.items) {
    const t: BankTxn = { ...item.txn, importedAt: nowIso, entryIds: [] };
    if (item.action === 'log' && item.extraId) {
      const e = makeEntry(d, t, item.extraId, t.amount, item.refund, nowIso);
      d.spendEntries.push(e);
      t.entryIds = [e.id];
      counts.logged++;
    } else if (item.action === 'match' && item.matchEntryId) {
      const e = d.spendEntries.find((x) => x.id === item.matchEntryId);
      if (e) {
        e.bankTxnId = t.id;
        if (!e.merchantKey) { e.merchantKey = t.merchantKey; e.merchant = t.merchant; }
        t.entryIds = [e.id];
        counts.matched++;
      } else { t.status = 'review'; counts.review++; }
    } else if (item.action === 'skip') counts.skipped++;
    else counts.review++;
    d.bank.txns.push(t);
  }
  d.bank.lastImportAt = nowIso;
  if (plan.to && (!d.bank.lastTxnDate || plan.to > d.bank.lastTxnDate)) d.bank.lastTxnDate = plan.to;
  return counts;
}

// ---------- resolving "To review" ----------

const txnOf = (d: AppData, id: string) => d.bank.txns.find((t) => t.id === id);

/** Undo what a transaction put in your logs: delete logs it created, unlink a log of yours it matched. */
function clearEntries(d: AppData, t: BankTxn) {
  const ids = new Set(t.entryIds);
  if (t.how === 'matched') {
    for (const e of d.spendEntries) if (ids.has(e.id) && e.bankTxnId === t.id) delete e.bankTxnId;
  } else {
    d.spendEntries = d.spendEntries.filter((e) => !(ids.has(e.id) && e.bankTxnId === t.id));
  }
  t.entryIds = [];
}

/** File a transaction in one budget, or split it across several (amounts add up to the transaction). */
export function fileTxn(d: AppData, txnId: string, parts: Array<{ extraId: string; amount: number }>, nowIso: string): boolean {
  const t = txnOf(d, txnId);
  if (!t || !parts.length) return false;
  const total = round2(Math.abs(t.amount));
  const sum = round2(parts.reduce((s, p) => s + Math.abs(p.amount), 0));
  if (Math.abs(sum - total) > 0.005) return false;
  clearEntries(d, t);
  const refund = t.amount > 0;
  const split = parts.length > 1;
  for (const p of parts) {
    if (!(Math.abs(p.amount) > 0)) continue;
    const e = makeEntry(d, t, p.extraId, p.amount, refund, nowIso, split ? `${t.merchant} (split)` : undefined);
    d.spendEntries.push(e);
    t.entryIds.push(e.id);
  }
  t.status = 'logged';
  t.how = 'you';
  delete t.maybeSameAs;
  return true;
}

/** Not spending (or not this budget's business). With always, the store is skipped from now on. */
export function skipTxn(d: AppData, txnId: string, always = false) {
  const t = txnOf(d, txnId);
  if (!t) return;
  clearEntries(d, t);
  t.status = 'skipped';
  t.how = 'you';
  delete t.maybeSameAs;
  if (always && t.merchantKey) {
    d.bank.rules = d.bank.rules.filter((r) => r.key !== t.merchantKey);
    d.bank.rules.push({ key: t.merchantKey, name: t.merchant, action: 'skip' });
  }
}

/**
 * It's one of your bills, not spending. Pass a new bill to add it to your bills as well. The bank's text is
 * remembered for that bill, so the next charge like it is recognized even when its amount differs from the plan's.
 */
export function markAsBill(d: AppData, txnId: string, bill: string | RecurringItem, opts: { updateAmount?: boolean } = {}): boolean {
  const t = txnOf(d, txnId);
  if (!t) return false;
  let b: RecurringItem | undefined;
  if (typeof bill === 'string') b = d.bills.find((x) => x.id === bill);
  else if (!d.bills.some((x) => x.id === bill.id)) {
    b = { ...bill };
    d.bills.push(b);
    d.order.bills = [...d.order.bills.filter((id) => id !== b!.id), b.id];
  } else b = d.bills.find((x) => x.id === bill.id);
  if (!b) return false;
  const amount = round2(Math.abs(t.amount));
  if (opts.updateAmount) b.amount = amount;
  clearEntries(d, t);
  t.status = 'skipped';
  t.how = `bill:${b.name}`;
  t.billId = b.id;
  delete t.maybeSameAs;
  delete t.billGuess;
  const text = billPhrase(t.description);
  if (text) d.bank.billLinks = [...(d.bank.billLinks || []).filter((l) => !(l.text === text && l.billId === b!.id)), { billId: b.id, text, amount }];
  return true;
}

/** The bill whose remembered bank text is in this transaction (so a second charge like one you just marked is spotted). */
export function linkedBill(d: AppData, t: BankTxn): RecurringItem | undefined {
  const words = textOf(describeMerchant(t.merchant), t);
  const amt = Math.abs(t.amount);
  const links = (d.bank.billLinks || []).filter((x) => x.text && words.includes(` ${x.text} `) && d.bills.some((b) => b.id === x.billId));
  // Of several bills with this bank text, the one charged closest to this amount.
  const l = links.sort((a, b) => Math.abs(a.amount - amt) - Math.abs(b.amount - amt))[0];
  return l ? d.bills.find((b) => b.id === l.billId) : undefined;
}

/** One of your bills named in a transaction's text, by the same rules the import uses (for items already in To review). */
export function namedBill(d: AppData, t: BankTxn): RecurringItem | undefined {
  const words = textOf(describeMerchant(t.merchant), t);
  return d.bills.find((b) => {
    const info = describeMerchant(b.name);
    if (!info.key || (info.key.length < 4 && !info.known)) return false;
    if (!GENERAL_STORES.has(info.key)) return sameStore(info.key, t.merchantKey) || words.includes(` ${info.key} `);
    const w = nameWords(b.name);
    return w.length > 0 && w.every((x) => words.includes(` ${x} `));
  });
}

/** Your bills with the likeliest first: the one it guessed, a name in the bank text, the same amount, a nearby due day. */
export function billChoices(d: AppData, t: BankTxn): Array<{ bill: RecurringItem; likely: boolean }> {
  const words = textOf(describeMerchant(t.merchant), t);
  const amt = Math.abs(t.amount), day = Number(t.date.slice(8, 10));
  const order = new Map(d.order.bills.map((id, i) => [id, i]));
  const score = (b: RecurringItem) => {
    const info = describeMerchant(b.name);
    let s = 0;
    if (t.billGuess?.id === b.id) s += 8;
    if ((d.bank.billLinks || []).some((l) => l.billId === b.id && words.includes(` ${l.text} `))) s += 6;
    if (info.key && (sameStore(info.key, t.merchantKey) || (info.key.length >= 4 && words.includes(` ${info.key} `)))) s += 4;
    if (Number(b.amount) > 0 && Math.abs(Number(b.amount) - amt) <= Math.max(0.5, amt * 0.02)) s += 2;
    if (b.rule.type === 'monthly_dom' && Math.abs(Number(b.rule.dom || 0) - day) <= 3) s += 1;
    return s;
  };
  return d.bills.map((bill) => ({ bill, s: score(bill) }))
    .sort((a, b) => b.s - a.s || (order.get(a.bill.id) ?? 999) - (order.get(b.bill.id) ?? 999))
    .map(({ bill, s }) => ({ bill, likely: s >= 3 }));
}

/** It's the same purchase as a log you already have: link them instead of adding another. */
export function linkTxn(d: AppData, txnId: string, entryId: string) {
  const t = txnOf(d, txnId);
  const e = d.spendEntries.find((x) => x.id === entryId);
  if (!t || !e) return;
  clearEntries(d, t);
  e.bankTxnId = t.id;
  if (!e.merchantKey) { e.merchantKey = t.merchantKey; e.merchant = t.merchant; }
  t.entryIds = [e.id];
  t.status = 'logged';
  t.how = 'matched';
  delete t.maybeSameAs;
}

/** Put a skipped transaction back in "To review". */
export function reviewAgain(d: AppData, txnId: string) {
  const t = txnOf(d, txnId);
  if (!t) return;
  clearEntries(d, t);
  t.status = 'review';
  t.how = '';
  delete t.billId;
}

/** A store rule you set on the Bank import page ('learn' removes it). */
export function setRule(d: AppData, key: string, name: string, action: 'budget' | 'ask' | 'skip' | 'learn', extraId?: string) {
  d.bank.rules = d.bank.rules.filter((r) => r.key !== key);
  if (action !== 'learn') d.bank.rules.push({ key, name, action, ...(action === 'budget' && extraId ? { extraId } : {}) });
}

export const reviewTxns = (d: AppData) => d.bank.txns.filter((t) => t.status === 'review').sort((a, b) => b.date.localeCompare(a.date));

/** Takes back one whole import: its transactions and the logs it created (your own matched logs stay). */
export function removeImport(d: AppData, importedAt: string): number {
  const batch = d.bank.txns.filter((t) => t.importedAt === importedAt);
  for (const t of batch) clearEntries(d, t);
  d.bank.txns = d.bank.txns.filter((t) => t.importedAt !== importedAt);
  d.bank.lastImportAt = d.bank.txns.map((t) => t.importedAt).sort().pop();
  d.bank.lastTxnDate = d.bank.txns.map((t) => t.date).sort().pop();
  return batch.length;
}
