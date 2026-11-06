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
import { MISC_ID, type AppData, type BankTxn, type SpendEntry } from '../types';
import { buildModel, predict, type Model, type Prediction } from './learn';
import { describeMerchant, sameStore, type MerchantInfo } from './merchant';
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
    const base = `${t.date}|${t.flow.toFixed(2)}|${t.description.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const k = seen.get(base) || 0;
    seen.set(base, k + 1);
    return `csv:${fnv(base)}:${k}`;
  });
}

interface Ctx { data: AppData; model: Model; today: IsoDate; billNames: Array<{ key: string; name: string; amount: number }>; usedEntries: Set<string> }

function billMatch(ctx: Ctx, t: RawTxn, m: MerchantInfo): string | null {
  const words = ` ${m.key} ${t.description.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  const amt = round2(-t.flow);
  // The bill's name in the text and a similar amount (bills like electric vary, but not tenfold).
  for (const b of ctx.billNames) {
    if (b.key.length < 4 || !(sameStore(b.key, m.key) || words.includes(` ${b.key} `))) continue;
    if (!(b.amount > 0) || (amt >= b.amount * 0.5 && amt <= b.amount * 2)) return b.name;
  }
  // Same amount within a few days of a bill's date.
  const ms = parseISOToMs(t.date);
  const occ = occurrencesForRange(ms - 4 * DAY_MS, ms + 4 * DAY_MS, ctx.data.bills, ctx.data.settings);
  for (const list of occ.values()) for (const o of list) if (Math.abs(Number(o.amount) - amt) < 0.005) return o.name;
  return null;
}

/** A log you entered yourself for this same purchase (exact amount, within a few days). */
function findManualLog(ctx: Ctx, t: RawTxn, m: MerchantInfo, refund: boolean): { sure?: SpendEntry; maybe?: SpendEntry } {
  const amt = round2(Math.abs(t.flow));
  let sure: SpendEntry | undefined, maybe: SpendEntry | undefined, bestSure = 99, bestMaybe = 99;
  for (const e of ctx.data.spendEntries) {
    if (e.bankTxnId || ctx.usedEntries.has(e.id) || (e.amount < 0) !== refund) continue;
    const dd = dayDiff(t.date, e.date); // the bank usually posts on or after the day you logged it
    if (dd < -2 || dd > 5) continue;
    const noteStore = describeMerchant(e.note || '');
    const storeOk = !noteStore.key || sameStore(noteStore.key, m.key) || (!!noteStore.kind && noteStore.kind === m.kind);
    const exact = Math.abs(Math.abs(e.amount) - amt) < 0.005;
    if (exact && storeOk) { if (Math.abs(dd) < bestSure) { sure = e; bestSure = Math.abs(dd); } }
    else if ((exact || (sameStore(noteStore.key, m.key) && Math.abs(Math.abs(e.amount) - amt) <= amt * 0.25)) && Math.abs(dd) < bestMaybe) { maybe = e; bestMaybe = Math.abs(dd); }
  }
  return { sure, maybe };
}

function baseTxn(id: string, t: RawTxn, m: MerchantInfo): BankTxn {
  return {
    id, date: t.date, amount: round2(t.flow), description: t.memo && /^(pos|debit|purchase|card)\b/i.test(t.description) ? `${t.description} ${t.memo}` : t.description,
    merchant: m.name || t.description.slice(0, 40), merchantKey: m.key, bankCategory: t.bankCategory, account: t.account,
    status: 'review', how: '', entryIds: [], importedAt: '',
  };
}

function classify(ctx: Ctx, id: string, t: RawTxn): PlanItem {
  const m = describeMerchant(t.memo && /^(pos|debit|purchase|card)\b/i.test(t.description) ? `${t.description} ${t.memo}` : t.description);
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
  } else {
    const bill = billMatch(ctx, t, m);
    if (bill) return { ...skip('bill'), txn: { ...txn, status: 'skipped', how: `bill:${bill}` } };
  }

  const refund = moneyIn;
  const { sure, maybe } = findManualLog(ctx, t, m, refund);
  if (sure) {
    ctx.usedEntries.add(sure.id);
    return { txn: { ...txn, status: 'logged', how: 'matched' }, action: 'match', matchEntryId: sure.id, refund };
  }
  const prediction = predict(ctx.model, m, Math.abs(t.flow), t.bankCategory);
  const withSuggest = { ...txn, suggest: prediction.suggestions.map((s) => ({ extraId: s.extraId, p: round2(s.p) })), maybeSameAs: maybe?.id };
  if (rule?.action === 'budget' && rule.extraId && ctx.model.budgets.has(rule.extraId) && !maybe) {
    return { txn: { ...withSuggest, status: 'logged', how: 'rule' }, action: 'log', extraId: rule.extraId, refund, prediction };
  }
  const mustAsk = rule?.action === 'ask' || m.kind === 'p2p' || m.kind === 'fee' || !!maybe;
  if (!mustAsk && prediction.auto) {
    return { txn: { ...withSuggest, status: 'logged', how: 'auto' }, action: 'log', extraId: prediction.suggestions[0].extraId, refund, prediction };
  }
  return { txn: withSuggest, action: 'review', refund, prediction };
}

/** What an import would do, without changing anything. */
export function planImport(data: AppData, parsed: ParsedStatement, today: IsoDate, opts: { includePending?: boolean } = {}): ImportPlan {
  const model = buildModel(data, today);
  const billNames = [
    ...data.bills.map((b) => ({ name: b.name, amount: Number(b.amount) || 0 })),
    ...data.debts.map((x) => ({ name: x.name, amount: round2(Number(x.minPayment || 0) + Number(x.extraPayment || 0)) })),
  ].map((b) => ({ ...b, key: describeMerchant(b.name).key })).filter((b) => b.key);
  const ctx: Ctx = { data, model, today, billNames, usedEntries: new Set() };
  const known = new Set(data.bank.txns.map((t) => t.id));
  const ids = txnIds(parsed.txns);
  const items: PlanItem[] = [];
  let alreadyImported = 0, pending = 0;
  parsed.txns.forEach((t, i) => {
    if (t.pending && !opts.includePending) { pending++; return; }
    const id = ids[i];
    if (known.has(id)) { alreadyImported++; return; }
    // Same transaction from the other file type (CSV vs QFX/OFX).
    const key = describeMerchant(t.description).key;
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
