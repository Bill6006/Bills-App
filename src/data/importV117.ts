/**
 * Import a v117 "bills-account-planner.json" export.
 * Step 1 ports v117's own migrateState so files from any older version load the way v117 loads them.
 * Step 2 recovers the real data when the file was exported in projected mode.
 * Step 3 normalizes items the way v117 does at render time, then maps everything into AppData.
 */
import { DAY_MS, isoDate, isMonthKey, isValidIso, normalizeISODateLoose, parseISOToMs, type IsoDate } from '../engine/dates';
import { clampInt, clampPct, num, round2 } from '../engine/money';
import { nextDueIsoAfter, prevDueIso, recalcFromPayments } from '../engine/loans';
import {
  MISC_ID, MISC_NAME,
  type AppData, type BillsSort, type Debt, type DebtPayment, type DebtStrategy, type PaySchedule, type RecurringItem,
  type Rule, type RuleType, type SavingsEvent, type SpendEntry, type SpendTransfer, type ThemePref, type TransferSplit,
} from '../engine/types';
import { DEFAULT_PREFS, makeDefaultData } from './defaults';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = '') => (v == null ? fallback : String(v));

export function looksLikeV117(o: unknown): boolean {
  return isObj(o) && isObj(o.settings) && (Array.isArray(o.bills) || Array.isArray(o.paydays) || Array.isArray(o.extras) || Array.isArray(o.events));
}

function v117DefaultState(today: IsoDate): Obj {
  const mk = today.slice(0, 7);
  return {
    ui: { theme: 'dark', ledgerView: 'table' },
    settings: {
      baseMonth: mk, baseMonthAutoSync: false, baseBillsBalance: 0, baseSavingsBalance: 0, trueSavingsMonth: mk, cushion: 0,
      pocket: { minimumSurvival: 0, thresholdMode: 'net' },
      pay: { frequency: 'semimonthly', paycheckCap: 0, anchorNextPayday: today, semimonthlyDom1: 15, semimonthlyDom2: 31, monthlyDom: 15, customDates: [] },
      pay2: null, otherIncomes: [],
      transferSplit: { pay2BillsPct: 0, pay2SavingsPct: 0, otherBillsPct: 0, otherSavingsPct: 0 },
      savings: { monthlyGoal: 0, timelineMonths: 6 },
    },
    selectedMonth: mk, bills: [], extras: [], debts: [], extraSpendEntries: [], extraSpendTransfers: [], events: [], extrasByMonth: {},
  };
}

