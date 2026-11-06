/**
 * Loans. The math functions are exact ports of v117 (debtPayoffCalc, debtPaymentSplit,
 * recalcDebtFromPayments, ordering, summary). New: automatic payments on due dates and a
 * plan schedule that stops at payoff (Fixes.loanPayoffStop).
 */
import {
  addMonthsKey, DAY_MS, daysInMonth, isoDate, monthIndex, msUTC, normalizeISODateLoose, parseISOToMs,
  type IsoDate, type MonthKey,
} from './dates';
import { clampInt, round2 } from './money';
import type { Debt, DebtPayment, DebtStrategy, Fixes, RecurringItem } from './types';

export function dailyInterestDays(fromIso: string, toIso: string): number | null {
  const from = normalizeISODateLoose(fromIso);
  const to = normalizeISODateLoose(toIso);
  if (!from || !to) return null;
  const a = parseISOToMs(from), b = parseISOToMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/** The first due date strictly after `fromIso`. */
export function nextDueIsoAfter(fromIso: string, dueDay: number, today: IsoDate): IsoDate {
  const from = normalizeISODateLoose(fromIso) || today;
  const fromMs = parseISOToMs(from);
  if (!Number.isFinite(fromMs)) return today;
  const dt = new Date(fromMs);
  let y = dt.getUTCFullYear();
  let m = dt.getUTCMonth() + 1;
  const dom = clampInt(dueDay || 1, 1, 31);
  let candidate = msUTC(y, m, Math.min(dom, daysInMonth(y, m)));
  if (candidate <= fromMs) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    candidate = msUTC(y, m, Math.min(dom, daysInMonth(y, m)));
  }
  return isoDate(candidate);
}

/** The due date one cycle before `dueIso`. */
export function prevDueIso(dueIso: IsoDate, dueDay: number): IsoDate {
  const mk = addMonthsKey(dueIso.slice(0, 7), -1);
  const [y, m] = mk.split('-').map(Number);
  return isoDate(msUTC(y, m, Math.min(clampInt(dueDay || 1, 1, 31), daysInMonth(y, m))));
}

