import { useMemo, useState } from 'react';
import { fmtDow, fmtMedium, fmtMonthLong, fmtShort, isValidIso, parseISOToMs, type IsoDate } from '../../../engine/dates';
import { clampInt, fmtMoney, round2 } from '../../../engine/money';
import {
  applyMissedPayments, deletePayment, editPayment, interestPaidSoFar, lastPaymentDate, loanOutlook, logPayment,
  missedDueDates, monthsLabel, newId, nextUnpaidDue, orderDebts, paidSoFar, paymentPrincipal, percentPaid, previewPayment,
  scheduledAmount, setBalance, type LoanOutlook,
} from '../../../engine/loans';
import type { Debt, DebtPayment, DebtStrategy } from '../../../engine/types';
import { navigate } from '../../../app/router';
import { openSheet } from '../../../state/sheets';
import { update, useActive, useStore } from '../../../state/store';
import { toast } from '../../../state/toast';
import { Sheet } from '../../components/Sheet';
import { Amount, Chip, Meter, Money, Note } from '../../components/bits';
import { DateInput, Field, MoneyInput, NumberInput, Segmented, Switch, TextInput } from '../../components/controls';
import { IconCard, IconCheckCircle, IconEdit, IconPlus, IconTrash } from '../../icons';
import { moveInOrder, ordinal, PlanHeader, ReorderList, useOpenOnRoute } from './common';

const STRATEGIES: Array<{ value: DebtStrategy; label: string }> = [
  { value: 'avalanche', label: 'Highest rate' },
  { value: 'snowball', label: 'Smallest balance' },
  { value: 'custom', label: 'My order' },
];

const payoffText = (o: LoanOutlook) => (o.payoffMk === null ? 'Payment too low to pay it off' : o.payoffMk ? `Paid off ${fmtMonthLong(o.payoffMk)}` : 'Paid off');

function setDebt(id: string, fn: (d: Debt) => Debt, opts: { undo?: string } = {}) {
  update((data) => { data.debts = data.debts.map((x) => (x.id === id ? fn(x) : x)); }, opts);
}

export function LoansPage({ sub }: { sub?: string }) {
  if (sub && sub !== 'new') return <LoanDetail id={sub} />;
  return <LoansList openNew={sub === 'new'} />;
}

