import type { ReactNode } from 'react';
import { addMonthsKey, fmtDow, fmtMonthLong, fmtRange, fmtShort, monthIndex, parseISOToMs, parseMonthKey, monthLong, type MonthKey } from '../../engine/dates';
import { fmtMoney, round2 } from '../../engine/money';
import type { PlanEngine } from '../../engine/plan';
import { occurrencesForRange } from '../../engine/schedule';
import { snapshotForRange } from '../../engine/spending';
import { openSheet } from '../../state/sheets';
import { paydayInfo, rowAt, lowestBetween } from '../../state/models';
import { Sheet } from '../components/Sheet';
import { Money, Note } from '../components/bits';

export type WhyTopic =
  | { kind: 'billsToday' }
  | { kind: 'billsMove'; mk: MonthKey }
  | { kind: 'spending'; paydayMs: number }
  | { kind: 'free'; paydayMs: number }
  | { kind: 'leftToSpend'; startMs: number; endMs: number }
  | { kind: 'savingsToday' }
  | { kind: 'needed'; mk: MonthKey };

function Row({ op, label, sub, amount, result }: { op?: string; label: ReactNode; sub?: ReactNode; amount: number; result?: boolean }) {
  return (
    <div className={`f-row${result ? ' res' : ''}`}>
      <span className="op" aria-hidden="true">{op}</span>
      <span><span className="strong">{label}</span>{sub && <span className="sub">{sub}</span>}</span>
      <span className="amt">{fmtMoney(amount)}</span>
    </div>
  );
}

const list = (names: string[], max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);
const mname = (mk: MonthKey) => monthLong(parseMonthKey(mk).m);

export function openWhy(engine: PlanEngine, topic: WhyTopic) {
  openSheet((close) => <WhySheet engine={engine} topic={topic} onClose={close} />);
}

