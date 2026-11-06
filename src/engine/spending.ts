/**
 * Spending budgets, Unassigned (v117 "Misc"), logged spending and budget moves.
 * Exact ports of extraSpendSnapshotForRange, miscBudgetForRange/pocketPlanForPeriod,
 * extraSpendPeriodInfo, extraSpendMonthSummaryFromPayPeriods and the graph helpers.
 */
import {
  addDaysMs, addMonthsKey, isoDate, monthEndMs, monthStartMs, normalizeISODateLoose, parseISOToMs,
  type IsoDate, type MonthKey,
} from './dates';
import { round2 } from './money';
import { getPaydaysForMonth, nextPaydayAfterMs, occurrencesForRange } from './schedule';
import { payIndexForDate, pocketBase } from './pocket';
import type { PlanEngine, MonthPlan } from './plan';
import { MISC_ID, MISC_NAME, type SpendEntry, type SpendTransfer } from './types';

export const isMisc = (id: unknown) => String(id || '') === MISC_ID;

export function compareCategoryNames(a: { id?: string; name?: string }, b: { id?: string; name?: string }): number {
  const aName = String(a?.name || ''), bName = String(b?.name || '');
  const aMisc = isMisc(a?.id) || aName.trim().toLowerCase() === MISC_NAME.toLowerCase();
  const bMisc = isMisc(b?.id) || bName.trim().toLowerCase() === MISC_NAME.toLowerCase();
  if (aMisc !== bMisc) return aMisc ? 1 : -1;
  return aName.localeCompare(bName, undefined, { sensitivity: 'base', numeric: true });
}

export function validTransfers(list: SpendTransfer[]): SpendTransfer[] {
  return (list || []).filter((x) => x && x.fromExtraId && x.toExtraId && x.fromExtraId !== x.toExtraId && Number(x.amount || 0) > 0);
}

/** v117 pocketPlanForPeriod: the month plan whose payday starts the period. */
export function planForPeriodStart(engine: PlanEngine, startMs: number, monthHint: MonthKey): MonthPlan | null {
  const hint = monthHint || isoDate(startMs).slice(0, 7);
  let plan: MonthPlan | null = engine.plan(hint);
  if (plan && plan.paydays.length) {
    const sorted = plan.paydays.slice().sort((a, b) => a - b);
    if (startMs < sorted[0]) {
      const prev = engine.plan(addMonthsKey(hint, -1));
      if (prev && prev.paydays.length) plan = prev;
    }
  }
  if (!plan || !plan.paydays.length) {
    const fallbackMk = isoDate(startMs).slice(0, 7);
    const within = [addMonthsKey(hint, -1), hint, addMonthsKey(hint, 1)].includes(fallbackMk);
    if (within) plan = engine.plan(fallbackMk) || plan;
  }
  return plan;
}

/** Unassigned budget: the period's spending money minus every other budget, never below zero. */
export function miscBudgetForRange(engine: PlanEngine, startMs: number, endMs: number, projectedBudgetTotal: number, monthHint: MonthKey): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (endMs < startMs) [startMs, endMs] = [endMs, startMs];
  const plan = planForPeriodStart(engine, startMs, monthHint);
  if (!plan || !plan.paydays.length) return 0;
  const payIndex = payIndexForDate(plan, startMs);
  if (payIndex == null || payIndex < 0) return 0;
  const base = round2(pocketBase(plan, payIndex, engine.settings));
  const misc = round2(Math.max(0, base - round2(Number(projectedBudgetTotal || 0))));
  return misc > 0.009 ? misc : 0;
}

export interface CategoryRow {
  id: string; name: string; budget: number; spent: number; remaining: number; entryCount: number;
  transferIn: number; transferOut: number; transferNet: number;
}
export interface Snapshot { items: CategoryRow[]; totals: { budget: number; spent: number; remaining: number } }

