import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catchUpAutoPay, debtBillsForMonth, payoffCalc, payoffSchedule } from '../src/engine/loans';
import { PlanEngine } from '../src/engine/plan';
import { describeRule } from '../src/engine/schedule';
import { ALL_FIXES, NO_FIXES, type Debt } from '../src/engine/types';
import { importV117 } from '../src/data/importV117';
import { round2 } from '../src/engine/money';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', `${name}.v117.json`), 'utf8'));

const card: Debt = {
  id: 'd2', name: 'Credit card', balance: 2300, originalBalance: 3100, apr: 24.99, minPayment: 75, extraPayment: 50,
  dueDay: 25, priority: 1, interestStartDate: '', payments: [], autoPay: true, autoPaidThrough: '2026-11-06',
};

describe('loans', () => {
  it('payoffSchedule agrees with v117 payoffCalc', () => {
    for (const d of [card, { ...card, interestStartDate: '2026-06-01' as const }, { ...card, apr: 0 }]) {
      const calc = payoffCalc(d, '2026-11-06');
      const sched = payoffSchedule(d, '2026-11-06');
      expect(sched.payments.length).toBe(calc.months);
      expect(round2(sched.payments.reduce((s, p) => s + p.interest, 0))).toBeCloseTo(calc.interest, 2);
    }
  });

  it('sample credit card pays off in Oct 2028 with $630.65 of interest', () => {
    const s = payoffSchedule(card, '2026-11-06');
    expect(s.months).toBe(24);
    expect(s.interest).toBe(630.65);
    expect(s.payments[0].dueIso).toBe('2026-11-25');
    expect(s.finalDueIso).toBe('2028-10-25');
    expect(s.payments.at(-1)!.amount).toBeLessThan(125);
  });

  it('stops scheduling the loan after payoff when the fix is on', () => {
    const today = '2026-11-06';
    const final = payoffSchedule(card, today).payments.at(-1)!;
    expect(debtBillsForMonth('2028-10', [card], today, ALL_FIXES)[0].amount).toBe(final.amount);
    expect(debtBillsForMonth('2028-11', [card], today, ALL_FIXES)).toHaveLength(0);
    expect(debtBillsForMonth('2028-11', [card], today, NO_FIXES)[0].amount).toBe(125);
  });

  it('applies scheduled payments on due dates it has not checked yet', () => {
    const d = { ...card, autoPaidThrough: '2026-09-20' };
    const { debt, applied } = catchUpAutoPay(d, '2026-11-06', '2026-11-06T12:00:00Z');
    expect(applied.map((p) => p.date)).toEqual(['2026-09-25', '2026-10-25']);
    expect(applied.every((p) => p.auto)).toBe(true);
    expect(debt.balance).toBe(applied[1].balanceAfter);
    expect(debt.autoPaidThrough).toBe('2026-11-06');
    expect(catchUpAutoPay(debt, '2026-11-06').applied).toHaveLength(0);
  });

  it('skips the automatic payment when you logged one yourself in that cycle', () => {
    const manual = { id: 'm1', date: '2026-10-20', amount: 200, principal: 152.1, interest: 47.9, balanceBefore: 2300, balanceAfter: 2147.9, note: '', createdAt: '' };
    const d = { ...card, balance: 2147.9, autoPaidThrough: '2026-10-01', payments: [manual] };
    const { applied } = catchUpAutoPay(d, '2026-11-06');
    expect(applied).toHaveLength(0);
  });

  it('does nothing when automatic payments are off', () => {
    const { applied, debt } = catchUpAutoPay({ ...card, autoPay: false, autoPaidThrough: '2026-09-01' }, '2026-11-06');
    expect(applied).toHaveLength(0);
    expect(debt.balance).toBe(2300);
    expect(debt.autoPaidThrough).toBe('2026-11-06');
  });
});

describe('plan fixes', () => {
  it('savings cents fix makes a 3-payday month add exactly the goal', () => {
    const { data } = importV117(fixture('sample-biweekly'), '2026-11-06');
    const fixed = new PlanEngine(data, { today: '2026-11-06', fixes: ALL_FIXES }).plan('2026-10');
    const v117 = new PlanEngine(data, { today: '2026-11-06', fixes: NO_FIXES }).plan('2026-10');
    expect(fixed.paydays).toHaveLength(3);
    expect(round2(fixed.savingsByPayIndex.reduce((a, b) => a + b, 0))).toBe(400);
    expect(round2(v117.savingsPerPaycheck * 3)).toBe(399.99);
    expect(round2(fixed.endSavings - fixed.startSavings)).toBe(400);
  });

  it('working Bills balance starts each month at what the month needs', () => {
    const { data } = importV117(fixture('two-incomes'), '2026-11-06');
    const engine = new PlanEngine(data, { today: '2026-11-06', fixes: ALL_FIXES });
    for (const mk of ['2026-11', '2026-12', '2027-01']) {
      const p = engine.plan(mk);
      const first = p.rows[0];
      expect(round2(first.billsBalanceWorking - first.transferIn + first.billsOut)).toBe(p.seedWanted);
    }
  });
});

describe('import', () => {
  it('uses saved originals when a file was exported in projected mode', () => {
    const raw = fixture('sample-biweekly');
    raw.ui.proj = { active: true, origBills: [{ id: 'b1', name: 'Rent', amount: 1500, rule: { type: 'monthly_dom', dom: 1 } }], origPay: { ...raw.settings.pay, paycheckCap: 1999 } };
    raw.bills[0].amount = 9999;
    raw.ui.savingsGoalSnapshot = { active: true, value: 321 };
    raw.settings.savings.monthlyGoal = 50;
    const { data, report } = importV117(raw, '2026-11-06');
    expect(data.bills).toHaveLength(1);
    expect(data.bills[0].amount).toBe(1500);
    expect(data.settings.pay.paycheckCap).toBe(1999);
    expect(data.settings.savings.monthlyGoal).toBe(321);
    expect(report.notes.join(' ')).toMatch(/projected/);
  });

  it('keeps orders, maps neon/aurora themes to dark, and starts auto-pay today', () => {
    const { data } = importV117(fixture('two-incomes'), '2026-11-06');
    expect(data.order.bills.slice(0, 3)).toEqual(['b3', 'b1', 'b2']);
    expect(data.prefs.theme).toBe('light');
    expect(importV117(fixture('tight-monthly'), '2026-11-06').data.prefs.theme).toBe('dark');
    expect(data.debts.every((d) => d.autoPay && d.autoPaidThrough === '2026-11-06')).toBe(true);
  });

  it('rejects files that are not v117 exports', () => {
    expect(() => importV117({ hello: 'world' }, '2026-11-06')).toThrow();
  });
});

describe('rules', () => {
  it('describes repeat rules in plain words', () => {
    expect(describeRule({ type: 'monthly_dom', dom: 1 })).toBe('Monthly on the 1st');
    expect(describeRule({ type: 'monthly_dom', dom: 31 })).toBe('Monthly on the last day');
    expect(describeRule({ type: 'weekly_dow', dow: 5 })).toBe('Every Friday');
    expect(describeRule({ type: 'biweekly', anchor: '2026-10-30' })).toBe('Every other Friday');
    expect(describeRule({ type: 'annual_md', anchor: '2025-02-14' })).toBe('Yearly on Feb 14');
    expect(describeRule({ type: 'perpay' })).toBe('Every payday');
  });
});
