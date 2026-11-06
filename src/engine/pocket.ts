/** Spending money per paycheck (v117 "pocket"): exact ports of capForPayIndex, pocketBasePerPaycheck, pocketPayPeriods, pocketMinimumInfo. */
import { addDaysMs } from './dates';
import { round2 } from './money';
import type { MonthPlan } from './plan';
import type { Settings } from './types';

export function capForPayIndex(plan: MonthPlan, i: number, settings: Settings): number {
  const fromPlan = Array.isArray(plan?.payCaps) ? Number(plan.payCaps[i]) : NaN;
  const fallback = Number(settings.pay?.paycheckCap || 0) + (settings.pay2 ? Number(settings.pay2.paycheckCap || 0) : 0);
  return Number.isFinite(fromPlan) && fromPlan > 0 ? fromPlan : fallback;
}

export function savingsForPayIndex(plan: MonthPlan, i: number): number {
  const v = plan.savingsByPayIndex?.[i];
  return Number.isFinite(v) ? v : plan.savingsPerPaycheck;
}

/** Paycheck (plus extra income in its period) − Bills move − Savings move. */
export function pocketBase(plan: MonthPlan, i: number, settings: Settings): number {
  return round2(capForPayIndex(plan, i, settings) - plan.billsPerPaycheck - savingsForPayIndex(plan, i));
}

/** Spending money − budgets planned in the pay period ("Projected free to spend"). */
export function pocketNet(plan: MonthPlan, i: number, settings: Settings): number {
  return round2(pocketBase(plan, i, settings) - Number(plan.pocketSpentByPayIndex?.[i] || 0));
}

export interface PayPeriod {
  payIndex: number;
  planMonth: string;
  start: number;
  end: number;
  paycheck: number;
  billsMove: number;
  savingsMove: number;
  pocketBase: number;
  /** Budgets scheduled in the period (v117 pocketSpentByPayIndex). */
  planned: number;
  /** pocketBase − planned. */
  free: number;
}

export function pocketPayPeriods(plan: MonthPlan, settings: Settings): PayPeriod[] {
  const paydays = (plan.paydays || []).slice().sort((a, b) => a - b);
  return paydays.map((start, i) => {
    let next: number | null = i < paydays.length - 1 ? paydays[i + 1] : plan.nextPaydayAfterLast || null;
    if (!next || next <= start) next = addDaysMs(plan.monthEnd, 1);
    const base = pocketBase(plan, i, settings);
    const planned = round2(Number(plan.pocketSpentByPayIndex?.[i] || 0));
    return {
      payIndex: i, planMonth: plan.mk, start, end: addDaysMs(next, -1),
      paycheck: round2(capForPayIndex(plan, i, settings)), billsMove: plan.billsPerPaycheck, savingsMove: savingsForPayIndex(plan, i),
      pocketBase: base, planned, free: round2(base - planned),
    };
  });
}

/** Index of the last payday on or before `ms` (0 when the date is before the first payday). */
export function payIndexForDate(plan: MonthPlan, ms: number): number | null {
  if (!plan || !Array.isArray(plan.paydays) || plan.paydays.length === 0) return null;
  const sorted = plan.paydays.slice().sort((a, b) => a - b);
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= ms) idx = i; else break;
  }
  return Math.max(0, idx);
}

export interface MinimumInfo {
  mode: 'net' | 'base';
  metricLabel: string;
  metricValue: number;
  minimum: number;
  base: number;
  spent: number;
  net: number;
  shortBy: number;
}

/** Non-null when the period is under your minimum free to spend (v117 pocketMinimumInfo). */
export function pocketMinimumInfo(plan: MonthPlan, i: number, settings: Settings, netOverride?: number, spentOverride?: number): MinimumInfo | null {
  const minimum = Math.max(0, round2(Number(settings.pocket?.minimumSurvival || 0)));
  if (!(minimum > 0.009) || !plan || i == null || i < 0) return null;
  const mode = settings.pocket?.thresholdMode === 'base' ? 'base' : 'net';
  const base = round2(pocketBase(plan, i, settings));
  const spent = round2(Number.isFinite(Number(spentOverride)) ? Number(spentOverride) : Number(plan.pocketSpentByPayIndex?.[i] || 0));
  const net = round2(Number.isFinite(Number(netOverride)) ? Number(netOverride) : base - spent);
  const metricValue = round2(mode === 'base' ? base : net);
  if (metricValue >= minimum - 0.009) return null;
  return {
    mode, metricLabel: mode === 'base' ? 'Spending money' : 'Free after budgets', metricValue, minimum, base, spent, net,
    shortBy: round2(minimum - metricValue),
  };
}
