/**
 * View models: what each screen shows, computed from the engine. Pure functions, so they can be tested.
 */
import {
  addDaysMs, addMonthsKey, fmtDow, fmtMonthLong, fmtRange, fmtShort, isoDate, monthEndMs, monthLong, monthStartMs,
  parseISOToMs, parseMonthKey, toDateObj, type IsoDate, type MonthKey,
} from '../engine/dates';
import { fmtMoney, round2 } from '../engine/money';
import { debtSummary, payoffCalc, payoffMonth, type DebtSummary } from '../engine/loans';
import type { MonthPlan, PlanEngine, PlanRow } from '../engine/plan';
import { capForPayIndex, pocketBase, pocketMinimumInfo, savingsForPayIndex, type MinimumInfo } from '../engine/pocket';
import { nextPeriod, periodForDate, snapshotForRange, type Period, type Snapshot } from '../engine/spending';
import { getPaydaysForPay } from '../engine/schedule';

export interface PaydayInfo {
  ms: number;
  planMonth: MonthKey;
  payIndex: number;
  paycheck: number;
  sources: Array<{ label: string; amount: number }>;
  billsMove: number;
  savingsMove: number;
  spending: number;
  /** Budgets scheduled in this pay period. */
  planned: number;
  free: number;
  periodEnd: number;
  minimum: MinimumInfo | null;
}

/** The plan facts for the payday that starts at `ms` (null if `ms` isn't a payday). */
export function paydayInfo(engine: PlanEngine, ms: number): PaydayInfo | null {
  const mk = isoDate(ms).slice(0, 7);
  const plan = engine.plan(mk);
  const sorted = plan.paydays.slice().sort((a, b) => a - b);
  const i = sorted.indexOf(ms);
  if (i < 0) return null;
  const s = engine.settings;
  const spending = pocketBase(plan, i, s);
  const planned = round2(Number(plan.pocketSpentByPayIndex[i] || 0));
  const next = i < sorted.length - 1 ? sorted[i + 1] : plan.nextPaydayAfterLast;
  const sources: PaydayInfo['sources'] = [];
  const p1 = plan.pay1Caps[i] || 0, p2 = plan.pay2Caps[i] || 0, other = plan.otherIncomeAlloc[i] || 0;
  if (p1) sources.push({ label: s.pay2 ? 'Paycheck 1' : 'Paycheck', amount: p1 });
  if (p2) sources.push({ label: 'Paycheck 2', amount: p2 });
  if (other) sources.push({ label: 'Extra income', amount: round2(other) });
  return {
    ms, planMonth: mk, payIndex: i, paycheck: round2(capForPayIndex(plan, i, s)), sources,
    billsMove: plan.billsPerPaycheck, savingsMove: savingsForPayIndex(plan, i), spending, planned,
    free: round2(spending - planned), periodEnd: next ? addDaysMs(next, -1) : plan.monthEnd,
    minimum: pocketMinimumInfo(plan, i, s),
  };
}

export function rowAt(engine: PlanEngine, ms: number): PlanRow | null {
  return engine.plan(isoDate(ms).slice(0, 7)).rows.find((r) => r.ms === ms) ?? null;
}

/** Working balance at the very start of a day (before that day's transfer and bills). */
export function balanceBeforeDay(engine: PlanEngine, ms: number): { bills: number; savings: number } {
  const mk = isoDate(ms).slice(0, 7);
  const plan = engine.plan(mk);
  if (ms === plan.monthStart) return { bills: plan.seedWanted, savings: plan.startSavings };
  const prev = rowAt(engine, addDaysMs(ms, -1));
  return { bills: prev?.billsBalanceWorking ?? plan.seedWanted, savings: prev?.savingsBalance ?? plan.startSavings };
}

/**
 * Each month's plan starts from what that month needs. When the previous month leaves more than that,
 * the difference is extra you can move out; when it leaves less, it has to be added.
 */