function deepAssign(dst: Obj, src: Obj): Obj {
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v)) {
      if (!isObj(dst[k])) dst[k] = {};
      deepAssign(dst[k] as Obj, v);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

function normalizeTransferSplit(ts: unknown): TransferSplit {
  const o = { pay2BillsPct: 0, pay2SavingsPct: 0, otherBillsPct: 0, otherSavingsPct: 0, ...(isObj(ts) ? ts : {}) } as Record<string, unknown>;
  const out: TransferSplit = {
    pay2BillsPct: clampPct(o.pay2BillsPct), pay2SavingsPct: clampPct(o.pay2SavingsPct),
    otherBillsPct: clampPct(o.otherBillsPct), otherSavingsPct: clampPct(o.otherSavingsPct),
  };
  if (out.pay2BillsPct + out.otherBillsPct > 100) out.otherBillsPct = Math.max(0, 100 - out.pay2BillsPct);
  if (out.pay2SavingsPct + out.otherSavingsPct > 100) out.otherSavingsPct = Math.max(0, 100 - out.pay2SavingsPct);
  return out;
}

/** Port of v117 migrateState (structural upgrades only). */
export function migrateV117(s: Obj, today: IsoDate): Obj {
  const out = structuredClone(v117DefaultState(today));
  deepAssign(out, structuredClone(s));
  const settings = out.settings as Obj;
  if (!Array.isArray(out.extras)) out.extras = [];
  if (!Array.isArray(out.debts)) out.debts = [];
  out.debts = (out.debts as unknown[]).map((d, idx) => {
    const x = isObj(d) ? d : {};
    if (!x.id) x.id = `d${Date.now()}${idx}`;
    if (!x.name) x.name = 'Debt';
    x.balance = Math.max(0, round2(num(x.balance)));
    x.originalBalance = Math.max(x.balance as number, round2(num(x.originalBalance) || num(x.balance)));
    x.apr = Math.max(0, round2(num(x.apr)));
    x.minPayment = Math.max(0, round2(num(x.minPayment)));
    x.extraPayment = Math.max(0, round2(num(x.extraPayment)));
    x.dueDay = clampInt(x.dueDay || 1, 1, 31);
    x.priority = clampInt(x.priority || idx + 1, 1, 999);
    return x;
  });
  const extras = out.extras as Obj[];
  const seen = new Set(extras.map((x) => x && x.id).filter(Boolean));
  if (isObj(out.extrasByMonth)) {
    for (const [mk, arr] of Object.entries(out.extrasByMonth)) {
      if (!Array.isArray(arr)) continue;
      for (const x of arr as Obj[]) {
        if (!isObj(x)) continue;
        if (x._extraMonth == null) x._extraMonth = mk;
        if (!x.id) x.id = `${mk}-x${Math.random().toString(16).slice(2)}`;
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        extras.push(x);
      }
    }
  }
  out.extrasByMonth = {};
  if (!settings.baseMonth || !String(settings.baseMonth).trim()) settings.baseMonth = out.selectedMonth || today.slice(0, 7);
  const pay = settings.pay as Obj;
  if (pay.pay_frequency && !pay.frequency) { pay.frequency = pay.pay_frequency; delete pay.pay_frequency; }
  if (pay.amount && !pay.paycheckCap) pay.paycheckCap = num(pay.amount);
  if (!isObj(settings.pocket)) settings.pocket = { minimumSurvival: 0, thresholdMode: 'net' };
  const pocket = settings.pocket as Obj;
  pocket.minimumSurvival = Math.max(0, round2(num(pocket.minimumSurvival)));
  pocket.thresholdMode = pocket.thresholdMode === 'base' ? 'base' : 'net';
  pay.semimonthlyDom1 = clampInt(pay.semimonthlyDom1 ?? 15, 1, 31);
  pay.semimonthlyDom2 = clampInt(pay.semimonthlyDom2 ?? 31, 1, 31);
  pay.monthlyDom = clampInt(pay.monthlyDom ?? 15, 1, 31);
  if (!Array.isArray(pay.customDates)) pay.customDates = [];
  if (!settings.trueSavingsMonth) settings.trueSavingsMonth = settings.baseMonth || out.selectedMonth || '';
  if (settings.pay2 && !isObj(settings.pay2)) settings.pay2 = null;
  if (isObj(settings.pay2)) {
    const p2 = settings.pay2;
    if (!p2.frequency) p2.frequency = pay.frequency || 'semimonthly';
    if (!Array.isArray(p2.customDates)) p2.customDates = [];
    p2.semimonthlyDom1 = clampInt(p2.semimonthlyDom1 ?? 15, 1, 31);
    p2.semimonthlyDom2 = clampInt(p2.semimonthlyDom2 ?? 31, 1, 31);
    p2.monthlyDom = clampInt(p2.monthlyDom ?? 15, 1, 31);
  }
  if (!Array.isArray(settings.otherIncomes)) settings.otherIncomes = [];
  settings.transferSplit = normalizeTransferSplit(settings.transferSplit);
  return out;
}

const RULE_TYPES: RuleType[] = ['monthly_dom', 'weekly_dow', 'annual_md', 'one_time', 'biweekly', 'perpay'];

function toRule(r: unknown, legacyIso?: string): Rule {
  if (!isObj(r)) return legacyIso ? { type: 'one_time', anchor: legacyIso } : { type: 'monthly_dom', dom: 1 };
  const type = (RULE_TYPES.includes(r.type as RuleType) ? r.type : r.type ? r.type : 'monthly_dom') as RuleType;
  const rule: Rule = { type };
  if (r.dom != null) rule.dom = clampInt(r.dom, 1, 31);
  if (r.dow != null) rule.dow = clampInt(r.dow, 0, 6);
  const anchor = str(r.anchor || r.iso || r.date || r.ymd || '');
  if (anchor) rule.anchor = anchor;
  return rule;
}

function toItem(x: Obj, fallbackName: string, idPrefix: string, i: number): RecurringItem {
  const legacyIso = !x.rule && (x.iso || x.memo) ? str(x.iso) : undefined;
  const item: RecurringItem = {
    id: str(x.id) || `${idPrefix}${Date.now().toString(36)}${i}`,
    name: str(x.name || x.memo || fallbackName),
    amount: num(x.amount),
    rule: toRule(x.rule, legacyIso),
  };
  if (typeof x._extraMonth === 'string' && x._extraMonth) item._extraMonth = x._extraMonth;
  return item;
}

function toPay(p: unknown, today: IsoDate): PaySchedule {
  const o = isObj(p) ? p : {};
  const freq = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'custom'].includes(str(o.frequency)) ? (str(o.frequency) as PaySchedule['frequency']) : 'semimonthly';
  return {
    frequency: freq,
    paycheckCap: round2(num(o.paycheckCap)),
    anchorNextPayday: str(o.anchorNextPayday) || today,
    semimonthlyDom1: clampInt(o.semimonthlyDom1 ?? 15, 1, 31),
    semimonthlyDom2: clampInt(o.semimonthlyDom2 ?? 31, 1, 31),
    monthlyDom: clampInt(o.monthlyDom ?? 15, 1, 31),
    customDates: (Array.isArray(o.customDates) ? o.customDates : []).map(String).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
  };
}

