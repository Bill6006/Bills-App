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

/**
 * The same projection as payoffCalc, with a due date and amount for every remaining payment.
 * Monthly-interest loans start from the first due date after today (or after the last payment).
 */
export function payoffSchedule(d: Debt, today: IsoDate): PayoffSchedule {
  const base = payoffCalc(d, today);
  const out: PayoffSchedule = { ...base, payments: [], finalDueIso: '' };
  if (base.months === 0 || !Number.isFinite(base.months)) return out;
  const apr = Math.max(0, Number(d.apr || 0));
  const payment = base.payment;
  const daily = !!normalizeISODateLoose(d.interestStartDate || '');
  let bal = Math.max(0, Number(d.balance || 0));
  const last = lastPaymentDate(d);
  let fromIso = daily ? (normalizeISODateLoose(last || d.interestStartDate) || today) : (last && last > today ? last : today);
  for (let i = 0; i < 600 && bal > 0.009; i++) {
    const dueIso = nextDueIsoAfter(fromIso, d.dueDay || 1, today);
    const int = daily
      ? round2(bal * (apr / 100) / 365 * (dailyInterestDays(fromIso, dueIso) ?? 30))
      : round2(bal * (apr / 100 / 12));
    const pay = round2(Math.min(payment, bal + int));
    const principal = round2(pay - int);
    bal = round2(Math.max(0, bal + int - payment));
    out.payments.push({ dueIso, amount: pay, interest: int, principal, balanceAfter: bal });
    fromIso = dueIso;
  }
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
 * Fixed: after the payoff month nothing is scheduled, and the final payment is only what's owed.
 */
export function debtBillsForMonth(monthKey: MonthKey, debts: Debt[], today: IsoDate, fixes: Fixes, scheduleCache?: Map<string, PayoffSchedule>): RecurringItem[] {
  const out: Array<RecurringItem & { _debtId: string }> = [];
  for (const d of debts || []) {
    if (!d || typeof d !== 'object') continue;
    const full = scheduledAmount(d);
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
    const nm = String(d.name || 'Loan').trim() || 'Loan';
    out.push({ id: `debt-${d.id || nm}`, name: nm, amount, rule: { type: 'monthly_dom', dom: clampInt(Number(d.dueDay || 1), 1, 31) }, _debtId: d.id });
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

/**
 * Applies the scheduled payment on every due date since the loan was last checked, unless a
 * payment you logged yourself already covers that cycle. Returns a new Debt and the payments added.
 */
export function catchUpAutoPay(d: Debt, today: IsoDate, nowIso: string = new Date().toISOString()): { debt: Debt; applied: DebtPayment[] } {
  const through = normalizeISODateLoose(d.autoPaidThrough) || today;
  if (through >= today) return { debt: d.autoPaidThrough === today ? d : { ...d, autoPaidThrough: today }, applied: [] };
  if (!d.autoPay || Number(d.balance || 0) <= 0 || scheduledAmount(d) <= 0) return { debt: { ...d, autoPaidThrough: today }, applied: [] };
  const payments = [...d.payments];
  const applied: DebtPayment[] = [];
  let bal = round2(Number(d.balance || 0));
  let due = nextDueIsoAfter(through, d.dueDay, today);
  for (let guard = 0; guard < 120 && due <= today && bal > 0.009; guard++) {
    const prev = prevDueIso(due, d.dueDay);
    const covered = payments.some((p) => !p.auto && p.date > prev && p.date <= due);
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
  return { debt: { ...d, payments, balance: round2(bal), autoPaidThrough: today }, applied };
}