function LoansList({ openNew }: { openNew: boolean }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const strategy = data.prefs.debtStrategy;
  useOpenOnRoute(openNew, '/plan/loans', () => openLoanEditor());

  const active = orderDebts(data.debts.filter((d) => d.balance > 0), strategy);
  const done = data.debts.filter((d) => d.balance <= 0);
  const outlooks = useMemo(() => new Map(data.debts.map((d) => [d.id, loanOutlook(d, today)])), [data.debts, today]);
  const owed = round2(active.reduce((t, d) => t + d.balance, 0));
  const monthly = round2(active.reduce((t, d) => t + scheduledAmount(d), 0));
  const interestLeft = round2(active.reduce((t, d) => t + (Number.isFinite(outlooks.get(d.id)!.interestLeft) ? outlooks.get(d.id)!.interestLeft : 0), 0));
  const stuck = active.some((d) => outlooks.get(d.id)!.payoffMk === null);
  const debtFree = stuck ? null : active.reduce((m, d) => { const p = outlooks.get(d.id)!.payoffMk; return p && p > m ? p : m; }, '');

  const reorder = (from: number, to: number) => update((d) => {
    const ids = moveInOrder(active.map((x) => x.id), active.map((x) => x.id), from, to);
    d.debts = d.debts.map((x) => (ids.includes(x.id) ? { ...x, priority: ids.indexOf(x.id) + 1 } : x));
    d.prefs.debtStrategy = 'custom';
  });

  return (
    <div className="page page-narrow">
      <PlanHeader title="Loans" action={<button type="button" className="btn sm" onClick={() => openLoanEditor()}><IconPlus />Add</button>} />
      {active.length > 0 && (
        <section className="card">
          <div className="stat-row">
            <div><span className="lbl">Owed</span><Money value={owed} size="md" /></div>
            <div className="right"><span className="lbl">Debt-free</span><span className="strong big-t">{debtFree === null ? 'Not yet' : debtFree ? fmtMonthLong(debtFree) : '—'}</span></div>
          </div>
          <div className="kv">
            <dt>Monthly payments</dt><dd>{fmtMoney(monthly)}</dd>
            <dt>Interest still to pay</dt><dd>{fmtMoney(interestLeft)}</dd>
          </div>
        </section>
      )}

      {data.debts.length === 0 && (
        <section className="card">
          <div className="empty"><IconCard /><div className="t">No loans</div><div className="t-sm">Add a car loan, student loan or card balance. Its payment is planned as a bill, and the balance goes down by itself on each due date.</div></div>
          <button type="button" className="btn" onClick={() => openLoanEditor()}><IconPlus />Add a loan</button>
        </section>
      )}

      {active.length > 1 && (
        <section className="card">
          <span className="lbl">Order</span>
          <Segmented label="Loan order" value={strategy} options={STRATEGIES} onChange={(v) => update((d) => { d.prefs.debtStrategy = v; }, { real: true })} />
          <p className="sub">This only changes the order below, so you know which loan to put extra money toward first. To pay one off sooner, raise its extra payment.</p>
        </section>
      )}

      {active.length > 0 && (
        <section className="card flush">
          <ReorderList items={active} idOf={(d) => d.id} enabled={strategy === 'custom' && active.length > 1} label="Loans" onMove={reorder}
            row={(d, handle) => {
              const o = outlooks.get(d.id)!;
              const missed = missedDueDates(d, today).length > 0;
              return (
                <div className={`row ${handle ? 'with-handle' : 'no-lead'}`}>
                  {handle}
                  <button type="button" className="row-tap loan-row" onClick={() => navigate(`/plan/loans/${d.id}`)}>
                    <span className="main-col">
                      <span className="title">{d.name}{missed && <Chip tone="warn">Check balance</Chip>}</span>
                      <Meter pct={percentPaid(d)} tone="good" label={`${d.name} paid off`} />
                      <span className="sub">{payoffText(o)}{Number.isFinite(o.monthsLeft) && o.monthsLeft > 0 ? ` · ${monthsLabel(o.monthsLeft)}` : ''}</span>
                      {o.nextDue && <span className="sub">Next {fmtShort(parseISOToMs(o.nextDue))} · {fmtMoney(o.nextAmount)}{d.autoPay ? ' · automatic' : ''}</span>}
                    </span>
                    <span className="trail"><Amount value={d.balance} /><span className="sub">{d.apr}% APR</span></span>
                  </button>
                </div>
              );
            }} />
        </section>
      )}

      {done.length > 0 && (
        <section className="card flush">
          <div className="pad"><span className="lbl">Paid off</span></div>
          <div className="list">
            {done.map((d) => (
              <button key={d.id} type="button" className="row" onClick={() => navigate(`/plan/loans/${d.id}`)}>
                <span className="icon-badge s"><IconCheckCircle /></span>
                <span className="main-col"><span className="title">{d.name}</span><span className="sub">{lastPaymentDate(d) ? `Last payment ${fmtMedium(parseISOToMs(lastPaymentDate(d) as IsoDate))}` : 'Paid off'}</span></span>
                <span className="trail"><span className="sub">{fmtMoney(paidSoFar(d))} paid</span></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LoanDetail({ id }: { id: string }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const d = data.debts.find((x) => x.id === id);
  const [showAll, setShowAll] = useState(false);
  const o = useMemo(() => (d ? loanOutlook(d, today) : null), [d, today]);
  if (!d || !o) {
    return (
      <div className="page page-narrow">
        <PlanHeader title="Loan" back="/plan/loans" backLabel="Loans" />
        <section className="card"><p className="sub">This loan isn't here anymore.</p></section>
      </div>
    );
  }
  const missed = missedDueDates(d, today);
  const history = [...d.payments].sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const upcoming = showAll ? o.schedule.payments : o.schedule.payments.slice(0, 6);
  const daily = !!d.interestStartDate;
  const remove = () => {
    update((x) => { x.debts = x.debts.filter((y) => y.id !== d.id); }, { undo: `${d.name} deleted` });
    navigate('/plan/loans');
  };

  return (
    <div className="page page-narrow">
      <PlanHeader title={d.name} back="/plan/loans" backLabel="Loans"
        action={<button type="button" className="icon-btn" aria-label="Edit loan" onClick={() => openLoanEditor(d)}><IconEdit /></button>} />

      <section className="card">
        <span className="lbl">Balance</span>
        <Money value={d.balance} size="lg" />
        <Meter pct={percentPaid(d)} tone="good" label="Paid off so far" />
        <span className="sub">{Math.round(percentPaid(d))}% paid · {payoffText(o)}{Number.isFinite(o.monthsLeft) && o.monthsLeft > 0 ? ` (${monthsLabel(o.monthsLeft)})` : ''}</span>
      </section>

      {missed.length > 0 && (
        <Note tone="warn" action={
          <div className="btn-row">
            <button type="button" className="btn sm" onClick={() => {
              setDebt(d.id, (x) => applyMissedPayments(x, today).debt, { undo: `Recorded ${missed.length} payment${missed.length === 1 ? '' : 's'}` });
            }}>Yes, record {missed.length === 1 ? 'it' : 'them'}</button>
            <button type="button" className="btn sm ghost" onClick={() => openLoanEditor(d, true)}>Enter balance</button>
          </div>
        }>
          No payment is logged since {fmtMedium(parseISOToMs(lastPaymentDate(d) as IsoDate))}. Did you make the {missed.map((x) => fmtShort(parseISOToMs(x))).join(' and ')} payment{missed.length === 1 ? '' : 's'} of {fmtMoney(scheduledAmount(d))}? Or enter the balance your lender shows.
        </Note>
      )}

      {d.balance > 0 && (
        <section className="card">
          <div className="card-head"><span className="lbl">Next payment</span>{o.nextDue && <span className="sub">{fmtDow(parseISOToMs(o.nextDue))}</span>}</div>
          {o.schedule.payments[0] ? (
            <div className="kv">
              <dt>Payment</dt><dd>{fmtMoney(o.schedule.payments[0].amount)}</dd>
              <dt>Interest</dt><dd>{fmtMoney(o.schedule.payments[0].interest)}</dd>
              <dt>Toward the balance</dt><dd>{fmtMoney(o.schedule.payments[0].principal)}</dd>
              <dt>Balance after</dt><dd>{fmtMoney(o.schedule.payments[0].balanceAfter)}</dd>
            </div>
          ) : <p className="sub">{scheduledAmount(d) > 0 ? "The payment doesn't cover the interest, so the balance won't go down. Raise the payment to pay it off." : 'No payment is set for this loan.'}</p>}
          <div className="field-row">
            <div className="grow"><div className="t">Apply it automatically</div><div className="sub">{d.autoPay ? `On each due date the app assumes you paid ${fmtMoney(scheduledAmount(d))} and lowers the balance.` : "You'll log each payment yourself."}</div></div>
            <Switch checked={d.autoPay} label="Apply payments automatically" onChange={(v) => setDebt(d.id, (x) => ({ ...x, autoPay: v, autoPaidThrough: today }))} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => openLogPayment(d.id)}><IconPlus />Log a payment</button>
          </div>
          <p className="sub">Only log a payment when it's extra or different from the plan.</p>
        </section>
      )}

      <section className="card">
        <span className="lbl">Details</span>
        <dl className="kv">
          <dt>Monthly payment</dt><dd>{fmtMoney(scheduledAmount(d))}{d.extraPayment > 0 ? <span className="sub block">{fmtMoney(d.minPayment)} + {fmtMoney(d.extraPayment)} extra</span> : null}</dd>
          <dt>Due</dt><dd>{d.dueDay >= 31 ? 'Last day' : ordinal(d.dueDay)} of the month</dd>
          <dt>Interest rate</dt><dd>{d.apr}% APR</dd>
          <dt>Interest</dt><dd>{daily ? <>Daily<span className="sub block">counted from {fmtMedium(parseISOToMs(d.interestStartDate as IsoDate))}</span></> : 'Monthly'}</dd>
          <dt>Interest still to pay</dt><dd>{Number.isFinite(o.interestLeft) ? fmtMoney(o.interestLeft) : '—'}</dd>
          <dt>Paid off so far</dt><dd>{fmtMoney(paidSoFar(d))}</dd>
          <dt>Interest paid so far</dt><dd>{fmtMoney(interestPaidSoFar(d))}</dd>
          <dt>Starting balance</dt><dd>{fmtMoney(Math.max(d.originalBalance, d.balance))}</dd>
        </dl>
      </section>

      {o.schedule.payments.length > 0 && (
        <section className="card flush">
          <div className="card-head pad"><span className="lbl">Payments ahead</span><span className="sub">{o.schedule.payments.length} left</span></div>
          <div className="list">
            {upcoming.map((p, i) => (
              <div key={p.dueIso} className="row no-lead">
                <span className="main-col"><span className="title">{fmtMedium(parseISOToMs(p.dueIso))}{i === o.schedule.payments.length - 1 && <Chip tone="good">Final</Chip>}</span><span className="sub">{fmtMoney(p.interest)} interest · {fmtMoney(p.principal)} to balance</span></span>
                <span className="trail"><Amount value={p.amount} /><span className="sub">{fmtMoney(p.balanceAfter)} left</span></span>
              </div>
            ))}
          </div>
          {o.schedule.payments.length > 6 && <button type="button" className="link-btn pad" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${o.schedule.payments.length}`}</button>}
        </section>
      )}

      <section className="card flush">
        <div className="card-head pad"><span className="lbl">Payment history</span><span className="sub">{history.length}</span></div>
        {history.length ? (
          <div className="list">
            {history.map((p) => (
              <button key={p.id} type="button" className="row no-lead" onClick={() => openEditPayment(d.id, p.id)}>
                <span className="main-col">
                  <span className="title">{fmtMedium(parseISOToMs(p.date))}{p.auto ? <Chip>Automatic</Chip> : p.replacesDue ? <Chip>For {fmtShort(parseISOToMs(p.replacesDue))}</Chip> : p.extra ? <Chip tone="good">Extra</Chip> : null}</span>
                  <span className="sub">{fmtMoney(paymentPrincipal(p))} to balance · {fmtMoney(p.interest)} interest{p.note ? ` · ${p.note}` : ''}</span>
                </span>
                <span className="trail"><Amount value={p.amount} /><span className="sub">{fmtMoney(p.balanceAfter)} left</span></span>
              </button>
            ))}
          </div>
        ) : <p className="sub pad">No payments yet.</p>}
      </section>

      <button type="button" className="btn ghost danger-t" onClick={remove}><IconTrash />Delete this loan</button>
    </div>
  );
}

// ---------- editor ----------

export function openLoanEditor(d?: Debt, focusBalance = false) {
  openSheet((close) => <LoanEditor debt={d} focusBalance={focusBalance} onClose={close} />);
}

function LoanEditor({ debt, focusBalance, onClose }: { debt?: Debt; focusBalance: boolean; onClose: () => void }) {
  const today = useStore((s) => s.today);
  const data = useActive();
  const [name, setName] = useState(debt?.name ?? '');
  const [balance, setBal] = useState<number>(debt ? debt.balance : NaN);
  const [apr, setApr] = useState<number>(debt ? debt.apr : NaN);
  const [minPay, setMin] = useState<number>(debt ? debt.minPayment : NaN);
  const [extra, setExtra] = useState<number>(debt ? debt.extraPayment : 0);
  const [dueDay, setDue] = useState<number>(debt ? debt.dueDay : Number(today.slice(8, 10)));
  const [daily, setDaily] = useState<boolean>(debt ? !!debt.interestStartDate : false);
  const [from, setFrom] = useState<IsoDate>(debt?.interestStartDate || today);
  const [autoPay, setAuto] = useState<boolean>(debt ? debt.autoPay : true);
  const valid = name.trim().length > 0 && Number.isFinite(balance) && balance >= 0 && Number.isFinite(apr) && apr >= 0 && Number.isFinite(minPay) && minPay >= 0 && (!daily || isValidIso(from));
  const preview = valid ? loanOutlook({
    ...(debt ?? { id: 'x', payments: [], originalBalance: balance, priority: data.debts.length + 1, autoPaidThrough: today }),
    name, balance: round2(balance), apr: round2(apr), minPayment: round2(minPay), extraPayment: round2(Number.isFinite(extra) ? extra : 0),
    dueDay: clampInt(dueDay, 1, 31), interestStartDate: daily ? from : '', autoPay,
  } as Debt, today) : null;

  const save = () => {
    const fields = {
      name: name.trim(), apr: round2(apr), minPayment: round2(minPay), extraPayment: round2(Number.isFinite(extra) ? extra : 0),
      dueDay: clampInt(dueDay, 1, 31), interestStartDate: daily ? from : '', autoPay,
    };
    if (debt) {
      setDebt(debt.id, (x) => {
        let next: Debt = { ...x, ...fields, autoPaidThrough: autoPay && !x.autoPay ? today : x.autoPaidThrough };
        if (Math.abs(round2(balance) - x.balance) > 0.004) next = setBalance(next, balance, today);
        return next;
      }, { undo: 'Loan saved' });
    } else {
      const b = round2(balance);
      const d: Debt = {
        id: newId('d'), ...fields, balance: b, originalBalance: b, priority: data.debts.length + 1, payments: [],
        autoPaidThrough: today, balanceAsOf: today,
      };
      update((x) => { x.debts = [...x.debts, d]; }, { undo: `${d.name} added` });
      toast(`Its ${fmtMoney(scheduledAmount(d))} payment is now planned as a bill on the ${ordinal(d.dueDay)}.`);
    }
    onClose();
  };

  return (
    <Sheet title={debt ? 'Edit loan' : 'New loan'} onClose={onClose} footer={<button type="button" className="btn" disabled={!valid} onClick={save}>{debt ? 'Save' : 'Add loan'}</button>}>
      <div className="fields">
        <Field label="Name">{(id) => <TextInput id={id} value={name} onChange={setName} placeholder="Car loan" autoFocus={!debt} />}</Field>
        <div className="fields two">
          <Field label="Balance today" hint={debt ? 'Change it to match your lender' : undefined}>{(id) => <MoneyInput id={id} value={Number.isFinite(balance) ? balance : null} onChange={setBal} autoFocus={focusBalance} />}</Field>
          <Field label="Interest rate (APR %)">{(id) => <MoneyInput id={id} value={Number.isFinite(apr) ? apr : null} onChange={setApr} placeholder="0.00" />}</Field>
        </div>
        <div className="fields two">
          <Field label="Monthly payment">{(id) => <MoneyInput id={id} value={Number.isFinite(minPay) ? minPay : null} onChange={setMin} />}</Field>
          <Field label="Extra each month" hint="Optional">{(id) => <MoneyInput id={id} value={Number.isFinite(extra) ? extra : 0} onChange={setExtra} />}</Field>
        </div>
        <Field label="Due day" hint="Day of the month">{(id) => <NumberInput id={id} value={dueDay} min={1} max={31} onChange={setDue} />}</Field>
      </div>
      <div className="field"><span className="lbl">Interest</span>
        <Segmented label="How interest is counted" value={daily ? 'daily' : 'monthly'} onChange={(v) => setDaily(v === 'daily')}
          options={[{ value: 'monthly', label: 'Monthly (APR ÷ 12)' }, { value: 'daily', label: 'Daily (by days between payments)' }]} />
      </div>
      {daily && <Field label="Counting interest from" hint="Usually the loan's start date or your last statement">{(id) => <DateInput id={id} value={from} onChange={setFrom} />}</Field>}
      <div className="field-row">
        <div className="grow"><div className="t">Apply payments automatically</div><div className="sub">Lowers the balance on each due date.</div></div>
        <Switch checked={autoPay} label="Apply payments automatically" onChange={setAuto} />
      </div>
      {preview && <Note tone={preview.payoffMk === null ? 'warn' : 'info'}>{preview.payoffMk === null ? "This payment doesn't cover the interest, so it would never be paid off." : `${payoffText(preview)} · ${fmtMoney(Number.isFinite(preview.interestLeft) ? preview.interestLeft : 0)} interest left to pay.`}</Note>}
    </Sheet>
  );
}

// ---------- payments ----------

export function openLogPayment(debtId: string) {
  openSheet((close) => <LogPaymentSheet debtId={debtId} onClose={close} />);
}

function LogPaymentSheet({ debtId, onClose }: { debtId: string; onClose: () => void }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const d = data.debts.find((x) => x.id === debtId);
  const [amount, setAmount] = useState<number>(d ? scheduledAmount(d) : NaN);
  const [date, setDate] = useState<IsoDate>(today);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'extra' | 'instead'>('extra');
  // Which scheduled payment this one can stand in for: a recent automatic one, or the next one due.
  const recentAuto = d ? [...d.payments].filter((p) => p.auto && p.date <= today && (parseISOToMs(today) - parseISOToMs(p.date)) / 86400000 <= 45).sort((a, b) => b.date.localeCompare(a.date))[0] : undefined;
  const nextDue = d ? nextUnpaidDue(d, today) : today;
  const options = [...(recentAuto ? [recentAuto.date] : []), ...(nextDue !== recentAuto?.date ? [nextDue] : [])];
  const [due, setDue] = useState<IsoDate>(options[0] || nextDue);
  if (!d) return <Sheet title="Log a payment" onClose={onClose}><p className="sub">This loan isn't here anymore.</p></Sheet>;

  const draft = { amount: round2(amount), date, note, replacesDue: kind === 'instead' ? due : undefined };
  const ok = Number.isFinite(amount) && amount > 0 && isValidIso(date);
  const pv = ok ? previewPayment(d, draft, today) : null;

  const save = () => {
    setDebt(d.id, (x) => logPayment(x, draft, today), { undo: `${fmtMoney(pv?.split.amount ?? amount)} payment logged` });
    onClose();
  };
  return (
    <Sheet title="Log a payment" eyebrow={d.name} onClose={onClose} footer={<button type="button" className="btn" disabled={!ok || !pv || pv.split.amount <= 0} onClick={save}>Log payment</button>}>
      <div className="fields two">
        <Field label="Amount">{(id) => <MoneyInput id={id} value={Number.isFinite(amount) ? amount : null} onChange={setAmount} autoFocus />}</Field>
        <Field label="Paid on">{(id) => <DateInput id={id} value={date} onChange={setDate} max={today} />}</Field>
      </div>
      <div className="field"><span className="lbl">This payment is</span>
        <Segmented label="Payment type" value={kind} onChange={setKind} options={[{ value: 'extra', label: 'Extra, on top of the plan' }, { value: 'instead', label: 'Instead of a scheduled one' }]} />
      </div>
      {kind === 'instead' && (
        <div className="chips" role="radiogroup" aria-label="Scheduled payment it replaces">
          {options.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={due === x} className={`cp ${due === x ? 'on' : ''}`} onClick={() => setDue(x)}>
              {x === recentAuto?.date ? `The ${fmtShort(parseISOToMs(x))} automatic payment` : `The one due ${fmtShort(parseISOToMs(x))}`}
            </button>
          ))}
        </div>
      )}
      {pv && (
        <div className="formula">
          {pv.replaced && <div className="f-row"><span className="op">↺</span><span>Replaces the automatic {fmtMoney(pv.replaced.amount)} on {fmtShort(parseISOToMs(pv.replaced.date))}</span><span /></div>}
          <div className="f-row"><span className="op" /><span>Interest</span><span className="amt">{fmtMoney(pv.split.interest)}</span></div>
          <div className="f-row"><span className="op" /><span>Toward the balance</span><span className="amt">{fmtMoney(pv.split.principal)}</span></div>
          <div className="f-row res"><span className="op">=</span><span>Balance after</span><span className="amt">{fmtMoney(pv.split.balanceAfter)}</span></div>
        </div>
      )}
      {pv && pv.split.amount < round2(amount) && <Note tone="info">That's more than you owe, so only {fmtMoney(pv.split.amount)} counts.</Note>}
      <p className="sub">{kind === 'extra'
        ? `Automatic payments keep going as planned${d.autoPay ? '' : ' (they are off for this loan)'}.`
        : `The scheduled ${fmtMoney(scheduledAmount(d))} for that date won't be applied.`}</p>
      <Field label="Note (optional)">{(id) => <TextInput id={id} value={note} onChange={setNote} placeholder="Tax refund" />}</Field>
    </Sheet>
  );
}

function openEditPayment(debtId: string, paymentId: string) {
  openSheet((close) => <EditPaymentSheet debtId={debtId} paymentId={paymentId} onClose={close} />);
}

function EditPaymentSheet({ debtId, paymentId, onClose }: { debtId: string; paymentId: string; onClose: () => void }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const d = data.debts.find((x) => x.id === debtId);
  const p: DebtPayment | undefined = d?.payments.find((x) => x.id === paymentId);
  const [amount, setAmount] = useState<number>(p ? p.amount : NaN);
  const [date, setDate] = useState<IsoDate>(p?.date ?? today);
  const [note, setNote] = useState(p?.note ?? '');
  if (!d || !p) return <Sheet title="Payment" onClose={onClose}><p className="sub">This payment isn't here anymore.</p></Sheet>;
  const ok = Number.isFinite(amount) && amount > 0 && isValidIso(date);
  const save = () => { setDebt(d.id, (x) => editPayment(x, p.id, { amount, date, note }, today), { undo: 'Payment updated' }); onClose(); };
  const remove = () => { setDebt(d.id, (x) => deletePayment(x, p.id), { undo: `${fmtMoney(p.amount)} payment deleted` }); onClose(); };
  return (
    <Sheet title="Payment" eyebrow={d.name} onClose={onClose}
      footer={<>
        <button type="button" className="btn danger" style={{ flex: '0 0 auto' }} aria-label="Delete payment" onClick={remove}><IconTrash /></button>
        <button type="button" className="btn" disabled={!ok} onClick={save}>Save</button>
      </>}>
      {p.auto && <Note tone="info">Applied automatically on its due date. Edit it if you paid a different amount, or delete it if you didn't pay.</Note>}
      <div className="fields two">
        <Field label="Amount">{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}</Field>
        <Field label="Paid on">{(id) => <DateInput id={id} value={date} onChange={setDate} />}</Field>
      </div>
      <Field label="Note">{(id) => <TextInput id={id} value={note} onChange={setNote} />}</Field>
      <dl className="kv">
        <dt>Interest</dt><dd>{fmtMoney(p.interest)}</dd>
        <dt>Toward the balance</dt><dd>{fmtMoney(paymentPrincipal(p))}</dd>
        <dt>Balance after</dt><dd>{fmtMoney(p.balanceAfter)}</dd>
      </dl>
      <p className="sub">Changing or deleting a payment moves today's balance by that payment's share only.</p>
    </Sheet>
  );
}