function toDebt(x: Obj, idx: number, today: IsoDate): Debt {
  const payments: DebtPayment[] = (Array.isArray(x.payments) ? x.payments : [])
    .filter(isObj)
    .map((p, pi) => ({
      id: str(p.id) || `p${Date.now()}${idx}${pi}`,
      date: str(p.date) || today,
      amount: Math.max(0, round2(num(p.amount))),
      principal: Math.max(0, round2(num(p.principal))),
      interest: Math.max(0, round2(num(p.interest))),
      balanceBefore: Math.max(0, round2(num(p.balanceBefore))),
      balanceAfter: Math.max(0, round2(num(p.balanceAfter))),
      note: str(p.note),
      createdAt: str(p.createdAt),
      interestDays: Number.isFinite(Number(p.interestDays)) ? Number(p.interestDays) : null,
    }))
    .filter((p) => p.amount > 0);
  const balance = Math.max(0, round2(num(x.balance)));
  return {
    id: str(x.id) || `d${Date.now()}${idx}`,
    name: str(x.name) || 'Debt',
    balance,
    originalBalance: Math.max(balance, round2(num(x.originalBalance) || balance)),
    apr: Math.max(0, round2(num(x.apr))),
    minPayment: Math.max(0, round2(num(x.minPayment))),
    extraPayment: Math.max(0, round2(num(x.extraPayment))),
    dueDay: clampInt(x.dueDay || 1, 1, 31),
    priority: clampInt(x.priority || idx + 1, 1, 999),
    interestStartDate: normalizeISODateLoose(x.interestStartDate || '') || '',
    payments,
    autoPay: true,
    // Yesterday, so a payment due today is still applied automatically (unless you logged it in v117).
    autoPaidThrough: isoDate(parseISOToMs(today) - DAY_MS),
  };
}