export function snapshotForRange(engine: PlanEngine, startMs: number, endMs: number): Snapshot {
  const data = engine.data;
  const extras = data.extras || [];
  const logs: SpendEntry[] = data.spendEntries || [];
  const transfers = validTransfers(data.spendTransfers || []);
  const extraById = new Map(extras.filter((x) => x?.id).map((x) => [String(x.id), x]));
  const map = new Map<string, CategoryRow>();
  const ensure = (id: string, fallbackName = 'Extra cost'): CategoryRow | null => {
    const sid = String(id || '');
    if (!sid) return null;
    let row = map.get(sid);
    if (!row) {
      const ex = extraById.get(sid);
      row = { id: sid, name: String(ex?.name || fallbackName || 'Extra cost'), budget: 0, spent: 0, remaining: 0, entryCount: 0, transferIn: 0, transferOut: 0, transferNet: 0 };
      map.set(sid, row);
    } else {
      const ex = extraById.get(sid);
      if (ex?.name) row.name = String(ex.name);
      else if ((!row.name || row.name === 'Extra cost') && fallbackName) row.name = String(fallbackName);
    }
    return row;
  };
  for (const x of extras) if (x?.id) ensure(x.id, x.name || 'Extra cost');
  for (const arr of occurrencesForRange(startMs, endMs, extras, engine.settings).values()) {
    for (const it of arr || []) {
      if (!it?.id) continue;
      const row = ensure(it.id, it.name || 'Extra cost');
      if (row) row.budget = round2(row.budget + Number(it.amount || 0));
    }
  }
  for (const it of logs) {
    if (!it || typeof it !== 'object') continue;
    const ms = parseISOToMs(normalizeISODateLoose(it.date || ''));
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue;
    const row = ensure(it.extraId, it.extraName || 'Extra cost');
    if (!row) continue;
    row.spent = round2(row.spent + Number(it.amount || 0));
    row.entryCount += 1;
  }
  for (const it of transfers) {
    const ms = parseISOToMs(normalizeISODateLoose(it.date || ''));
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue;
    const amt = Math.max(0, Number(it.amount || 0));
    if (!(amt > 0)) continue;
    const fromRow = ensure(it.fromExtraId, it.fromExtraName || 'Extra cost');
    const toRow = ensure(it.toExtraId, it.toExtraName || 'Extra cost');
    if (fromRow) { fromRow.budget = round2(fromRow.budget - amt); fromRow.transferOut = round2(fromRow.transferOut + amt); }
    if (toRow) { toRow.budget = round2(toRow.budget + amt); toRow.transferIn = round2(toRow.transferIn + amt); }
  }
  const miscRow = ensure(MISC_ID, MISC_NAME);
  if (miscRow) {
    const projected = Array.from(map.values()).filter((r) => !isMisc(r.id)).reduce((s, r) => s + Number(r.budget || 0), 0);
    miscRow.name = MISC_NAME;
    miscRow.budget = miscBudgetForRange(engine, startMs, endMs, projected, isoDate(endMs).slice(0, 7));
  }
  const items = Array.from(map.values())
    .map((x) => ({ ...x, transferNet: round2(Number(x.transferIn || 0) - Number(x.transferOut || 0)), remaining: round2(Number(x.budget || 0) - Number(x.spent || 0)) }))
    .filter((x) => x.budget !== 0 || x.spent > 0 || x.entryCount > 0 || x.transferIn > 0 || x.transferOut > 0);
  items.sort(compareCategoryNames);
  return {
    items,
    totals: {
      budget: round2(items.reduce((s, x) => s + Number(x.budget || 0), 0)),
      spent: round2(items.reduce((s, x) => s + Number(x.spent || 0), 0)),
      remaining: round2(items.reduce((s, x) => s + Number(x.remaining || 0), 0)),
    },
  };
}

export interface Period { key: string; startMs: number; endMs: number; startIso: IsoDate; endIso: IsoDate; startsOnPayday: boolean }

/** The pay period containing a date: last payday on/before it through the day before the next payday (v117 extraSpendPeriodInfo). */
export function periodForDate(engine: PlanEngine, iso: IsoDate): Period {
  const norm = normalizeISODateLoose(iso);
  const ms = parseISOToMs(norm);
  const mk = norm.slice(0, 7);
  let paydays: number[] = [];
  for (let i = -2; i <= 4; i++) paydays = paydays.concat(getPaydaysForMonth(addMonthsKey(mk, i), engine.settings));
  paydays = paydays.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v !== a[i - 1]);
  let start: number | null = null, next: number | null = null;
  for (const p of paydays) {
    if (p <= ms) start = p;
    else { next = p; break; }
  }
  const startsOnPayday = start != null;
  if (start == null) start = monthStartMs(mk);
  if (next == null || next <= start) next = addDaysMs(monthEndMs(mk), 1);
  const end = addDaysMs(next, -1);
  const startIso = isoDate(start), endIso = isoDate(end);
  return { key: `${mk}|${startIso}|${endIso}`, startMs: start, endMs: end, startIso, endIso, startsOnPayday };
}

export function prevPeriod(engine: PlanEngine, p: Period): Period {
  return periodForDate(engine, isoDate(addDaysMs(p.startMs, -1)));
}
export function nextPeriod(engine: PlanEngine, p: Period): Period {
  return periodForDate(engine, isoDate(addDaysMs(p.endMs, 1)));
}

