import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importV117 } from '../src/data/importV117';
import { PlanEngine } from '../src/engine/plan';
import { ALL_FIXES } from '../src/engine/types';
import { isoDate } from '../src/engine/dates';
import { homeModel, monthDetails, timelineModel } from '../src/state/models';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'sample-biweekly.v117.json'), 'utf8'));
const { data } = importV117(raw, '2026-11-06');
const engine = new PlanEngine(data, { today: '2026-11-06', fixes: ALL_FIXES });

describe('home model (sample data, Fri Nov 6 2026)', () => {
  const m = homeModel(engine);
  it('shows what the Bills account and Savings should have today', () => {
    expect(m.billsNow).toBe(196.99);
    expect(m.savingsNow).toBe(3200);
    expect(m.billsBeforeTodaysBills).toBeNull();
  });
  it('current pay period and left to spend', () => {
    expect(m.current.period.startIso).toBe('2026-10-30');
    expect(m.current.period.endIso).toBe('2026-11-12');
    expect(m.current.snapshot.totals.spent).toBe(128.7);
    expect(m.current.snapshot.totals.remaining).toBe(699.8);
    expect(m.current.daysLeft).toBe(7);
    expect(m.lowest).toEqual({ amount: 100, ms: Date.UTC(2026, 10, 12) });
  });
  it('next payday moves', () => {
    const p = m.nextPayday!;
    expect(isoDate(p.ms)).toBe('2026-11-13');
    expect(p.billsMove).toBe(1158.74);
    expect(p.savingsMove).toBe(200);
    expect(p.spending).toBe(491.26);
    expect(p.planned).toBe(340);
    expect(p.free).toBe(151.26);
    expect(p.minimum?.shortBy).toBe(148.74);
    expect(m.daysToPayday).toBe(7);
  });
  it('coming up and alerts', () => {
    expect(m.comingUp.slice(0, 3).map((e) => [isoDate(e.ms), e.title, e.amount, e.billsAfter])).toEqual([
      ['2026-11-09', 'Spotify', -11.99, 185],
      ['2026-11-12', 'Phone', -85, 100],
      ['2026-11-13', 'Payday', 1158.74, 1258.74],
    ]);
    expect(m.alerts.some((a) => a.id === 'min-2026-11-13')).toBe(true);
  });
});

describe('timeline', () => {
  it('groups November by pay period with running balances', () => {
    const groups = timelineModel(engine, '2026-11', 'period', 'activity');
    expect(groups.map((g) => g.key)).toEqual(['2026-10-30_2026-11-12', '2026-11-13_2026-11-26', '2026-11-27_2026-12-10']);
    const first = groups[0];
    expect(first.isCurrent).toBe(true);
    const titles = first.days.flatMap((d) => d.entries.map((e) => `${isoDate(e.ms)} ${e.title} ${e.billsAfter}`));
    expect(titles).toContain('2026-11-01 Rent 361.99');
    expect(titles).toContain('2026-11-12 Phone 100');
    expect(first.days.some((d) => d.isToday && d.entries.length === 0)).toBe(true);
  });
  it('month details', () => {
    const d = monthDetails(engine, '2026-11');
    expect(d.plan.AS2).toBe(1811.99);
    expect(d.plan.TargetCarry).toBe(1726.99);
    expect(d.billsTotal).toBe(2402.48);
    expect(d.startBalance).toBe(1811.99);
    expect(d.endBalance).toBe(1726.99);
  });
});

describe('running balances are continuous and exact', () => {
  for (const name of ['sample-biweekly', 'two-incomes', 'tight-monthly']) {
    it(name, async () => {
      const { importV117: imp } = await import('../src/data/importV117');
      const { entriesForDay, rowAt, monthStartAdjustment } = await import('../src/state/models');
      const { addMonthsKey, monthStartMs, monthEndMs, addDaysMs } = await import('../src/engine/dates');
      const rawF = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', `${name}.v117.json`), 'utf8'));
      const eng = new PlanEngine(imp(rawF, '2026-11-06').data, { today: '2026-11-06', fixes: ALL_FIXES });
      for (let i = -1; i < 13; i++) {
        const mk = addMonthsKey('2026-11', i);
        for (let ms = monthStartMs(mk); ms <= monthEndMs(mk); ms = addDaysMs(ms, 1)) {
          const entries = entriesForDay(eng, ms);
          const row = rowAt(eng, ms)!;
          if (entries.length) expect(entries[entries.length - 1].billsAfter).toBe(row.billsBalanceWorking);
        }
        const first = entriesForDay(eng, monthStartMs(mk));
        const delta = monthStartAdjustment(eng, mk);
        const prevEnd = rowAt(eng, addDaysMs(monthStartMs(mk), -1))!.billsBalanceWorking;
        if (Math.abs(delta) >= 1) {
          expect(first[0].kind).toBe('adjust');
          expect(Math.round((prevEnd + first[0].amount) * 100) / 100).toBe(eng.plan(mk).seedWanted);
        } else {
          expect(first.some((e) => e.kind === 'adjust')).toBe(false);
        }
      }
    });
  }
});