export function monthStartAdjustment(engine: PlanEngine, mk: MonthKey): number {
  const plan = engine.plan(mk);
  const prev = rowAt(engine, addDaysMs(plan.monthStart, -1));
  if (!prev) return 0;
  return round2(plan.seedWanted - prev.billsBalanceWorking);
}

export function nextPaydayOnOrAfter(engine: PlanEngine, ms: number): number | null {
  let mk = isoDate(ms).slice(0, 7);
  for (let g = 0; g < 24; g++) {
    const p = engine.plan(mk).paydays.slice().sort((a, b) => a - b).find((x) => x >= ms);
    if (p != null) return p;
    mk = addMonthsKey(mk, 1);
  }
  return null;
}

export interface Lowest { amount: number; ms: number }
export function lowestBetween(engine: PlanEngine, fromMs: number, toMs: number): Lowest | null {
  let best: Lowest | null = null;
  for (let ms = fromMs; ms <= toMs; ms = addDaysMs(ms, 1)) {
    const r = rowAt(engine, ms);
    if (r && (!best || r.billsBalanceWorking < best.amount - 0.0001)) best = { amount: r.billsBalanceWorking, ms };
  }
  return best;
}

export interface Entry {
  key: string;
  ms: number;
  /** adjust: the plan's start-of-month reset (extra left over you can move out, or money to add). */
  kind: 'payday' | 'bill' | 'withdrawal' | 'adjust';
  title: string;
  detail?: string;
  /** Effect on the Bills account (payday: +transfer, bill: −amount) or Savings (withdrawal: −amount). */
  amount: number;
  savingsMove?: number;
  billsAfter: number;
  savingsAfter: number;
  itemId?: string;
  debtId?: string;
}

/** Every money movement on a day, with running balances after each one. */
export function entriesForDay(engine: PlanEngine, ms: number): Entry[] {
  const r = rowAt(engine, ms);
  if (!r) return [];
  const start = balanceBeforeDay(engine, ms);
  let bills = start.bills, savings = start.savings;
  const out: Entry[] = [];
  const mk = isoDate(ms).slice(0, 7);
  if (ms === monthStartMs(mk)) {
    const delta = monthStartAdjustment(engine, mk);
    // Sub-dollar differences are rounding; the plan simply starts from what the month needs.
    if (Math.abs(delta) >= 1) {
      const prevName = monthLong(parseMonthKey(addMonthsKey(mk, -1)).m);
      out.push({
        key: `adj-${ms}`, ms, kind: 'adjust',
        title: delta < 0 ? 'Extra you can move out' : 'Add to the Bills account',
        detail: delta < 0 ? `Left over from ${prevName}` : `${monthLong(parseMonthKey(mk).m)} needs more than ${prevName} leaves`,
        amount: delta, billsAfter: start.bills, savingsAfter: savings,
      });
    }
  }
  if (r.isPayday) {
    bills = round2(bills + r.transferIn);
    savings = round2(savings + r.savingsIn);
    out.push({ key: `pay-${ms}`, ms, kind: 'payday', title: 'Payday', amount: r.transferIn, savingsMove: r.savingsIn, billsAfter: bills, savingsAfter: savings });
  }
  r.bills.forEach((b, i) => {
    bills = round2(bills - Number(b.amount || 0));
    out.push({ key: `bill-${ms}-${b.id}-${i}`, ms, kind: 'bill', title: b.name, amount: -Number(b.amount || 0), billsAfter: bills, savingsAfter: savings, itemId: b.id, debtId: b.debtId });
  });
  r.events.forEach((e, i) => {
    savings = round2(savings - Number(e.amount || 0));
    const ev = engine.data.events.find((x) => x.id === e.id);
    out.push({ key: `wd-${ms}-${e.id}-${i}`, ms, kind: 'withdrawal', title: ev ? (ev.item ? `${ev.event}: ${ev.item}` : ev.event) : e.name, amount: -Number(e.amount || 0), billsAfter: bills, savingsAfter: savings, itemId: e.id });
  });
  return out;
}