/** A payment logged in v117 during the current cycle stands in for that cycle's due date, so it isn't applied twice. */
function markCurrentCycle(d: Debt, today: IsoDate): Debt {
  const due = nextDueIsoAfter(isoDate(parseISOToMs(today) - DAY_MS), d.dueDay, today);
  const prev = prevDueIso(due, d.dueDay);
  const inCycle = d.payments.filter((p) => !p.auto && !p.replacesDue && p.date > prev && p.date <= today);
  if (!inCycle.length) return d;
  const main = inCycle.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { ...d, payments: d.payments.map((p) => (p.id === main.id ? { ...p, replacesDue: due } : p)) };
}

function normalizeOrder(saved: unknown, ids: string[]): string[] {
  const list = (Array.isArray(saved) ? saved.map(String) : []).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i);
  for (const id of ids) if (!list.includes(id)) list.push(id);
  return list;
}

export interface ImportReport {
  source: 'v117' | 'backup';
  counts: { bills: number; budgets: number; loans: number; loanPayments: number; spendLogs: number; budgetMoves: number; withdrawals: number; extraIncomes: number };
  paycheck: string;
  balances: { savings: number; savingsMonth: string };
  notes: string[];
}

export interface ImportResult { data: AppData; report: ImportReport }

export function importV117(raw: unknown, today: IsoDate, opts: { fileName?: string; nowIso?: string } = {}): ImportResult {
  if (!looksLikeV117(raw)) throw new Error('This file is not a Bills Account Planner export.');
  const notes: string[] = [];
  const s = migrateV117(raw as Obj, today);
  const ui = (isObj(s.ui) ? s.ui : {}) as Obj;
  const proj = isObj(ui.proj) ? ui.proj : null;
  let rawBills = (Array.isArray(s.bills) ? s.bills : []) as Obj[];
  const settings = s.settings as Obj;
  if (proj && proj.active) {
    if (Array.isArray(proj.origBills)) rawBills = proj.origBills as Obj[];
    if (isObj(proj.origPay)) settings.pay = proj.origPay;
    notes.push('This file was saved while v117 was showing projected numbers, so your saved bills and paycheck were used instead of the temporary ones.');
  }
  const snap = isObj(ui.savingsGoalSnapshot) ? ui.savingsGoalSnapshot : null;
  const savings = isObj(settings.savings) ? settings.savings : {};
  if (snap && snap.active && Number.isFinite(Number(snap.value))) {
    savings.monthlyGoal = Number(snap.value);
    if (!(proj && proj.active)) notes.push('Your saved monthly savings goal was used instead of a temporary projected one.');
  }

  const selectedMonth = isMonthKey(s.selectedMonth) ? (s.selectedMonth as string) : today.slice(0, 7);
  const data = makeDefaultData(today, opts.nowIso);
  const pay = toPay(settings.pay, today);
  data.settings = {
    baseMonth: isMonthKey(settings.baseMonth) ? (settings.baseMonth as string) : selectedMonth,
    baseBillsBalance: round2(num(settings.baseBillsBalance)),
    baseSavingsBalance: round2(num(settings.baseSavingsBalance)),
    trueSavingsMonth: isMonthKey(settings.trueSavingsMonth) ? (settings.trueSavingsMonth as string) : (isMonthKey(settings.baseMonth) ? (settings.baseMonth as string) : selectedMonth),
    cushion: round2(num(settings.cushion)),
    pocket: {
      minimumSurvival: Math.max(0, round2(num((settings.pocket as Obj)?.minimumSurvival))),
      thresholdMode: (settings.pocket as Obj)?.thresholdMode === 'base' ? 'base' : 'net',
    },
    pay,
    pay2: isObj(settings.pay2) ? toPay(settings.pay2, today) : null,
    otherIncomes: (Array.isArray(settings.otherIncomes) ? settings.otherIncomes : []).filter(isObj).map((x, i) => toItem(x, 'Additional income', 'oi', i)),
    transferSplit: normalizeTransferSplit(settings.transferSplit),
    savings: {
      monthlyGoal: round2(num(savings.monthlyGoal)),
      timelineMonths: clampInt(num(savings.timelineMonths, 6) || 6, 1, 36),
    },
  };

  data.bills = rawBills.filter(isObj).map((x, i) => toItem(x, 'Bill', 'b', i));
  data.extras = (Array.isArray(s.extras) ? s.extras : []).filter(isObj).map((x, i) => toItem(x, 'Extra cost', 'x', i));

  // Spending logs, normalized like v117 allExtraSpendEntries.
  data.spendEntries = (Array.isArray(s.extraSpendEntries) ? s.extraSpendEntries : []).filter(isObj).map((x, i): SpendEntry => {
    const extraId = str(x.extraId);
    const extraName = str(x.extraName || x.name || (extraId === MISC_ID ? MISC_NAME : 'Extra cost'));
    const iso = normalizeISODateLoose(x.date || x.iso || x.anchor || '');
    const amt = round2(num(x.amount));
    const refund = str(x.entryType).trim() === 'refund' || amt < 0;
    return {
      id: str(x.id) || `xs${Date.now().toString(36)}${i}`,
      extraId, extraName,
      amount: refund ? -Math.abs(amt) : Math.abs(amt),
      entryType: refund ? 'refund' : 'spend',
      date: iso || `${selectedMonth}-01`,
      note: str(x.note || x.memo),
      createdAt: str(x.createdAt),
    };
  });

  data.spendTransfers = (Array.isArray(s.extraSpendTransfers) ? s.extraSpendTransfers : []).filter(isObj).map((x, i): SpendTransfer => ({
    id: str(x.id) || `xst${Date.now().toString(36)}${i}`,
    fromExtraId: str(x.fromExtraId || x.fromId),
    fromExtraName: str(x.fromExtraName || x.fromName || 'Extra cost'),
    toExtraId: str(x.toExtraId || x.toId),
    toExtraName: str(x.toExtraName || x.toName || 'Extra cost'),
    amount: Math.max(0, round2(num(x.amount))),
    date: normalizeISODateLoose(x.date || x.iso || x.anchor || '') || `${selectedMonth}-01`,
    note: str(x.note || x.memo),
    createdAt: str(x.createdAt),
  }));

  // Savings withdrawals, normalized like v117 allEventsList.
  data.events = (Array.isArray(s.events) ? s.events : []).filter(isObj).map((x, i): SavingsEvent => {
    const iso = normalizeISODateLoose((isObj(x.rule) ? x.rule.anchor : '') || x.date || x.iso || '');
    let rule: Rule;
    if (!isObj(x.rule)) rule = iso ? { type: 'one_time', anchor: iso } : { type: 'one_time' };
    else {
      rule = toRule(x.rule);
      if (rule.anchor) rule.anchor = normalizeISODateLoose(rule.anchor) || rule.anchor;
    }
    const event = str(x.event || x.name || 'Event');
    const item = str(x.item);
    return {
      id: str(x.id) || `${(iso || selectedMonth).slice(0, 7)}-e${Date.now().toString(36)}${i}`,
      event, item, amount: num(x.amount), rule,
      name: `Event: ${event}${item ? ` - ${item}` : ''}`,
    };
  });

  // Loans, normalized like v117 normalizeDebt (+ its one-time v117 interest re-split).
  const allDebts = (Array.isArray(s.debts) ? s.debts : []).filter(isObj).map((x, i) => toDebt(x, i, today));
  // A loan with nothing in it (no balance, no starting balance, no payment, no history) is an unused placeholder.
  const emptyDebts = allDebts.filter((d) => d.balance <= 0 && d.originalBalance <= 0 && d.minPayment <= 0 && d.extraPayment <= 0 && !d.payments.length);
  data.debts = allDebts.filter((d) => !emptyDebts.includes(d));
  if (emptyDebts.length) notes.push(`Skipped ${emptyDebts.length === 1 ? `an empty loan named "${emptyDebts[0].name}"` : `${emptyDebts.length} empty loans`} (no balance, payment or history).`);
  if (Number(ui.debtInterestVersion) !== 117) {
    data.debts = data.debts.map((d) => {
      const needsSplit = d.payments.some((p) => p.amount > 0 && !(p.principal > 0 || p.interest > 0));
      return needsSplit ? recalcFromPayments(d, today) : d;
    });
  }

  data.debts = data.debts.map((d) => markCurrentCycle(d, today));

  data.order = {
    bills: normalizeOrder(ui.billCustomOrder, data.bills.map((b) => b.id)),
    extras: normalizeOrder(ui.extraCustomOrder, data.extras.map((x) => x.id)),
  };

  const theme = str(ui.theme);
  const themePref: ThemePref = theme === 'light' ? 'light' : theme ? 'dark' : 'system';
  const sort = str(ui.billsSortMode) as BillsSort;
  const strategy = str(ui.debtStrategy) as DebtStrategy;
  data.prefs = {
    ...DEFAULT_PREFS,
    paydayChecks: {},
    graphHiddenIds: [],
    theme: themePref,
    billsSort: (['custom', 'alpha', 'date', 'amountAsc', 'amountDesc'] as BillsSort[]).includes(sort) ? sort : 'custom',
    debtStrategy: (['avalanche', 'snowball', 'custom'] as DebtStrategy[]).includes(strategy) ? strategy : 'avalanche',
    spendingScope: ui.extraSpendSummaryMode === 'month' ? 'month' : 'period',
    lastSpendCategory: str(ui.extraSpendDraftExtraId),
  };
  const nowIso = opts.nowIso || new Date().toISOString();
  data.meta = { createdAt: nowIso, updatedAt: nowIso, importedFrom: { app: 'v117', at: nowIso, fileName: opts.fileName } };

  const extraIds = new Set(data.extras.map((x) => x.id));
  const orphanLogs = data.spendEntries.filter((e) => e.extraId && e.extraId !== MISC_ID && !extraIds.has(e.extraId));
  if (orphanLogs.length) notes.push(`${orphanLogs.length} spending log${orphanLogs.length === 1 ? '' : 's'} belong to budgets you deleted in v117. They're kept so your history and totals still match.`);
  const badDates = (Array.isArray(s.extraSpendEntries) ? s.extraSpendEntries : []).filter((x) => isObj(x) && !isValidIso(normalizeISODateLoose(x.date || x.iso || x.anchor || ''))).length;
  if (badDates) notes.push(`${badDates} spending log${badDates === 1 ? ' had' : 's had'} no valid date; v117 treats those as the 1st of the month you were viewing, and so does this import.`);
  if (data.debts.length) notes.push('Loan balances are taken as of today. From the next due date on, each scheduled payment is applied automatically unless you log a different one.');

  const report: ImportReport = {
    source: 'v117',
    counts: {
      bills: data.bills.length,
      budgets: data.extras.length,
      loans: data.debts.length,
      loanPayments: data.debts.reduce((n, d) => n + d.payments.length, 0),
      spendLogs: data.spendEntries.length,
      budgetMoves: data.spendTransfers.length,
      withdrawals: data.events.length,
      extraIncomes: data.settings.otherIncomes.length,
    },
    paycheck: describePay(data.settings.pay),
    balances: { savings: data.settings.baseSavingsBalance, savingsMonth: data.settings.trueSavingsMonth },
    notes,
  };
  return { data, report };
}

export function describePay(p: PaySchedule): string {
  const amt = `$${round2(p.paycheckCap).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const ord = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  switch (p.frequency) {
    case 'weekly': return `${amt} every week`;
    case 'biweekly': return `${amt} every other week`;
    case 'semimonthly': return `${amt} on the ${ord(p.semimonthlyDom1)} and ${p.semimonthlyDom2 >= 31 ? 'last day' : ord(p.semimonthlyDom2)}`;
    case 'monthly': return `${amt} monthly on the ${ord(p.monthlyDom)}`;
    case 'custom': return `${amt} on ${p.customDates.length} set date${p.customDates.length === 1 ? '' : 's'}`;
  }
}
