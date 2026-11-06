/** View models for the Spending screen. */
import { addDaysMs, addMonthsKey, fmtMonthLong, fmtRange, isoDate, monthEndMs, monthStartMs, parseISOToMs, type IsoDate, type MonthKey } from '../engine/dates';
import { round2 } from '../engine/money';
import type { PlanEngine } from '../engine/plan';
import {
  entriesInRange, monthSummary, nextPeriod, periodForDate, prevPeriod, snapshotForRange, transfersInRange, type CategoryRow, type Period, type Snapshot,
} from '../engine/spending';
import { MISC_ID, type AppData, type SpendEntry, type SpendTransfer } from '../engine/types';

export type Scope = { kind: 'period'; period: Period } | { kind: 'month'; mk: MonthKey };

export function scopeRange(engine: PlanEngine, scope: Scope): { startMs: number; endMs: number; title: string; snapshot: Snapshot } {
  if (scope.kind === 'period') {
    return { startMs: scope.period.startMs, endMs: scope.period.endMs, title: fmtRange(scope.period.startMs, scope.period.endMs), snapshot: snapshotForRange(engine, scope.period.startMs, scope.period.endMs) };
  }
  // v117 "Month": pay periods that end in the month (its budgets add up per period).
  return { startMs: monthStartMs(scope.mk), endMs: monthEndMs(scope.mk), title: fmtMonthLong(scope.mk), snapshot: monthSummary(engine, scope.mk) };
}

export function shiftScope(engine: PlanEngine, scope: Scope, dir: -1 | 1): Scope {
  if (scope.kind === 'period') return { kind: 'period', period: dir < 0 ? prevPeriod(engine, scope.period) : nextPeriod(engine, scope.period) };
  return { kind: 'month', mk: addMonthsKey(scope.mk, dir) };
}

export function currentScope(engine: PlanEngine, kind: 'period' | 'month'): Scope {
  return kind === 'period' ? { kind: 'period', period: periodForDate(engine, engine.today()) } : { kind: 'month', mk: engine.today().slice(0, 7) };
}

export interface BudgetOption { id: string; name: string; archived?: boolean }

/** Budgets you can log against: your budgets in order, then Unassigned. */
export function budgetOptions(data: AppData, includeId?: string): BudgetOption[] {
  const byId = new Map(data.extras.map((x) => [x.id, x]));
  const ordered = data.order.extras.map((id) => byId.get(id)).filter(Boolean) as AppData['extras'];
  for (const x of data.extras) if (!ordered.includes(x)) ordered.push(x);
  const out: BudgetOption[] = ordered.map((x) => ({ id: x.id, name: x.name || 'Budget' }));
  out.push({ id: MISC_ID, name: 'Unassigned' });
  if (includeId && !out.some((o) => o.id === includeId)) {
    const e = data.spendEntries.find((x) => x.extraId === includeId);
    out.push({ id: includeId, name: e?.extraName || 'Archived budget', archived: true });
  }
  return out;
}

export function displayName(data: AppData, id: string, fallback?: string): string {
  if (id === MISC_ID) return 'Unassigned';
  return data.extras.find((x) => x.id === id)?.name || fallback || 'Archived budget';
}

export function isArchived(data: AppData, id: string): boolean {
  return id !== MISC_ID && !data.extras.some((x) => x.id === id);
}

/** Budgets in display order (your order, Unassigned last, archived after). */
export function orderedRows(data: AppData, snap: Snapshot): CategoryRow[] {
  const pos = new Map(data.order.extras.map((id, i) => [id, i]));
  const rank = (r: CategoryRow) => (r.id === MISC_ID ? 10_000 : isArchived(data, r.id) ? 20_000 : pos.get(r.id) ?? 5_000);
  return [...snap.items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function meterTone(row: CategoryRow): 'bad' | 'warn' | 'good' | undefined {
  const budget = Math.max(0, row.budget), spent = Math.max(0, row.spent);
  if (budget <= 0) return spent > 0 ? 'bad' : undefined;
  if (spent > budget + 0.004) return 'bad';
  if (spent >= budget * 0.9) return 'warn';
  return undefined;
}

export function rangeEntries(data: AppData, startMs: number, endMs: number): SpendEntry[] {
  return entriesInRange(data.spendEntries, startMs, endMs);
}

export function rangeTransfers(data: AppData, startMs: number, endMs: number): SpendTransfer[] {
  return transfersInRange(data.spendTransfers, startMs, endMs).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Remaining in each budget for the pay period containing `iso` (used to cap budget moves). */
export function availableOn(engine: PlanEngine, iso: IsoDate): Map<string, number> {
  const p = periodForDate(engine, iso);
  const snap = snapshotForRange(engine, p.startMs, p.endMs);
  return new Map(snap.items.map((r) => [r.id, r.remaining]));
}

export interface HistoryGroup { key: string; title: string; startMs: number; endMs: number; total: number; entries: SpendEntry[] }

/** All logs grouped by pay period, newest first; optional case-insensitive search on note or budget. */
export function historyGroups(engine: PlanEngine, query: string): HistoryGroup[] {
  const data = engine.data;
  const q = query.trim().toLowerCase();
  const list = data.spendEntries
    .filter((e) => !q || e.note.toLowerCase().includes(q) || displayName(data, e.extraId, e.extraName).toLowerCase().includes(q) || String(Math.abs(e.amount)).includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const groups = new Map<string, HistoryGroup>();
  const periodCache = new Map<string, Period>();
  for (const e of list) {
    let p = periodCache.get(e.date);
    if (!p) { p = periodForDate(engine, e.date); periodCache.set(e.date, p); }
    let g = groups.get(p.key);
    if (!g) { g = { key: p.key, title: fmtRange(p.startMs, p.endMs), startMs: p.startMs, endMs: p.endMs, total: 0, entries: [] }; groups.set(p.key, g); }
    g.entries.push(e);
    g.total = round2(g.total + e.amount);
  }
  return [...groups.values()].sort((a, b) => b.startMs - a.startMs);
}

export function daysLeftIn(engine: PlanEngine, endMs: number): number {
  const t = parseISOToMs(engine.today());
  return Math.max(0, Math.round((endMs - t) / 86400000) + 1);
}

export const nextDayAfter = (ms: number) => addDaysMs(ms, 1);
export const isoOf = (ms: number) => isoDate(ms);