function WhySheet({ engine, topic, onClose }: { engine: PlanEngine; topic: WhyTopic; onClose: () => void }) {
  const s = engine.settings;
  const today = engine.today();
  const todayMs = parseISOToMs(today);
  let title = '', value = 0, body: ReactNode = null;

  if (topic.kind === 'billsToday' || topic.kind === 'needed') {
    const mk = topic.kind === 'needed' ? topic.mk : today.slice(0, 7);
    const plan = engine.plan(mk);
    const firstPay = plan.paydays[0];
    if (topic.kind === 'needed') {
      title = `Needed on ${fmtShort(plan.monthStart)}`;
      value = plan.seedWanted;
      body = (
        <div className="formula">
          <Row label="Bills before the first payday" sub={firstPay ? `Due before ${fmtDow(firstPay)}` : 'No payday this month'} amount={plan.prePaycheckTotal} />
          <Row op="+" label="Cushion" sub="Your safety buffer" amount={s.cushion} />
          {plan.extraFunding > 0.009 && <Row op="+" label="Extra the paychecks can't cover" amount={plan.extraFunding} />}
          <Row op="=" label={`Should have on ${fmtShort(plan.monthStart)}`} amount={plan.seedWanted} result />
        </div>
      );
    } else {
      const rows = plan.rows.filter((r) => r.ms <= todayMs);
      const inMoves = round2(rows.reduce((t, r) => t + r.transferIn, 0));
      const billsPaid = round2(rows.reduce((t, r) => t + r.billsOut, 0));
      const names = rows.flatMap((r) => r.bills.map((b) => b.name));
      const payDates = rows.filter((r) => r.isPayday).map((r) => fmtShort(r.ms));
      title = 'Bills account should have today';
      value = rowAt(engine, todayMs)?.billsBalanceWorking ?? 0;
      body = (
        <>
          <div className="formula">
            <Row label={`Should have on ${fmtShort(plan.monthStart)}`} sub={`Bills before ${firstPay ? fmtShort(firstPay) : 'month end'} + ${fmtMoney(s.cushion)} cushion${plan.extraFunding > 0.009 ? ' + extra' : ''}`} amount={plan.seedWanted} />
            <Row op="+" label="Moved in on paydays" sub={payDates.length ? payDates.join(', ') : 'No payday yet this month'} amount={inMoves} />
            <Row op="−" label="Bills paid so far" sub={names.length ? list(names) : 'None yet'} amount={billsPaid} />
            <Row op="=" label="Should have today" sub={fmtDow(todayMs)} amount={value} result />
          </div>
          <Note tone="info">This is the plan's number. If your bank shows more, the extra is yours to move to checking or savings. If it shows less, a bill probably came in higher than planned, so top it up to keep upcoming bills covered.</Note>
        </>
      );
    }
  } else if (topic.kind === 'billsMove') {
    const plan = engine.plan(topic.mk);
    const nextMk = addMonthsKey(topic.mk, 1);
    const nextPlan = engine.plan(nextMk);
    const N = plan.paydays.length;
    const billCount = plan.rows.reduce((t, r) => t + r.bills.length, 0);
    const loanCount = plan.rows.reduce((t, r) => t + r.bills.filter((b) => b.debtId).length, 0);
    const low = lowestBetween(engine, plan.monthStart, plan.monthEnd);
    title = 'Move to Bills each payday';
    value = plan.billsPerPaycheck;
    body = (
      <>
        <div className="formula">
          <Row label={`${mname(topic.mk)}'s bills`} sub={`${billCount - loanCount} bill payment${billCount - loanCount === 1 ? '' : 's'}${loanCount ? ` + ${loanCount} loan payment${loanCount === 1 ? '' : 's'}` : ''}`} amount={plan.TB1} />
          <Row op="+" label={`Carry into ${mname(nextMk)}`} sub={`Bills before ${nextPlan.paydays[0] ? fmtShort(nextPlan.paydays[0]) : 'its first payday'}, plus ${fmtMoney(s.cushion)} cushion`} amount={plan.TargetCarry} />
          <Row op="−" label={`Already there on ${fmtShort(plan.monthStart)}`} sub="Bills before the first payday, plus cushion" amount={plan.AS2} />
          <Row op="÷" label={`${N} payday${N === 1 ? '' : 's'}`} sub={plan.paydays.map((p) => fmtShort(p)).join(' and ')} amount={plan.nominalBillsPerPaycheck} result />
        </div>
        {plan.minBillsPerPaycheckForCushion > plan.nominalBillsPerPaycheck + 0.004 && (
          <Note tone="info">To stay above your {fmtMoney(s.cushion)} cushion on every day of the month, each payday has to move at least {fmtMoney(plan.minBillsPerPaycheckForCushion)}, so that's used instead.</Note>
        )}
        {plan.billsPerPaycheck < plan.desiredBillsPerPaycheck - 0.004 && (
          <Note tone="bad">Capped at {fmtMoney(plan.billsPerPaycheck)}: your smallest paycheck this month ({fmtMoney(plan.minPayCap)}) minus the Savings move.</Note>
        )}
        {plan.extraFunding > 0.009 && (
          <Note tone="bad">Even so, the account needs {fmtMoney(plan.extraFunding)} more at the start of {mname(topic.mk)} to cover everything.</Note>
        )}
        {low && (low.amount >= s.cushion - 0.009
          ? <Note tone="ok">Never drops below your cushion. Lowest point is {fmtMoney(low.amount)} on {fmtDow(low.ms)}.</Note>
          : <Note tone="warn">Dips to {fmtMoney(low.amount)} on {fmtDow(low.ms)}, under your cushion.</Note>)}
      </>
    );
  } else if (topic.kind === 'spending' || topic.kind === 'free') {
    const info = paydayInfo(engine, topic.paydayMs);
    if (info) {
      const occ = occurrencesForRange(info.ms, info.periodEnd, engine.data.extras, s);
      const budgets = new Map<string, { name: string; amount: number }>();
      for (const items of occ.values()) for (const it of items) {
        const b = budgets.get(it.id) || { name: it.name, amount: 0 };
        b.amount = round2(b.amount + Number(it.amount || 0));
        budgets.set(it.id, b);
      }
      const spendingRows = (
        <>
          {info.sources.length > 1
            ? info.sources.map((src, i) => <Row key={src.label} op={i ? '+' : undefined} label={src.label} amount={src.amount} />)
            : <Row label="Paycheck" sub={fmtDow(info.ms)} amount={info.paycheck} />}
          <Row op="−" label="Move to Bills" amount={info.billsMove} />
          <Row op="−" label="Move to Savings" amount={info.savingsMove} />
        </>
      );
      if (topic.kind === 'spending') {
        title = 'Spending money this paycheck';
        value = info.spending;
        body = <div className="formula">{spendingRows}<Row op="=" label="Spending money" sub={fmtRange(info.ms, info.periodEnd)} amount={info.spending} result /></div>;
      } else {
        title = 'Free after budgets';
        value = info.free;
        body = (
          <>
            <div className="formula">
              <Row label="Spending money" sub={fmtRange(info.ms, info.periodEnd)} amount={info.spending} />
              {[...budgets.values()].map((b) => <Row key={b.name} op="−" label={b.name} sub="Budget" amount={b.amount} />)}
              <Row op="=" label="Free after budgets" amount={info.free} result />
            </div>
            {info.minimum && <Note tone="warn">That's {fmtMoney(info.minimum.shortBy)} under your {fmtMoney(info.minimum.minimum)} minimum{info.minimum.mode === 'base' ? ' for spending money' : ''}.</Note>}
          </>
        );
      }
    }
  } else if (topic.kind === 'leftToSpend') {
    const snap = snapshotForRange(engine, topic.startMs, topic.endMs);
    const unassigned = snap.items.find((x) => x.id === '__misc__');
    const budgets = round2(snap.totals.budget - (unassigned?.budget || 0));
    title = 'Left to spend';
    value = snap.totals.remaining;
    body = (
      <>
        <div className="formula">
          <Row label="Your budgets" sub={fmtRange(topic.startMs, topic.endMs)} amount={budgets} />
          <Row op="+" label="Unassigned" sub="Spending money not in a budget" amount={unassigned?.budget || 0} />
          <Row op="−" label="Logged spending" sub="Refunds add back" amount={snap.totals.spent} />
          <Row op="=" label="Left to spend" amount={snap.totals.remaining} result />
        </div>
        <Note tone="info">Only what you log counts as spent. If you don't track purchases, this is simply the spending money for the pay period.</Note>
      </>
    );
  } else if (topic.kind === 'savingsToday') {
    const mk = today.slice(0, 7);
    const plan = engine.plan(mk);
    const trueMonth = s.trueSavingsMonth || mk;
    const months = monthIndex(mk) - monthIndex(trueMonth);
    const rows = plan.rows.filter((r) => r.ms <= todayMs);
    const adds = round2(rows.reduce((t, r) => t + r.savingsIn, 0));
    const outs = round2(rows.reduce((t, r) => t + r.savingsOut, 0));
    let withdrawalsBefore = 0;
    for (let i = 0; i < months; i++) withdrawalsBefore += engine.eventsTotal(addMonthsKey(trueMonth, i));
    title = 'Savings should have today';
    value = rowAt(engine, todayMs)?.savingsBalance ?? 0;
    body = (
      <div className="formula">
        <Row label={`Balance on ${fmtShort(parseISOToMs(`${trueMonth}-01`))}`} sub="The savings balance you entered" amount={s.baseSavingsBalance} />
        {months > 0 && <Row op="+" label={`${months} month${months === 1 ? '' : 's'} of savings`} sub={`${fmtMoney(s.savings.monthlyGoal)} a month`} amount={round2(months * s.savings.monthlyGoal)} />}
        {withdrawalsBefore > 0 && <Row op="−" label="Planned withdrawals" sub={`Before ${fmtMonthLong(mk)}`} amount={round2(withdrawalsBefore)} />}
        <Row op="+" label="Moved in this month" sub="Payday savings moves so far" amount={adds} />
        {outs > 0 && <Row op="−" label="Withdrawn this month" amount={outs} />}
        <Row op="=" label="Should have today" sub={fmtDow(todayMs)} amount={value} result />
      </div>
    );
  }

  return (
    <Sheet title={title} eyebrow="Why this number?" onClose={onClose}>
      <Money value={value} size="lg" />
      {body}
    </Sheet>
  );
}
