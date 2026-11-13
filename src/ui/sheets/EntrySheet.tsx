import { fmtDow, fmtMonthLong, fmtRange, fmtShort, isoDate } from '../../engine/dates';
import { fmtMoney, round2 } from '../../engine/money';
import type { PlanEngine } from '../../engine/plan';
import { describeRule, paydayMoveTo } from '../../engine/schedule';
import { navigate } from '../../app/router';
import { closeAllSheets, openSheet } from '../../state/sheets';
import { paydayInfo, type Entry } from '../../state/models';
import { Sheet } from '../components/Sheet';
import { Amount, Money, Note } from '../components/bits';
import { openWhy } from './WhySheet';
import { MovePaydayForm } from './MovePaydaySheet';
import { IconChevronDown } from '../icons';

export function openEntry(engine: PlanEngine, e: Entry) {
  openSheet((close) => <EntrySheet engine={engine} e={e} onClose={close} />);
}

function go(to: string) {
  closeAllSheets();
  window.setTimeout(() => navigate(to), 60);
}

function EntrySheet({ engine, e, onClose }: { engine: PlanEngine; e: Entry; onClose: () => void }) {
  if (e.kind === 'payday') {
    const info = paydayInfo(engine, e.ms);
    return (
      <Sheet title="Payday" eyebrow={fmtDow(e.ms)} onClose={onClose}>
        {info && (
          <>
            <Money value={info.paycheck} size="lg" />
            <div className="formula">
              {info.sources.map((s) => <Line key={s.label} label={s.label} amount={s.amount} />)}
              <Line op="−" label="Move to Bills" amount={info.billsMove} onWhy={() => openWhy(engine, { kind: 'billsMove', mk: info.planMonth })} />
              <Line op="−" label="Move to Savings" amount={info.savingsMove} />
              <Line op="=" label="Spending money" sub={fmtRange(info.ms, info.periodEnd)} amount={info.spending} result onWhy={() => openWhy(engine, { kind: 'spending', paydayMs: info.ms })} />
            </div>
            {info.planned > 0 && (
              <div className="formula">
                <Line label="Spending money" amount={info.spending} />
                <Line op="−" label="Budgets this pay period" amount={info.planned} />
                <Line op="=" label="Free after budgets" amount={info.free} result onWhy={() => openWhy(engine, { kind: 'free', paydayMs: info.ms })} />
              </div>
            )}
            {info.minimum && <Note tone="warn">{fmtMoney(info.minimum.shortBy)} under your {fmtMoney(info.minimum.minimum)} minimum.</Note>}
            <p className="sub">Bills account after the move: {fmtMoney(e.billsAfter)} · Savings after: {fmtMoney(e.savingsAfter)}</p>
          </>
        )}
        <details className="disclosure" open={!!paydayMoveTo(isoDate(e.ms), engine.settings)}>
          <summary><span className="lbl">Paid on a different day?</span><IconChevronDown /></summary>
          <MovePaydayForm ms={e.ms} onDone={onClose} />
        </details>
      </Sheet>
    );
  }
  if (e.kind === 'adjust') {
    const mk = isoDate(e.ms).slice(0, 7);
    const plan = engine.plan(mk);
    const prevEnd = round2(plan.seedWanted - e.amount);
    const month = fmtMonthLong(mk).split(' ')[0];
    const extra = e.amount < 0;
    return (
      <Sheet title={e.title} eyebrow={fmtDow(e.ms)} onClose={onClose}>
        <Money value={Math.abs(e.amount)} size="lg" />
        <div className="formula">
          <div className="f-row"><span className="op" /><span><span className="strong">Bills account at the end of last month</span><span className="sub">What the plan leaves after last month's bills</span></span><span className="amt">{fmtMoney(prevEnd)}</span></div>
          <button type="button" className="f-row tap" onClick={() => openWhy(engine, { kind: 'needed', mk })}><span className="op">{extra ? '−' : '+'}</span><span><span className="strong">{month} only needs</span><span className="sub">Bills before the first payday + cushion</span></span><span className="amt">{fmtMoney(plan.seedWanted)}</span></button>
          <div className="f-row res"><span className="op">=</span><span className="strong">{extra ? 'Extra you can move out' : 'Amount to add'}</span><span className="amt">{fmtMoney(Math.abs(e.amount))}</span></div>
        </div>
        <p className="sub" style={{ fontSize: 14 }}>{extra
          ? `On ${fmtShort(e.ms)} the plan only counts what ${month} needs. Move this extra to checking or savings, or leave it in the Bills account as a buffer.`
          : `${month}'s early bills need more than last month leaves behind. Add this to the Bills account by ${fmtShort(e.ms)}.`}</p>
      </Sheet>
    );
  }
  if (e.kind === 'withdrawal') {
    const ev = engine.data.events.find((x) => x.id === e.itemId);
    return (
      <Sheet title={e.title} eyebrow="Planned savings withdrawal" onClose={onClose}
        footer={<button type="button" className="btn ghost" onClick={() => go('/plan/savings')}>Open Savings</button>}>
        <Money value={-e.amount} size="lg" />
        <dl className="kv">
          <dt>Date</dt><dd>{fmtDow(e.ms)}</dd>
          {ev && <><dt>Repeats</dt><dd>{describeRule(ev.rule)}</dd></>}
          <dt>Savings after</dt><dd>{fmtMoney(e.savingsAfter)}</dd>
        </dl>
        <p className="sub">Withdrawals come out of Savings only. They don't touch the Bills account or your spending money.</p>
      </Sheet>
    );
  }
  const bill = engine.data.bills.find((b) => b.id === e.itemId);
  const loan = e.debtId ? engine.data.debts.find((d) => d.id === e.debtId) : undefined;
  return (
    <Sheet title={e.title} eyebrow={loan ? 'Loan payment' : 'Bill'} onClose={onClose}
      footer={loan
        ? <button type="button" className="btn ghost" onClick={() => go(`/plan/loans/${loan.id}`)}>Open loan</button>
        : <button type="button" className="btn ghost" onClick={() => go(`/plan/bills/${e.itemId}`)}>Edit bill</button>}>
      <Money value={-e.amount} size="lg" />
      <dl className="kv">
        <dt>Due</dt><dd>{fmtDow(e.ms)}</dd>
        <dt>Repeats</dt><dd>{loan ? `Monthly on day ${loan.dueDay}` : bill ? describeRule(bill.rule) : '—'}</dd>
        <dt>Bills account after</dt><dd><Amount value={e.billsAfter} /></dd>
      </dl>
      <p className="sub">Paid from the Bills account. The payday moves are planned so the account covers this and stays above your {fmtMoney(engine.settings.cushion)} cushion.</p>
    </Sheet>
  );
}

function Line({ op, label, sub, amount, result, onWhy }: { op?: string; label: string; sub?: string; amount: number; result?: boolean; onWhy?: () => void }) {
  const content = (
    <>
      <span className="op" aria-hidden="true">{op}</span>
      <span><span className="strong">{label}</span>{sub && <span className="sub">{sub}</span>}</span>
      <span className="amt">{fmtMoney(amount)}</span>
    </>
  );
  return onWhy
    ? <button type="button" className={`f-row tap${result ? ' res' : ''}`} onClick={onWhy}>{content}</button>
    : <div className={`f-row${result ? ' res' : ''}`}>{content}</div>;
}
