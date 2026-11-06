/**
 * Parity with Bills Account Planner v117.
 * Golden files are produced by scripts/v117-golden.mjs running the real v117 HTML. The new engine,
 * with every deliberate fix switched off, must reproduce each number exactly.
 * Extra pairs (e.g. a personal export, never committed) can be checked by setting PARITY_DIR to a folder
 * holding NAME.v117.json + NAME.golden.json.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importV117 } from '../src/data/importV117';
import { PlanEngine } from '../src/engine/plan';
import { ALL_FIXES, NO_FIXES } from '../src/engine/types';
import { parseISOToMs, isoDate } from '../src/engine/dates';
import { pocketBase, pocketMinimumInfo, pocketNet, pocketPayPeriods } from '../src/engine/pocket';
import { averageBreakdown, graphRowsForMonth, graphRowsLastN, monthSummary, periodForDate, snapshotForRange } from '../src/engine/spending';
import { debtSummary, lastPaymentDate, monthsLabel, nextDueIsoAfter, orderDebts, paidSoFar, payoffCalc, paymentSplit, recalcFromPayments, scheduledAmount } from '../src/engine/loans';

type Golden = Record<string, any>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const GOLDEN = path.join(HERE, 'golden');

function pairs(): Array<{ name: string; fixture: string; golden: string }> {
  const out: Array<{ name: string; fixture: string; golden: string }> = [];
  const add = (dir: string, fixturesDir: boolean) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.endsWith('.golden.json')) continue;
      if (fixturesDir && !f.endsWith('.v117.json')) continue;
      const name = f.replace(/(\.v117)?\.json$/, '');
      const golden = path.join(fixturesDir ? GOLDEN : dir, `${name}.golden.json`);
      if (fs.existsSync(golden)) out.push({ name, fixture: path.join(dir, f), golden });
    }
  };
  add(FIXTURES, true);
  if (process.env.PARITY_DIR) add(process.env.PARITY_DIR, false);
  return out;
}

/** Collects mismatches as readable strings instead of failing on the first one. */
function differ() {
  const diffs: string[] = [];
  const eq = (label: string, a: unknown, b: unknown) => {
    const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b);
    if (!same) diffs.push(`${label}: new=${JSON.stringify(a)} v117=${JSON.stringify(b)}`);
  };
  return { diffs, eq };
}