export interface CurrentPeriod {
  period: Period;
  snapshot: Snapshot;
  daysLeft: number;
  perDay: number;
  startPayday: PaydayInfo | null;
}

export function currentPeriod(engine: PlanEngine, today: IsoDate): CurrentPeriod {
  const period = periodForDate(engine, today);
  const snapshot = snapshotForRange(engine, period.startMs, period.endMs);
  const todayMs = parseISOToMs(today);
  const daysLeft = Math.max(1, Math.round((period.endMs - todayMs) / 86400000) + 1);
  const left = snapshot.totals.remaining;
  return {
    period, snapshot, daysLeft, perDay: left > 0 ? round2(left / daysLeft) : 0,
    startPayday: period.startsOnPayday ? paydayInfo(engine, period.startMs) : null,
  };
}

export type AlertTone = 'warn' | 'bad' | 'info';
export interface Alert { id: string; tone: AlertTone; text: string; action?: { label: string; to: string } }

export interface HomeModel {
  todayMs: number;
  billsNow: number;
  billsBeforeTodaysBills: number | null;
  todaysBills: Entry[];
  isPaydayToday: boolean;
  savingsNow: number;
  lowest: Lowest | null;
  current: CurrentPeriod;
  nextPayday: PaydayInfo | null;
  daysToPayday: number | null;
  comingUp: Entry[];
  alerts: Alert[];
  savingsEndOfMonth: number;
  loans: DebtSummary & { nextPayoff: { name: string; month: MonthKey } | null };
}

export function homeModel(engine: PlanEngine): HomeModel {
  const today = engine.today();
  const todayMs = parseISOToMs(today);
  const row = rowAt(engine, todayMs)!;
  const todayEntries = entriesForDay(engine, todayMs);
  const todaysBills = todayEntries.filter((e) => e.kind === 'bill');
  const current = currentPeriod(engine, today);
  const nextPayMs = nextPaydayOnOrAfter(engine, addDaysMs(todayMs, 1));
  const nextPayday = nextPayMs != null ? paydayInfo(engine, nextPayMs) : null;
  const lowest = lowestBetween(engine, todayMs, current.period.endMs);

  const comingUp: Entry[] = [];
  for (let ms = addDaysMs(todayMs, 1); ms <= addDaysMs(todayMs, 21) && comingUp.length < 6; ms = addDaysMs(ms, 1)) {
    for (const e of entriesForDay(engine, ms)) if (comingUp.length < 6) comingUp.push(e);
  }

  const plan = engine.plan(today.slice(0, 7));
  const loans = debtSummary(engine.data.debts, today);
  let nextPayoff: HomeModel['loans']['nextPayoff'] = null;
  for (const d of engine.data.debts) {
    const m = payoffMonth(d, today);
    if (m && (!nextPayoff || m < nextPayoff.month)) nextPayoff = { name: d.name, month: m };
  }

  return {
    todayMs, billsNow: row.billsBalanceWorking,
    billsBeforeTodaysBills: row.billsOut > 0 ? round2(row.billsBalanceWorking + row.billsOut) : null,
    todaysBills, isPaydayToday: row.isPayday, savingsNow: row.savingsBalance, lowest, current, nextPayday,
    daysToPayday: nextPayMs != null ? Math.round((nextPayMs - todayMs) / 86400000) : null,
    comingUp, alerts: alertsFor(engine), savingsEndOfMonth: plan.endSavings,
    loans: { ...loans, nextPayoff },
  };
}

const monthName = (mk: MonthKey) => monthLong(parseMonthKey(mk).m);