export function paymentSortAsc(a: DebtPayment, b: DebtPayment): number {
  const ad = String(a?.date || ''), bd = String(b?.date || '');
  if (ad !== bd) return ad.localeCompare(bd);
  const ac = String(a?.createdAt || ''), bc = String(b?.createdAt || '');
  if (ac !== bc) return ac.localeCompare(bc);
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function lastPaymentDate(d: Pick<Debt, 'payments'>): IsoDate | '' {
  const list = (Array.isArray(d?.payments) ? d.payments : []).filter((p) => Number(p?.amount || 0) > 0);
  if (!list.length) return '';
  return String([...list].sort(paymentSortAsc).slice(-1)[0]?.date || '');
}

export interface PayoffCalc { months: number; interest: number; payment: number; stuck: boolean; daily?: boolean }

/** Exact v117 payoff projection: month by month, interest then payment, up to 600 months. */
export function payoffCalc(d: Debt, today: IsoDate): PayoffCalc {
  const balance0 = Math.max(0, Number(d?.balance || 0));
  const apr = Math.max(0, Number(d?.apr || 0));
  const payment = Math.max(0, Number(d?.minPayment || 0) + Number(d?.extraPayment || 0));
  if (balance0 <= 0) return { months: 0, interest: 0, payment, stuck: false };
  if (payment <= 0) return { months: Infinity, interest: 0, payment, stuck: true };
  const startIso = normalizeISODateLoose(d?.interestStartDate || '');
  if (startIso) {
    let bal = balance0, interest = 0, months = 0;
    let fromIso = normalizeISODateLoose(lastPaymentDate(d) || startIso) || today;
    for (let i = 0; i < 600 && bal > 0.009; i++) {
      const dueIso = nextDueIsoAfter(fromIso, d?.dueDay || 1, today);
      const days = dailyInterestDays(fromIso, dueIso);
      const int = round2(bal * (apr / 100) / 365 * (Number.isFinite(days) ? (days as number) : 30));
      if (payment <= int && bal > payment) return { months: Infinity, interest: round2(interest + int), payment, stuck: true, daily: true };
      interest = round2(interest + int);
      bal = round2(Math.max(0, bal + int - payment));
      months++;
      fromIso = dueIso;
    }
    return { months: bal > 0.009 ? Infinity : months, interest, payment, stuck: bal > 0.009, daily: true };
  }
  const r = apr / 100 / 12;
  let bal = balance0, interest = 0, months = 0;
  for (let i = 0; i < 600 && bal > 0.009; i++) {
    const int = round2(bal * r);
    if (payment <= int && bal > payment) return { months: Infinity, interest: round2(interest + int), payment, stuck: true, daily: false };
    interest = round2(interest + int);
    bal = round2(Math.max(0, bal + int - payment));
    months++;
  }
  return { months: bal > 0.009 ? Infinity : months, interest, payment, stuck: bal > 0.009, daily: false };
}

export interface ScheduledPayment { dueIso: IsoDate; amount: number; interest: number; principal: number; balanceAfter: number }
export interface PayoffSchedule extends PayoffCalc { payments: ScheduledPayment[]; finalDueIso: IsoDate | '' }

/** The latest due date already taken care of: an automatic payment, or one you logged in its place. */
export function coveredThrough(d: Pick<Debt, 'payments'>): IsoDate | '' {
  let max = '';
  for (const p of d.payments || []) {
    const c = p.auto ? p.date : p.replacesDue || '';
    if (c && c > max) max = c;
  }
  return max;
}

/** Due date that falls in a month (short months use their last day). */
export function dueIsoInMonth(mk: MonthKey, dueDay: number): IsoDate {
  const [y, m] = mk.split('-').map(Number);
  return isoDate(msUTC(y, m, Math.min(clampInt(dueDay || 1, 1, 31), daysInMonth(y, m))));
}

/** First due date that still needs paying: after the last payment or covered due date, and never before today. */
export function nextUnpaidDue(d: Debt, today: IsoDate): IsoDate {
  // Extra payments never finish a cycle; a balance you typed in counts as up to date that day.
  let done: string = normalizeISODateLoose(d.balanceAsOf || '') || '';
  for (const p of d.payments || []) {
    const c = p.auto ? p.date : p.replacesDue ? p.replacesDue : p.extra ? '' : p.date;
    if (c > done) done = c;
  }
  if (done && done >= today) return nextDueIsoAfter(done, d.dueDay || 1, today);
  return nextDueIsoAfter(isoDate(parseISOToMs(today) - DAY_MS), d.dueDay || 1, today);
}

/**
 * Every remaining payment with its due date and split, starting at the next unpaid due date.
 * Same math as payoffCalc; daily interest counts from the last payment you made.
 */
export function payoffSchedule(d: Debt, today: IsoDate): PayoffSchedule {
  const base = payoffCalc(d, today);
  const out: PayoffSchedule = { ...base, payments: [], finalDueIso: '' };
  const payment = base.payment;
  let bal = Math.max(0, round2(Number(d.balance || 0)));
  if (bal <= 0 || payment <= 0) return out;
  const apr = Math.max(0, Number(d.apr || 0));
  const daily = !!normalizeISODateLoose(d.interestStartDate || '');
  let interestFrom = daily ? (normalizeISODateLoose(lastPaymentDate(d) || d.interestStartDate) || today) : '';
  let dueIso = nextUnpaidDue(d, today);
  let interest = 0;
  for (let i = 0; i < 600 && bal > 0.009; i++) {
    const days = daily ? dailyInterestDays(interestFrom, dueIso) ?? 30 : 30;
    const int = daily ? round2(bal * (apr / 100) / 365 * days) : round2(bal * (apr / 100 / 12));
    // A long gap since the last payment can make one payment interest-heavy; that alone isn't "stuck".
    if (payment <= int && bal > payment && (i > 0 || days <= 31)) return { ...out, months: Infinity, interest: round2(interest + int), stuck: true, payments: [] };
    // Same split as paymentSplit, which records the real payment: interest first, principal never negative.
    const pay = round2(Math.min(payment, bal + int));
    const interestPart = round2(Math.min(int, pay));
    const principal = round2(Math.max(0, Math.min(bal, pay - interestPart)));
    interest = round2(interest + interestPart);
    bal = round2(Math.max(0, bal - principal));
    out.payments.push({ dueIso, amount: pay, interest: interestPart, principal, balanceAfter: bal });
    interestFrom = dueIso;
    dueIso = nextDueIsoAfter(dueIso, d.dueDay || 1, today);
  }
  if (bal > 0.009) return { ...out, months: Infinity, interest, stuck: true, payments: [] };
  out.months = out.payments.length;
  out.interest = interest;
  out.stuck = false;
  out.finalDueIso = out.payments.length ? out.payments[out.payments.length - 1].dueIso : '';
  return out;
}

export interface PaymentSplit { amount: number; interest: number; principal: number; balanceBefore: number; balanceAfter: number; interestDays?: number | null }

/** Exact v117 split: interest first (monthly, or daily when an interest start date is set), the rest to principal. */
export function paymentSplit(d: Debt, amount: number, balanceOverride: number | undefined, paymentDate: IsoDate | undefined, interestFromDate: string | undefined, today: IsoDate): PaymentSplit {
  const balance = Math.max(0, round2(Number.isFinite(Number(balanceOverride)) ? Number(balanceOverride) : Number(d?.balance || 0)));
  const apr = Math.max(0, Number(d?.apr || 0));
  const requested = Math.max(0, round2(Number(amount || 0)));
  if (balance <= 0 || requested <= 0) return { amount: 0, interest: 0, principal: 0, balanceBefore: balance, balanceAfter: balance };
  const dailyMode = !!normalizeISODateLoose(d?.interestStartDate || '');
  const days = dailyMode ? dailyInterestDays(interestFromDate || d?.interestStartDate || '', paymentDate || today) : null;
  const interestDue = dailyMode && Number.isFinite(days)
    ? round2(balance * (apr / 100) / 365 * (days as number))
    : round2(balance * (apr / 100 / 12));
  const paid = round2(Math.min(requested, round2(balance + interestDue)));
  const interest = round2(Math.min(interestDue, paid));
  const principal = round2(Math.min(balance, Math.max(0, paid - interest)));
  const balanceAfter = round2(Math.max(0, balance - principal));
  return { amount: paid, interest, principal, balanceBefore: balance, balanceAfter, interestDays: dailyMode ? (Number.isFinite(days) ? (days as number) : 0) : null };
}

export function paymentPrincipal(p: DebtPayment): number {
  if (!p) return 0;
  const principal = Number(p.principal || 0);
  if (principal > 0) return round2(principal);
  const amount = Number(p.amount || 0), interest = Number(p.interest || 0);
  if (interest > 0) return round2(Math.max(0, amount - interest));
  return round2(Math.max(0, amount));
}

export function paymentInterest(p: DebtPayment): number {
  if (!p) return 0;
  const interest = Number(p.interest || 0);
  if (interest > 0) return round2(interest);
  const amount = Number(p.amount || 0), principal = Number(p.principal || 0);
  if (principal > 0) return round2(Math.max(0, amount - principal));
  return 0;
}

/** v117 recalcDebtFromPayments: replays every payment from a starting balance (used only by the v117 import upgrade). */
export function recalcFromPayments(d: Debt, today: IsoDate, startBalance?: number): Debt {
  const payments = (Array.isArray(d.payments) ? d.payments : []).map((p) => ({ ...p }));
  const fallbackStart = round2(Math.max(Number(d.originalBalance || 0), Number(d.balance || 0) + payments.reduce((s, p) => s + Math.max(paymentPrincipal(p), Number(p?.amount || 0)), 0), Number(d.balance || 0)));
  let bal = Math.max(0, round2(Number.isFinite(Number(startBalance)) ? Number(startBalance) : fallbackStart));
  const originalBalance = Math.max(Number(d.originalBalance || 0), bal);
  let interestFrom = normalizeISODateLoose(d.interestStartDate || '') || '';
  const sorted = [...payments].sort(paymentSortAsc);
  for (const p of sorted) {
    const payDate = normalizeISODateLoose(p.date || '') || today;
    const split = paymentSplit(d, Number(p.amount || 0), bal, payDate, interestFrom, today);
    p.date = payDate;
    p.amount = split.amount;
    p.interest = split.interest;
    p.principal = split.principal;
    p.balanceBefore = split.balanceBefore;
    p.balanceAfter = split.balanceAfter;
    if (Number.isFinite(split.interestDays as number)) p.interestDays = split.interestDays;
    bal = split.balanceAfter;
    if (interestFrom) interestFrom = payDate;
  }
  return { ...d, payments, originalBalance, balance: round2(bal) };
}

export function monthsLabel(months: number): string {
  if (!Number.isFinite(months)) return 'Payment too low';
  if (months <= 0) return 'Paid off';
  const y = Math.floor(months / 12), m = months % 12;
  return `${y && m ? `${y}y ${m}m` : y ? `${y}y` : `${m}m`} left`;
}

export function paidSoFar(d: Debt): number {
  const original = Math.max(Number(d?.originalBalance || 0), Number(d?.balance || 0), 0);
  return Math.max(0, round2(original - Number(d?.balance || 0)));
}

export function interestPaidSoFar(d: Debt): number {
  return round2((d.payments || []).reduce((s, p) => s + paymentInterest(p), 0));
}

export function percentPaid(d: Debt): number {
  const orig = Math.max(Number(d.originalBalance || 0), Number(d.balance || 0), 0);
  if (orig <= 0) return 0;
  return Math.max(0, Math.min(100, (paidSoFar(d) / orig) * 100));
}

/** Order for the payoff route (v117: avalanche = APR high→low; snowball = balance low→high; custom = priority). */
export function orderDebts(debts: Debt[], strategy: DebtStrategy): Debt[] {
  return [...debts].sort((a, b) => {
    if (strategy === 'snowball') {
      const av = Number(a.balance || 0), bv = Number(b.balance || 0);
      if (av !== bv) return av - bv;
      return Number(b.apr || 0) - Number(a.apr || 0);
    }
    if (strategy === 'custom') {
      const ap = Number(a.priority || 999), bp = Number(b.priority || 999);
      if (ap !== bp) return ap - bp;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
    }
    const ar = Number(a.apr || 0), br = Number(b.apr || 0);
    if (ar !== br) return br - ar;
    return Number(a.balance || 0) - Number(b.balance || 0);
  });
}

export interface DebtSummary {
  totalBalance: number; paidSoFar: number; monthlyMin: number; monthlyExtra: number; monthlyTotal: number;
  longestMonths: number; interestLeft: number; activeCount: number;
}

export function debtSummary(debts: Debt[], today: IsoDate): DebtSummary {
  const all = debts.filter((d) => Number(d.originalBalance || 0) > 0 || Number(d.balance || 0) > 0);
  const active = debts.filter((d) => Number(d.balance || 0) > 0);
  const calcs = active.map((d) => payoffCalc(d, today));
  const monthlyMin = round2(active.reduce((s, d) => s + Number(d.minPayment || 0), 0));
  const monthlyExtra = round2(active.reduce((s, d) => s + Number(d.extraPayment || 0), 0));
  return {
    totalBalance: round2(active.reduce((s, d) => s + Number(d.balance || 0), 0)),
    paidSoFar: round2(all.reduce((s, d) => s + paidSoFar(d), 0)),
    monthlyMin,
    monthlyExtra,
    monthlyTotal: round2(monthlyMin + monthlyExtra),
    longestMonths: calcs.reduce((max, c) => Math.max(max, Number.isFinite(c.months) ? c.months : Infinity), 0),
    interestLeft: round2(calcs.reduce((s, c) => s + (Number.isFinite(c.interest) ? c.interest : 0), 0)),
    activeCount: active.length,
  };
}

export function scheduledAmount(d: Debt): number {
  return round2(Math.max(0, Number(d?.minPayment || 0) + Number(d?.extraPayment || 0)));
}

/**
 * Loan payments as monthly bills on the due day, paid from the Bills account.
 * v117 (no fix): every month while the balance is above zero.
 * Fixed: this month and earlier show the payment that was actually made for that due date (automatic, or one
 * you logged in its place); later months follow the payoff schedule, which stops after the final payment
 * and caps it at what's owed.
 */
export function debtBillsForMonth(monthKey: MonthKey, debts: Debt[], today: IsoDate, fixes: Fixes, scheduleCache?: Map<string, PayoffSchedule>): RecurringItem[] {
  const out: Array<RecurringItem & { _debtId: string }> = [];
  for (const d of debts || []) {
    if (!d || typeof d !== 'object') continue;
    const full = scheduledAmount(d);
    const nm = String(d.name || 'Loan').trim() || 'Loan';
    const id = `debt-${d.id || nm}`;
    const dueRule = { type: 'monthly_dom' as const, dom: clampInt(Number(d.dueDay || 1), 1, 31) };
    if (fixes.loanPayoffStop && monthKey <= today.slice(0, 7)) {
      const due = dueIsoInMonth(monthKey, d.dueDay);
      const cover = (d.payments || []).find((p) => (p.auto ? p.date === due : p.replacesDue === due));
      if (cover) {
        const rule = cover.date.slice(0, 7) === monthKey ? { type: 'one_time' as const, anchor: cover.date } : dueRule;
        out.push({ id, name: nm, amount: round2(cover.amount), rule, _debtId: d.id });
        continue;
      }
    }
    if (full <= 0 || Number(d.balance || 0) <= 0) continue;
    let amount = full;
    if (fixes.loanPayoffStop) {
      let sched = scheduleCache?.get(d.id);
      if (!sched) { sched = payoffSchedule(d, today); scheduleCache?.set(d.id, sched); }
      if (Number.isFinite(sched.months) && sched.payments.length) {
        const firstMk = sched.payments[0].dueIso.slice(0, 7);
        const k = monthIndex(monthKey) - monthIndex(firstMk);
        if (k >= sched.payments.length) continue;
        if (k >= 0) amount = sched.payments[k].amount;
      }
    }
    out.push({ id, name: nm, amount, rule: dueRule, _debtId: d.id });
  }
  return out;
}

/** Month of the final payment, e.g. "2028-10"; '' when paid off, null when the payment never covers interest. */
export function payoffMonth(d: Debt, today: IsoDate): MonthKey | '' | null {
  if (Number(d.balance || 0) <= 0) return '';
  const s = payoffSchedule(d, today);
  if (!Number.isFinite(s.months)) return null;
  return s.finalDueIso ? s.finalDueIso.slice(0, 7) : '';
}

let idSeq = 0;
export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1000;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function applyScheduled(d: Debt, fromIso: IsoDate, throughIso: IsoDate, today: IsoDate, nowIso: string): { payments: DebtPayment[]; applied: DebtPayment[]; balance: number } {
  const payments = [...d.payments];
  const applied: DebtPayment[] = [];
  let bal = round2(Number(d.balance || 0));
  let due = nextDueIsoAfter(fromIso, d.dueDay, today);
  for (let guard = 0; guard < 120 && due <= throughIso && bal > 0.009; guard++) {
    const covered = payments.some((p) => (p.auto ? p.date === due : p.replacesDue === due));
    if (!covered) {
      const interestFrom = lastPaymentDate({ payments }) || d.interestStartDate || '';
      const split = paymentSplit(d, scheduledAmount(d), bal, due, interestFrom, today);
      if (split.amount > 0) {
        const p: DebtPayment = {
          id: newId('pa'), date: due, amount: split.amount, principal: split.principal, interest: split.interest,
          balanceBefore: split.balanceBefore, balanceAfter: split.balanceAfter, note: '', createdAt: nowIso,
          interestDays: split.interestDays ?? null, auto: true,
        };
        payments.push(p);
        applied.push(p);
        bal = split.balanceAfter;
      }
    }
    due = nextDueIsoAfter(due, d.dueDay, today);
  }
  return { payments, applied, balance: round2(bal) };
}

/**
 * Applies the scheduled payment on every due date since the loan was last checked, unless you logged a
 * payment in its place. Returns a new Debt and the payments added.
 */
export function catchUpAutoPay(d: Debt, today: IsoDate, nowIso: string = new Date().toISOString()): { debt: Debt; applied: DebtPayment[] } {
  const asOf = normalizeISODateLoose(d.balanceAsOf || '');
  let through = normalizeISODateLoose(d.autoPaidThrough) || today;
  if (asOf && asOf > through) through = asOf; // a balance typed in already reflects payments up to that day
  if (through >= today) return { debt: d.autoPaidThrough === today ? d : { ...d, autoPaidThrough: today }, applied: [] };
  if (!d.autoPay || Number(d.balance || 0) <= 0 || scheduledAmount(d) <= 0) return { debt: { ...d, autoPaidThrough: today }, applied: [] };
  const r = applyScheduled(d, through, today, today, nowIso);
  return { debt: { ...d, payments: r.payments, balance: r.balance, originalBalance: Math.max(Number(d.originalBalance || 0), Number(d.balance || 0)), autoPaidThrough: today }, applied: r.applied };
}

/**
 * Whether a payment stands for the scheduled payment due on `due`: an automatic one on that date, one logged
 * in its place, or (for payments logged before this app, which carry no flag) any payment in that cycle.
 */
export function paysDue(p: DebtPayment, due: IsoDate, dueDay: number): boolean {
  if (p.auto) return p.date === due;
  if (p.replacesDue) return p.replacesDue === due;
  if (p.extra) return false;
  return p.date > prevDueIso(due, dueDay) && p.date <= due;
}

/**
 * Due dates nothing covers between your last logged payment and the day automatic payments took over,
 * e.g. after importing a loan whose last logged payment was months ago. Empty once you confirm the balance.
 */
export function missedDueDates(d: Debt, today: IsoDate): IsoDate[] {
  if (Number(d.balance || 0) <= 0 || scheduledAmount(d) <= 0) return [];
  const last = lastPaymentDate(d);
  if (!last) return [];
  const from = [last, coveredThrough(d), d.balanceAsOf || ''].reduce((a, b) => (b > a ? b : a), '');
  const until = [d.autoPaidThrough || today, today].reduce((a, b) => (b < a ? b : a));
  const out: IsoDate[] = [];
  let due = nextDueIsoAfter(from, d.dueDay, today);
  for (let guard = 0; guard < 36 && due <= until; guard++) {
    if (!(d.payments || []).some((p) => paysDue(p, due, d.dueDay))) out.push(due);
    due = nextDueIsoAfter(due, d.dueDay, today);
  }
  return out;
}

/** Records exactly the missed scheduled payments, as if each was made on its due date. */
export function applyMissedPayments(d: Debt, today: IsoDate, nowIso: string = new Date().toISOString()): { debt: Debt; applied: DebtPayment[] } {
  const missed = missedDueDates(d, today);
  if (!missed.length) return { debt: d, applied: [] };
  const payments = [...d.payments];
  const applied: DebtPayment[] = [];
  let bal = round2(Number(d.balance || 0));
  for (const due of missed) {
    if (bal <= 0.009) break;
    const interestFrom = lastPaymentDate({ payments: payments.filter((p) => p.date <= due) }) || d.interestStartDate || '';
    const split = paymentSplit(d, scheduledAmount(d), bal, due, interestFrom, today);
    if (split.amount <= 0) break;
    const p: DebtPayment = {
      id: newId('pa'), date: due, amount: split.amount, principal: split.principal, interest: split.interest,
      balanceBefore: split.balanceBefore, balanceAfter: split.balanceAfter, note: '', createdAt: nowIso,
      interestDays: split.interestDays ?? null, auto: true,
    };
    payments.push(p);
    applied.push(p);
    bal = split.balanceAfter;
  }
  return { debt: { ...d, payments, balance: round2(bal) }, applied };
}

// ---------- editing payments (each change adjusts the balance by its own principal, so a balance you typed in stays) ----------

function interestFromBefore(d: Debt, dateIso: IsoDate, excludeId?: string): string {
  const before = (d.payments || []).filter((p) => p.id !== excludeId && p.amount > 0 && p.date <= dateIso).sort(paymentSortAsc);
  return before.length ? before[before.length - 1].date : d.interestStartDate || '';
}

export interface PaymentDraft { amount: number; date: IsoDate; note: string; replacesDue?: IsoDate }

/** The split a new payment would get, plus the automatic payment it would replace. */
export function previewPayment(d: Debt, draft: PaymentDraft, today: IsoDate): { split: PaymentSplit; replaced: DebtPayment | null } {
  const replaced = draft.replacesDue ? (d.payments || []).find((p) => p.auto && p.date === draft.replacesDue) ?? null : null;
  const balance = round2(Number(d.balance || 0) + (replaced ? paymentPrincipal(replaced) : 0));
  const tmp = replaced ? { ...d, payments: d.payments.filter((p) => p.id !== replaced.id) } : d;
  const split = paymentSplit(tmp, draft.amount, balance, draft.date, interestFromBefore(tmp, draft.date), today);
  return { split, replaced };
}

export function logPayment(d: Debt, draft: PaymentDraft, today: IsoDate, nowIso: string = new Date().toISOString()): Debt {
  const { split, replaced } = previewPayment(d, draft, today);
  if (split.amount <= 0) return d;
  const payments = d.payments.filter((p) => !replaced || p.id !== replaced.id);
  payments.push({
    id: newId('p'), date: draft.date, amount: split.amount, principal: split.principal, interest: split.interest,
    balanceBefore: split.balanceBefore, balanceAfter: split.balanceAfter, note: draft.note.trim(), createdAt: nowIso,
    interestDays: split.interestDays ?? null, ...(draft.replacesDue ? { replacesDue: draft.replacesDue } : { extra: true }),
  });
  return { ...d, payments, balance: split.balanceAfter, originalBalance: Math.max(Number(d.originalBalance || 0), split.balanceBefore) };
}

export function editPayment(d: Debt, id: string, patch: { amount: number; date: IsoDate; note: string }, today: IsoDate): Debt {
  const p = d.payments.find((x) => x.id === id);
  if (!p) return d;
  const before = round2(p.balanceBefore > 0 ? p.balanceBefore : Number(d.balance || 0) + paymentPrincipal(p));
  const split = paymentSplit(d, patch.amount, before, patch.date, interestFromBefore(d, patch.date, id), today);
  if (split.amount <= 0) return d;
  const delta = round2(paymentPrincipal(p) - split.principal);
  const next: DebtPayment = {
    ...p, date: patch.date, note: patch.note.trim(), amount: split.amount, principal: split.principal, interest: split.interest,
    balanceBefore: split.balanceBefore, balanceAfter: split.balanceAfter, interestDays: split.interestDays ?? null,
  };
  if (p.auto && patch.date !== p.date) {
    // It still stands for the payment due on its original date.
    delete next.auto;
    next.replacesDue = p.date;
  }
  const balance = round2(Math.max(0, Number(d.balance || 0) + delta));
  return { ...d, payments: d.payments.map((x) => (x.id === id ? next : x)), balance, originalBalance: Math.max(Number(d.originalBalance || 0), balance) };
}

export function deletePayment(d: Debt, id: string): Debt {
  const p = d.payments.find((x) => x.id === id);
  if (!p) return d;
  const balance = round2(Number(d.balance || 0) + paymentPrincipal(p));
  return { ...d, payments: d.payments.filter((x) => x.id !== id), balance, originalBalance: Math.max(Number(d.originalBalance || 0), balance) };
}

/** Typing in the balance (v117 rule for the starting balance); also confirms it as of today. */
export function setBalance(d: Debt, balance: number, today: IsoDate): Debt {
  const v = Math.max(0, round2(balance));
  const principalPaid = round2((d.payments || []).reduce((s, p) => s + paymentPrincipal(p), 0));
  return { ...d, balance: v, originalBalance: Math.max(Number(d.originalBalance || 0), round2(v + principalPaid), v), balanceAsOf: today };
}

/** Schedule-based outlook used on screen (agrees with payoffCalc whenever the loan is up to date). */
export interface LoanOutlook {
  schedule: PayoffSchedule;
  nextDue: IsoDate | '';
  nextAmount: number;
  monthsLeft: number;
  interestLeft: number;
  payoffMk: MonthKey | '' | null;
}

export function loanOutlook(d: Debt, today: IsoDate): LoanOutlook {
  const schedule = payoffSchedule(d, today);
  const first = schedule.payments[0];
  return {
    schedule,
    nextDue: first ? first.dueIso : '',
    nextAmount: first ? first.amount : 0,
    monthsLeft: Number(d.balance || 0) <= 0 ? 0 : schedule.months,
    interestLeft: Number.isFinite(schedule.months) ? schedule.interest : NaN,
    payoffMk: Number(d.balance || 0) <= 0 ? '' : Number.isFinite(schedule.months) ? (schedule.finalDueIso ? schedule.finalDueIso.slice(0, 7) : '') : null,
  };
}
