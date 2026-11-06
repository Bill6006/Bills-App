import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMissedPayments, catchUpAutoPay, debtBillsForMonth, deletePayment, editPayment, logPayment, missedDueDates, nextUnpaidDue, payoffCalc, payoffSchedule, previewPayment, setBalance } from '../src/engine/loans';
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
  // payoffCalc (v117) projects from the last payment date; the schedule never starts in the past, so the two
  // agree whenever the loan is up to date (no due dates between the last payment and today).
  it('payoffSchedule agrees with v117 payoffCalc', () => {
    for (const d of [card, { ...card, interestStartDate: '2026-10-26' as const }, { ...card, apr: 0 }]) {
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

  it('skips the automatic payment only when a logged payment replaces it', () => {
    const manual = { id: 'm1', date: '2026-10-20', amount: 200, principal: 152.1, interest: 47.9, balanceBefore: 2300, balanceAfter: 2147.9, note: '', createdAt: '' };
    const replacing = { ...card, balance: 2147.9, autoPaidThrough: '2026-10-01', payments: [{ ...manual, replacesDue: '2026-10-25' }] };
    expect(catchUpAutoPay(replacing, '2026-11-06').applied).toHaveLength(0);
    const extra = { ...card, balance: 2147.9, autoPaidThrough: '2026-10-01', payments: [manual] };
    expect(catchUpAutoPay(extra, '2026-11-06').applied.map((p) => p.date)).toEqual(['2026-10-25']);
  });

  it('does nothing when automatic payments are off', () => {
    const { applied, debt } = catchUpAutoPay({ ...card, autoPay: false, autoPaidThrough: '2026-09-01' }, '2026-11-06');
    expect(applied).toHaveLength(0);
    expect(debt.balance).toBe(2300);
    expect(debt.autoPaidThrough).toBe('2026-11-06');
  });
});

describe('loan payments', () => {
  const today = '2026-11-06';
  // Daily-interest loan whose last logged payment was months ago (like a v117 file that wasn't kept up).
  const stale: Debt = {
    id: 'car', name: 'Car', balance: 20000, originalBalance: 24000, apr: 6, minPayment: 500, extraPayment: 0, dueDay: 25, priority: 1,
    interestStartDate: '2026-01-10', autoPay: true, autoPaidThrough: '2026-11-05',
    payments: [{ id: 'p1', date: '2026-08-31', amount: 500, principal: 400, interest: 100, balanceBefore: 20400, balanceAfter: 20000, note: '', createdAt: '' }],
  };

  it('never schedules a payment in the past; the first one carries the interest since the last payment', () => {
    const s = payoffSchedule(stale, today);
    expect(s.payments[0].dueIso).toBe('2026-11-25');
    expect(s.payments[0].interest).toBe(round2(20000 * 0.06 / 365 * 86));
  });

  it('finds due dates nothing covers and can record exactly those as paid', () => {
    // The Aug 31 payment falls in the cycle ending Sep 25, so only Oct 25 is missing.
    expect(missedDueDates(stale, today)).toEqual(['2026-10-25']);
    const { debt, applied } = applyMissedPayments(stale, today, 'now');
    expect(applied.map((p) => p.date)).toEqual(['2026-10-25']);
    expect(applied[0].interest).toBe(round2(20000 * 0.06 / 365 * 55));
    expect(debt.balance).toBe(applied[0].balanceAfter);
    expect(missedDueDates(debt, today)).toEqual([]);
    expect(payoffSchedule(debt, today).payments[0].dueIso).toBe('2026-11-25');
  });

  it('a payment made just before its due date counts for that date', () => {
    const early: Debt = { ...stale, payments: [{ ...stale.payments[0], date: '2026-10-24' }] };
    expect(missedDueDates(early, today)).toEqual([]);
  });

  it('confirming the balance clears the missed-payment check', () => {
    expect(missedDueDates({ ...stale, balanceAsOf: today }, today)).toEqual([]);
  });

  it('moving an automatic payment to the day you really paid keeps it tied to its due date', () => {
    const paid = catchUpAutoPay({ ...card, autoPaidThrough: '2026-10-20' }, today, 'now').debt;
    const auto = paid.payments.find((p) => p.auto)!;
    const moved = editPayment(paid, auto.id, { amount: auto.amount, date: '2026-10-27', note: '' }, today);
    const p = moved.payments.find((x) => x.id === auto.id)!;
    expect(p.auto).toBeUndefined();
    expect(p.replacesDue).toBe('2026-10-25');
    expect(debtBillsForMonth('2026-10', [moved], today, ALL_FIXES)[0].amount).toBe(p.amount);
    expect(missedDueDates(moved, today)).toEqual([]);
  });

  it('an extra payment never finishes a cycle; a typed balance does', () => {
    const due = { ...card, dueDay: 6, autoPay: false };
    const extra = logPayment(due, { amount: 50, date: today, note: '' }, today, 'now');
    expect(extra.payments[0].extra).toBe(true);
    expect(nextUnpaidDue(extra, today)).toBe('2026-11-06');
    expect(nextUnpaidDue({ ...due, balanceAsOf: today }, today)).toBe('2026-12-06');
  });

  it('turning automatic payments on covers a payment due today, but not past a typed balance', () => {
    const due: Debt = { ...card, dueDay: 6, autoPaidThrough: '2026-11-05' };
    expect(catchUpAutoPay(due, today, 'now').applied.map((p) => p.date)).toEqual(['2026-11-06']);
    expect(catchUpAutoPay({ ...due, balanceAsOf: today }, today, 'now').applied).toHaveLength(0);
  });

  it('a long gap makes the first payment all interest, never a negative principal', () => {
    const gap: Debt = { ...stale, minPayment: 250, payments: [{ ...stale.payments[0], date: '2026-08-01' }] };
    const first = payoffSchedule(gap, today).payments[0];
    expect(first.principal).toBe(0);
    expect(first.interest).toBe(250);
    expect(first.balanceAfter).toBe(20000);
  });

  it('keeps a missing starting balance from turning into NaN', () => {
    const noOrig = { ...card, autoPaidThrough: '2026-10-20' } as Debt;
    delete (noOrig as Partial<Debt>).originalBalance;
    expect(Number.isFinite(catchUpAutoPay(noOrig, today, 'now').debt.originalBalance)).toBe(true);
  });

  it('typing the balance confirms it, keeps it through later payments, and clears the missed-payment check', () => {
    const typed = setBalance(stale, 19050.25, today);
    expect(missedDueDates(typed, today)).toEqual([]);
    const after = logPayment(typed, { amount: 300, date: today, note: 'extra' }, today, 'now');
    const p = after.payments.at(-1)!;
    expect(p.balanceBefore).toBe(19050.25);
    expect(after.balance).toBe(round2(19050.25 - p.principal));
    expect(p.replacesDue).toBeUndefined();
  });

  it('a payment logged in place of an automatic one replaces it', () => {
    const paid = catchUpAutoPay({ ...card, autoPaidThrough: '2026-10-20' }, today, 'now').debt;
    const auto = paid.payments.find((p) => p.auto)!;
    expect(auto.date).toBe('2026-10-25');
    const { replaced, split } = previewPayment(paid, { amount: 200, date: '2026-10-27', note: '', replacesDue: '2026-10-25' }, today);
    expect(replaced?.id).toBe(auto.id);
    expect(split.balanceBefore).toBe(2300);
    const next = logPayment(paid, { amount: 200, date: '2026-10-27', note: '', replacesDue: '2026-10-25' }, today, 'now');
    expect(next.payments.some((p) => p.auto)).toBe(false);
    expect(next.balance).toBe(round2(2300 - split.principal));
  });

  it('editing or deleting a payment moves the balance by that payment only', () => {
    const one = logPayment(card, { amount: 400, date: '2026-11-02', note: '', replacesDue: undefined }, today, 'now');
    const id = one.payments[0].id;
    const edited = editPayment(one, id, { amount: 300, date: '2026-11-02', note: 'fixed' }, today);
    expect(edited.payments[0].amount).toBe(300);
    expect(edited.balance).toBe(round2(2300 - edited.payments[0].principal));
    expect(deletePayment(edited, id).balance).toBe(2300);
  });

  it('plans this month with the payment actually made, and keeps it after the loan is paid off', () => {
    const almost: Debt = { ...card, balance: 100, apr: 0, autoPaidThrough: '2026-11-20', payments: [] };
    const before = debtBillsForMonth('2026-11', [almost], '2026-11-20', ALL_FIXES);
    expect(before[0].amount).toBe(100);
    const paidOff = catchUpAutoPay(almost, '2026-11-25', 'now').debt;
    expect(paidOff.balance).toBe(0);
    const after = debtBillsForMonth('2026-11', [paidOff], '2026-11-25', ALL_FIXES);
    expect(after).toHaveLength(1);
    expect(after[0].amount).toBe(100);
    expect(debtBillsForMonth('2026-12', [paidOff], '2026-11-25', ALL_FIXES)).toHaveLength(0);
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

  it('keeps orders, maps neon/aurora themes to dark, and starts auto-pay from today', () => {
    const { data } = importV117(fixture('two-incomes'), '2026-11-06');
    expect(data.order.bills.slice(0, 3)).toEqual(['b3', 'b1', 'b2']);
    expect(data.prefs.theme).toBe('light');
    expect(importV117(fixture('tight-monthly'), '2026-11-06').data.prefs.theme).toBe('dark');
    expect(data.debts.every((d) => d.autoPay && d.autoPaidThrough === '2026-11-05')).toBe(true);
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