export function alertsFor(engine: PlanEngine): Alert[] {
  const today = engine.today();
  const todayMs = parseISOToMs(today);
  const out: Alert[] = [];
  const s = engine.settings;
  // Pay periods from now: under the minimum, or no spending money at all (one alert each kind).
  let p = periodForDate(engine, today);
  const short: Array<{ range: string; start: IsoDate; m: MinimumInfo }> = [];
  for (let i = 0; i < 3; i++) {
    const info = p.startsOnPayday ? paydayInfo(engine, p.startMs) : null;
    if (info) {
      const range = fmtRange(p.startMs, p.endMs);
      if (info.spending <= 0.004) {
        out.push({ id: `nospend-${p.startIso}`, tone: 'bad', text: `${range}: the Bills and Savings moves take the whole ${fmtMoney(info.paycheck)} paycheck, leaving nothing to spend.`, action: { label: 'See why', to: '/timeline' } });
      } else if (info.minimum) short.push({ range, start: p.startIso, m: info.minimum });
    }
    p = nextPeriod(engine, p);
  }
  if (short.length) {
    const f = short[0].m;
    const what = f.mode === 'base' ? `spending money is ${fmtMoney(f.base)}` : `budgets leave ${fmtMoney(f.net)} free`;
    const rest = short.length > 1
      ? (short.every((x) => Math.abs(x.m.metricValue - f.metricValue) < 0.005) ? ` The same goes for the next ${short.length - 1 === 1 ? 'pay period' : `${short.length - 1} pay periods`}.` : ` ${short.length - 1} more pay period${short.length - 1 === 1 ? ' is' : 's are'} short too.`)
      : '';
    out.push({ id: `min-${short[0].start}`, tone: 'warn', text: `${short[0].range}: ${what}, ${fmtMoney(f.shortBy)} under your ${fmtMoney(f.minimum)} minimum.${rest}`, action: { label: 'Safety net', to: '/plan/safety' } });
  }
  // Months where paychecks can't cover the bills on their own.
  for (let i = 0; i < 3; i++) {
    const mk = addMonthsKey(today.slice(0, 7), i);
    const plan = engine.plan(mk);
    if (plan.extraFunding > 0.009) {
      out.push({
        id: `fund-${mk}`, tone: 'bad',
        text: `${monthName(mk)} needs ${fmtMoney(plan.extraFunding)} more in the Bills account at the start of the month than your paychecks can move in time. Add it by ${fmtShort(plan.monthStart)}.`,
        action: { label: 'Why?', to: `/timeline/${mk}` },
      });
    }
  }
  for (const d of engine.data.debts) {
    if (d.balance > 0 && payoffCalc(d, today).stuck) {
      out.push({ id: `stuck-${d.id}`, tone: 'warn', text: `The ${d.name} payment doesn't cover its interest, so the balance won't go down.`, action: { label: 'Open loan', to: `/plan/loans/${d.id}` } });
    }
  }
  const data = engine.data;
  const hasData = data.bills.length || data.debts.length || data.spendEntries.length;
  const last = data.meta.lastBackupAt ? Date.parse(data.meta.lastBackupAt) : NaN;
  if (hasData && (!Number.isFinite(last) || todayMs - last > 14 * 86400000)) {
    out.push({ id: 'backup', tone: 'info', text: Number.isFinite(last) ? 'It has been more than two weeks since your last backup.' : "You haven't made a backup yet. It takes a few seconds.", action: { label: 'Back up', to: '/plan/backup' } });
  }
  if (!(s.pay.paycheckCap > 0)) out.push({ id: 'nopay', tone: 'info', text: 'Add your paycheck so the app can plan your transfers.', action: { label: 'Add paycheck', to: '/plan/income' } });
  return out;
}

export interface DayGroup { ms: number; isToday: boolean; isPast: boolean; entries: Entry[]; billsEnd: number; savingsEnd: number }
export interface TimelineGroup {
  key: string;
  title: string;
  startMs: number;
  endMs: number;
  isCurrent: boolean;
  payday: PaydayInfo | null;
  lowest: Lowest | null;
  days: DayGroup[];
}