for (const pair of pairs()) {
  describe(`parity: ${pair.name}`, () => {
    const raw = JSON.parse(fs.readFileSync(pair.fixture, 'utf8'));
    const golden: Golden = JSON.parse(fs.readFileSync(pair.golden, 'utf8'));
    const { data } = importV117(raw, golden.today, { nowIso: '2026-01-01T00:00:00.000Z' });
    // PARITY_FIXES=all shows exactly what the deliberate fixes change (expected to fail).
    const engine = new PlanEngine(data, { today: golden.today, fixes: process.env.PARITY_FIXES === 'all' ? ALL_FIXES : NO_FIXES });

    it('v117 ran without page errors', () => {
      expect(golden.pageErrors).toEqual([]);
    });

    it('month plans and every ledger day match', () => {
      const { diffs, eq } = differ();
      const plans = engine.buildRange(golden.range[0], golden.range[1]);
      for (const [mk, g] of Object.entries<any>(golden.plans)) {
        const p = plans.get(mk);
        if (!p) { diffs.push(`${mk}: missing plan`); continue; }
        for (const k of ['AS2', 'TargetCarry', 'TB1', 'billsPerPaycheck', 'desiredBillsPerPaycheck', 'nominalBillsPerPaycheck', 'minBillsPerPaycheckForCushion',
          'maxBillsPerPaycheck', 'extraFunding', 'savingsPerPaycheck', 'topup', 'startAfterTopup', 'startBills', 'startSavings', 'billsStartSurplus',
          'endBills', 'endSavings', 'lowestBillsBal']) eq(`${mk}.${k}`, (p as any)[k], g[k]);
        eq(`${mk}.paydays`, p.paydays.map(isoDate), g.paydays);
        eq(`${mk}.payCaps`, p.payCaps, g.payCaps);
        eq(`${mk}.lowestBillsBalDate`, p.lowestBillsBalDate == null ? null : isoDate(p.lowestBillsBalDate), g.lowestBillsBalDate);
        eq(`${mk}.nextPaydayAfterLast`, p.nextPaydayAfterLast == null ? null : isoDate(p.nextPaydayAfterLast), g.nextPaydayAfterLast);
        eq(`${mk}.pocketSpentByPayIndex`, p.pocketSpentByPayIndex, g.pocketSpentByPayIndex);
        eq(`${mk}.pocketBase`, p.paydays.map((_, i) => pocketBase(p, i, data.settings)), g.pocketBase);
        eq(`${mk}.pocketNet`, p.paydays.map((_, i) => pocketNet(p, i, data.settings)), g.pocketNet);
        eq(`${mk}.minimumInfo`, p.paydays.map((_, i) => { const m = pocketMinimumInfo(p, i, data.settings); return m ? { metricValue: m.metricValue, shortBy: m.shortBy } : null; }), g.minimumInfo);
        eq(`${mk}.periods`, pocketPayPeriods(p, data.settings).map((x) => ({ start: isoDate(x.start), end: isoDate(x.end), base: x.pocketBase, spent: x.planned, net: x.free })), g.periods);
        const rows = p.rows.map((r) => [isoDate(r.ms), r.transferIn, r.billsOut, r.savingsIn, r.savingsOut, r.pocketOut, r.billsBalance, r.billsBalanceWorking, r.savingsBalance]);
        for (let i = 0; i < Math.max(rows.length, g.rows.length); i++) eq(`${mk}.row[${g.rows[i]?.[0] ?? i}]`, rows[i], g.rows[i]);
      }
      expect(diffs.slice(0, 25)).toEqual([]);
    });

    it('savings projections match', () => {
      const { diffs, eq } = differ();
      for (const [mk, v] of Object.entries<number>(golden.projectedSavings)) eq(`savings ${mk}`, engine.projectedSavingsAtMonthStart(mk), v);
      expect(diffs.slice(0, 25)).toEqual([]);
    });

    it('pay periods and spending snapshots match', () => {
      const { diffs, eq } = differ();
      for (const p of golden.periodInfo) {
        const mine = periodForDate(engine, p.startIso);
        eq(`period ${p.key}`, [mine.startIso, mine.endIso], [p.startIso, p.endIso]);
      }
      for (const s of golden.snapshots) {
        const snap = snapshotForRange(engine, parseISOToMs(s.startIso), parseISOToMs(s.endIso));
        eq(`snapshot ${s.startIso}..${s.endIso} totals`, snap.totals, s.totals);
        eq(`snapshot ${s.startIso}..${s.endIso} items`, snap.items.map((x) => [x.id, x.budget, x.spent, x.remaining, x.entryCount, x.transferIn, x.transferOut]), s.items);
      }
      for (const [mk, s] of Object.entries<any>(golden.monthSummaries)) {
        const sum = monthSummary(engine, mk);
        eq(`month ${mk} totals`, sum.totals, s.totals);
        eq(`month ${mk} items`, sum.items.map((x) => [x.id, x.budget, x.spent, x.remaining, x.entryCount]), s.items);
      }
      expect(diffs.slice(0, 25)).toEqual([]);
    });

    it('spending trends match', () => {
      const { diffs, eq } = differ();
      const shape = (meta: ReturnType<typeof graphRowsForMonth>) => ({
        totalSpent: meta.totalSpent, averageSpent: meta.averageSpent, maxSpent: meta.maxSpent, count: meta.count, completedCount: meta.completedCount,
        rows: meta.rows.map((r) => [r.id, r.budget, r.spent, r.entryCount, r.isCurrentPeriod, r.isComplete]),
      });
      for (const [mk, g] of Object.entries<any>(golden.graphs)) {
        const m = graphRowsForMonth(engine, mk), l = graphRowsLastN(engine, mk, 7);
        eq(`graph month ${mk}`, shape(m), { ...g.month, average: undefined, rows: g.month.rows });
        eq(`graph last7 ${mk}`, shape(l), { ...g.last7, average: undefined, rows: g.last7.rows });
        const avg = (meta: typeof m) => averageBreakdown(engine, meta).map((a) => [a.total, a.average, a.entryCount, a.periodsHit]).sort();
        eq(`avg month ${mk}`, avg(m), g.month.average.map((a: any[]) => a.slice(1)).sort());
      }
      expect(diffs.slice(0, 25)).toEqual([]);
    });

    it('loan math matches', () => {
      const { diffs, eq } = differ();
      const today = golden.today;
      for (const g of golden.debts) {
        const d = data.debts.find((x) => x.id === g.id);
        if (!d) {
          // Only completely empty placeholder loans may be skipped by the importer.
          eq(`${g.id} skipped only if empty`, [g.balance, g.months, g.replay.payments.length], [0, 0, 0]);
          continue;
        }
        const calc = payoffCalc(d, today);
        eq(`${g.id} months`, Number.isFinite(calc.months) ? calc.months : 'Infinity', g.months);
        eq(`${g.id} interest`, calc.interest, g.interest);
        eq(`${g.id} label`, monthsLabel(calc.months), g.label);
        eq(`${g.id} paidSoFar`, paidSoFar(d), g.paidSoFar);
        const due = nextDueIsoAfter(today, d.dueDay, today);
        eq(`${g.id} nextDue`, due, g.nextDue);
        const split = paymentSplit(d, scheduledAmount(d), undefined, due, lastPaymentDate(d) || d.interestStartDate || '', today);
        eq(`${g.id} split`, [split.amount, split.interest, split.principal, split.balanceAfter], g.split);
        const replay = recalcFromPayments(d, today, d.originalBalance);
        eq(`${g.id} replay`, { balance: replay.balance, payments: [...replay.payments].sort((a, b) => a.date.localeCompare(b.date)).map((p) => [p.date, p.amount, p.interest, p.principal, p.balanceAfter]) },
          { balance: g.replay.balance, payments: [...g.replay.payments].sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0]))) });
      }
      const visible = data.debts.filter((d) => d.balance > 0 || golden.order.avalanche.includes(d.id));
      const kept = new Set(data.debts.map((d) => d.id));
      for (const s of ['avalanche', 'snowball', 'custom'] as const) eq(`order ${s}`, orderDebts(visible, s).map((d) => d.id), golden.order[s].filter((id: string) => kept.has(id)));
      const sum = debtSummary(data.debts, today);
      eq('summary', { totalBalance: sum.totalBalance, paidSoFar: sum.paidSoFar, monthlyTotal: sum.monthlyTotal, longestMonths: Number.isFinite(sum.longestMonths) ? sum.longestMonths : 'Infinity', interest: sum.interestLeft }, golden.debtSummary);
      expect(diffs.slice(0, 25)).toEqual([]);
    });
  });
}