function candidatePeriodStarts(engine: PlanEngine, mk: MonthKey, fromOffset: number, toOffset: number): number[] {
  const starts: number[] = [];
  for (let off = fromOffset; off <= toOffset; off++) starts.push(...getPaydaysForMonth(addMonthsKey(mk, off), engine.settings));
  return starts.filter((v, i, a) => Number.isFinite(v) && a.indexOf(v) === i).sort((a, b) => a - b);
}

/** Pay periods that overlap and end in the month (v117 "Month" totals). */
export function periodsEndingInMonth(engine: PlanEngine, mk: MonthKey): Array<{ startMs: number; endMs: number }> {
  const monthStart = monthStartMs(mk), monthEnd = monthEndMs(mk);
  const out: Array<{ startMs: number; endMs: number }> = [];
  for (const s of candidatePeriodStarts(engine, mk, -1, 1)) {
    const next = nextPaydayAfterMs(s, engine.settings);
    if (!Number.isFinite(next as number)) continue;
    const e = addDaysMs(next as number, -1);
    if (e < s) continue;
    if (!(e >= monthStart && s <= monthEnd) || isoDate(e).slice(0, 7) !== mk) continue;
    out.push({ startMs: s, endMs: e });
  }
  return out;
}

export function monthSummary(engine: PlanEngine, mk: MonthKey): Snapshot {
  const periods = periodsEndingInMonth(engine, mk);
  if (!candidatePeriodStarts(engine, mk, -1, 1).length) return snapshotForRange(engine, monthStartMs(mk), monthEndMs(mk));
  const items = new Map<string, CategoryRow>();
  for (const p of periods) {
    for (const row of snapshotForRange(engine, p.startMs, p.endMs).items) {
      let t = items.get(row.id);
      if (!t) { t = { id: row.id, name: row.name, budget: 0, spent: 0, remaining: 0, entryCount: 0, transferIn: 0, transferOut: 0, transferNet: 0 }; items.set(row.id, t); }
      if (row.name) t.name = row.name;
      t.budget = round2(t.budget + row.budget);
      t.spent = round2(t.spent + row.spent);
      t.entryCount += row.entryCount;
      t.transferIn = round2(t.transferIn + row.transferIn);
      t.transferOut = round2(t.transferOut + row.transferOut);
      t.transferNet = round2(t.transferNet + row.transferNet);
    }
  }
  const list = Array.from(items.values()).map((r) => ({ ...r, remaining: round2(r.budget - r.spent) })).sort(compareCategoryNames);
  return {
    items: list,
    totals: {
      budget: round2(list.reduce((s, r) => s + r.budget, 0)),
      spent: round2(list.reduce((s, r) => s + r.spent, 0)),
      remaining: round2(list.reduce((s, r) => s + r.remaining, 0)),
    },
  };
}

export interface GraphRow { id: string; startMs: number; endMs: number; budget: number; spent: number; entryCount: number; isCurrentPeriod: boolean; isComplete: boolean }
export interface GraphMeta {
  rangeMode: 'month' | 'last7' | 'custom'; rows: GraphRow[]; totalSpent: number; completedTotalSpent: number;
  averageSpent: number; maxSpent: number; count: number; completedCount: number; hiddenCount?: number; sourceRows?: GraphRow[];
}

function graphMeta(rangeMode: GraphMeta['rangeMode'], rows: GraphRow[], extra: Partial<GraphMeta> = {}): GraphMeta {
  const totalSpent = round2(rows.reduce((s, r) => s + r.spent, 0));
  const completed = rows.filter((r) => r.isComplete);
  const completedTotalSpent = round2(completed.reduce((s, r) => s + r.spent, 0));
  const averageSpent = completed.length ? round2(completedTotalSpent / completed.length) : 0;
  const maxSpent = Math.max(averageSpent, ...rows.map((r) => r.spent), ...rows.map((r) => r.budget), 0);
  return { ...extra, rangeMode, rows, totalSpent, completedTotalSpent, averageSpent, maxSpent, count: rows.length, completedCount: completed.length };
}

function makeGraphRow(engine: PlanEngine, startMs: number, endMs: number, todayMs: number): GraphRow {
  return {
    id: `${isoDate(startMs)}_${isoDate(endMs)}`, startMs, endMs,
    budget: round2(snapshotForRange(engine, startMs, endMs).totals.budget),
    spent: 0, entryCount: 0,
    isCurrentPeriod: todayMs >= startMs && todayMs <= endMs,
    isComplete: endMs < todayMs,
  };
}

