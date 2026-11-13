import { describe, expect, it } from 'vitest';
import { makeDefaultData } from '../src/data/defaults';
import { isoDate } from '../src/engine/dates';
import { PlanEngine } from '../src/engine/plan';
import { getPaydaysForPay, movePayday, paydayMoveTo, usualPayday } from '../src/engine/schedule';
import { periodForDate } from '../src/engine/spending';
import { ALL_FIXES, type AppData } from '../src/engine/types';

const TODAY = '2026-11-12';
const days = (list: number[]) => list.map((ms) => isoDate(ms));

function data(dom1 = 13, dom2 = 29): AppData {
  const d = makeDefaultData(TODAY);
  d.settings.pay = { ...d.settings.pay, frequency: 'semimonthly', semimonthlyDom1: dom1, semimonthlyDom2: dom2, paycheckCap: 2000 };
  d.extras = [{ id: 'gas', name: 'Gas', amount: 80, rule: { type: 'perpay' } }];
  d.order.extras = ['gas'];
  return d;
}

describe('a payday that came early or late', () => {
  it('counts on the day it came, just that once', () => {
    const d = data();
    expect(movePayday(d.settings, '2026-11-13', '2026-11-12')).toBe(true);
    expect(days(getPaydaysForPay('2026-11', d.settings.pay))).toEqual(['2026-11-12', '2026-11-29']);
    expect(days(getPaydaysForPay('2026-12', d.settings.pay))).toEqual(['2026-12-13', '2026-12-29']);
    expect(paydayMoveTo('2026-11-12', d.settings)).toEqual({ from: '2026-11-13', to: '2026-11-12' });
    expect(usualPayday('2026-11-12', d.settings)).toBe('2026-11-13');
    expect(usualPayday('2026-11-29', d.settings)).toBe('2026-11-29');
  });

  it('starts the pay period that day, so a purchase that day is in the new period', () => {
    const d = data();
    const before = periodForDate(new PlanEngine(d, { today: TODAY, fixes: ALL_FIXES }), '2026-11-12');
    expect(isoDate(before.startMs)).toBe('2026-10-29');
    movePayday(d.settings, '2026-11-13', '2026-11-12');
    const e = new PlanEngine(d, { today: TODAY, fixes: ALL_FIXES });
    const p = periodForDate(e, '2026-11-12');
    expect([isoDate(p.startMs), isoDate(p.endMs)]).toEqual(['2026-11-12', '2026-11-28']);
    expect(isoDate(periodForDate(e, '2026-11-11').endMs)).toBe('2026-11-11');
    // The plan moves money and lands per-paycheck budgets on the new day.
    expect(days(e.plan('2026-11').paydays)).toEqual(['2026-11-12', '2026-11-29']);
    const gas = [...e.core('2026-11').xocc.entries()].map(([ms, list]) => [isoDate(ms), list.map((o) => o.name).join()]);
    expect(gas).toContainEqual(['2026-11-12', 'Gas']);
    expect(gas.some(([day]) => day === '2026-11-13')).toBe(false);
  });

  it('can move into the next or previous month, and back to the usual day', () => {
    const d = data(1, 15);
    movePayday(d.settings, '2026-12-01', '2026-11-30');
    expect(days(getPaydaysForPay('2026-11', d.settings.pay))).toEqual(['2026-11-01', '2026-11-15', '2026-11-30']);
    expect(days(getPaydaysForPay('2026-12', d.settings.pay))).toEqual(['2026-12-15']);
    movePayday(d.settings, '2026-12-01', '2026-12-01');
    expect(d.settings.pay.moved).toEqual([]);
    expect(days(getPaydaysForPay('2026-12', d.settings.pay))).toEqual(['2026-12-01', '2026-12-15']);
  });

  it('ignores a move whose usual day is no longer a payday, and refuses a day that is not one', () => {
    const d = data();
    movePayday(d.settings, '2026-11-13', '2026-11-12');
    d.settings.pay.semimonthlyDom1 = 15;
    expect(days(getPaydaysForPay('2026-11', d.settings.pay))).toEqual(['2026-11-15', '2026-11-29']);
    expect(movePayday(d.settings, '2026-11-14', '2026-11-12')).toBe(false);
  });
});