/** Pay periods that overlap a month (or the month itself), with each day's movements. */
export function timelineModel(engine: PlanEngine, mk: MonthKey, group: 'period' | 'month', density: 'activity' | 'all'): TimelineGroup[] {
  const todayMs = parseISOToMs(engine.today());
  const ranges: Array<{ start: number; end: number; period: Period | null }> = [];
  const mStart = monthStartMs(mk), mEnd = monthEndMs(mk);
  if (group === 'month') ranges.push({ start: mStart, end: mEnd, period: null });
  else {
    let p = periodForDate(engine, isoDate(mStart));
    for (let g = 0; g < 12 && p.startMs <= mEnd; g++) {
      ranges.push({ start: p.startMs, end: p.endMs, period: p });
      p = nextPeriod(engine, p);
    }
  }
  return ranges.map(({ start, end, period }) => {
    const days: DayGroup[] = [];
    for (let ms = start; ms <= end; ms = addDaysMs(ms, 1)) {
      const entries = entriesForDay(engine, ms);
      const r = rowAt(engine, ms);
      if (!r) continue;
      if (density === 'activity' && !entries.length && ms !== todayMs) continue;
      days.push({ ms, isToday: ms === todayMs, isPast: ms < todayMs, entries, billsEnd: r.billsBalanceWorking, savingsEnd: r.savingsBalance });
    }
    const payday = period?.startsOnPayday ? paydayInfo(engine, period.startMs) : null;
    return {
      key: `${isoDate(start)}_${isoDate(end)}`,
      title: group === 'month' ? fmtMonthLong(mk) : fmtRange(start, end),
      startMs: start, endMs: end, isCurrent: todayMs >= start && todayMs <= end,
      payday, lowest: lowestBetween(engine, start, end), days,
    };
  });
}

export interface MonthDetails {
  plan: MonthPlan;
  billsTotal: number;
  budgetsTotal: number;
  paychecksTotal: number;
  spendingMoneyTotal: number;
  freeTotal: number;
  startBalance: number;
  endBalance: number;
}

export function monthDetails(engine: PlanEngine, mk: MonthKey): MonthDetails {
  const plan = engine.plan(mk);
  const s = engine.settings;
  const billsTotal = round2(plan.rows.reduce((t, r) => t + r.billsOut, 0));
  const budgetsTotal = round2(plan.rows.reduce((t, r) => t + r.pocketOut, 0));
  const paychecksTotal = round2(plan.paydays.reduce((t, _, i) => t + capForPayIndex(plan, i, s), 0));
  const spendingMoneyTotal = round2(plan.paydays.reduce((t, _, i) => t + pocketBase(plan, i, s), 0));
  const planned = round2(plan.pocketSpentByPayIndex.reduce((t, x) => t + x, 0));
  const last = plan.rows[plan.rows.length - 1];
  return {
    plan, billsTotal, budgetsTotal, paychecksTotal, spendingMoneyTotal, freeTotal: round2(spendingMoneyTotal - planned),
    startBalance: plan.seedWanted, endBalance: last ? last.billsBalanceWorking : plan.seedWanted,
  };
}

/** Upcoming paydays for a pay schedule (used by the Income editor preview). */
export function upcomingPaydays(pay: Parameters<typeof getPaydaysForPay>[1], fromIso: IsoDate, count = 6): number[] {
  const out: number[] = [];
  let mk = fromIso.slice(0, 7);
  const from = parseISOToMs(fromIso);
  for (let g = 0; g < 24 && out.length < count; g++) {
    for (const p of getPaydaysForPay(mk, pay)) if (p >= from && out.length < count) out.push(p);
    mk = addMonthsKey(mk, 1);
  }
  return out;
}

export const dayLabel = (ms: number) => fmtDow(ms);
export const dowShort = (ms: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][toDateObj(ms).dow];
export const domOf = (ms: number) => toDateObj(ms).d;