function fillLogs(engine: PlanEngine, rows: GraphRow[]) {
  for (const it of engine.data.spendEntries || []) {
    const ms = parseISOToMs(normalizeISODateLoose(it?.date || ''));
    if (!Number.isFinite(ms)) continue;
    const row = rows.find((r) => ms >= r.startMs && ms <= r.endMs);
    if (!row) continue;
    row.spent = round2(row.spent + Number(it.amount || 0));
    row.entryCount += 1;
  }
}

export function graphRowsForMonth(engine: PlanEngine, mk: MonthKey): GraphMeta {
  const todayMs = parseISOToMs(engine.today());
  const rows = periodsEndingInMonth(engine, mk).map((p) => makeGraphRow(engine, p.startMs, p.endMs, todayMs));
  fillLogs(engine, rows);
  const active = rows.filter((r) => r.entryCount > 0 || r.spent !== 0 || r.isCurrentPeriod).sort((a, b) => a.startMs - b.startMs);
  return graphMeta('month', active);
}

export function graphRowsLastN(engine: PlanEngine, mk: MonthKey, count = 7): GraphMeta {
  const todayMs = parseISOToMs(engine.today());
  const monthEnd = monthEndMs(mk);
  const rows: GraphRow[] = [];
  for (const s of candidatePeriodStarts(engine, mk, -12, 1)) {
    const next = nextPaydayAfterMs(s, engine.settings);
    if (!Number.isFinite(next as number)) continue;
    const e = addDaysMs(next as number, -1);
    if (e < s || e > monthEnd) continue;
    rows.push(makeGraphRow(engine, s, e, todayMs));
  }
  fillLogs(engine, rows);
  const active = rows.filter((r) => r.entryCount > 0 || r.spent !== 0 || r.isCurrentPeriod);
  return graphMeta('last7', active.slice(-Math.max(1, count)));
}

export function graphData(engine: PlanEngine, mk: MonthKey, range: 'month' | 'last7' | 'custom', customSource: 'month' | 'last7', hiddenIds: string[]): GraphMeta {
  if (range !== 'custom') return range === 'last7' ? graphRowsLastN(engine, mk, 7) : graphRowsForMonth(engine, mk);
  const base = customSource === 'last7' ? graphRowsLastN(engine, mk, 7) : graphRowsForMonth(engine, mk);
  const hidden = new Set(hiddenIds.map(String));
  const rows = base.rows.filter((r) => !hidden.has(r.id));
  return graphMeta('custom', rows, { hiddenCount: Math.max(0, base.rows.length - rows.length), sourceRows: base.rows });
}

export interface AverageItem { id: string; name: string; total: number; average: number; entryCount: number; periodsHit: number; completedCount: number }

/** Average spent per completed pay period, by budget (v117 average breakdown; grouped by budget id). */
export function averageBreakdown(engine: PlanEngine, meta: GraphMeta): AverageItem[] {
  const completed = meta.rows.filter((r) => r.isComplete);
  if (!completed.length) return [];
  const extraNames = new Map(engine.data.extras.map((x) => [x.id, x.name]));
  const cats = new Map<string, { id: string; name: string; total: number; entryCount: number; periods: Set<string> }>();
  for (const row of completed) {
    for (const e of engine.data.spendEntries) {
      const ms = parseISOToMs(normalizeISODateLoose(e?.date || ''));
      if (!Number.isFinite(ms) || ms < row.startMs || ms > row.endMs) continue;
      const key = String(e.extraId || e.extraName || 'uncategorized');
      let c = cats.get(key);
      if (!c) { c = { id: key, name: String(extraNames.get(e.extraId) || (isMisc(e.extraId) ? 'Unassigned' : e.extraName) || 'Uncategorized'), total: 0, entryCount: 0, periods: new Set() }; cats.set(key, c); }
      c.total = round2(c.total + Number(e.amount || 0));
      c.entryCount += 1;
      c.periods.add(row.id);
    }
  }
  return Array.from(cats.values())
    .map((c) => ({ id: c.id, name: c.name, total: round2(c.total), average: round2(c.total / completed.length), entryCount: c.entryCount, periodsHit: c.periods.size, completedCount: completed.length }))
    .filter((c) => c.entryCount > 0)
    .sort((a, b) => (Math.abs(b.average) - Math.abs(a.average)) || a.name.localeCompare(b.name));
}

export function entriesInRange(entries: SpendEntry[], startMs: number, endMs: number): SpendEntry[] {
  return (entries || [])
    .filter((e) => {
      const ms = parseISOToMs(normalizeISODateLoose(e.date));
      return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
    })
    .sort((a, b) => (b.date.localeCompare(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function transfersInRange(list: SpendTransfer[], startMs: number, endMs: number): SpendTransfer[] {
  return validTransfers(list).filter((t) => {
    const ms = parseISOToMs(normalizeISODateLoose(t.date));
    return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
  });
}
