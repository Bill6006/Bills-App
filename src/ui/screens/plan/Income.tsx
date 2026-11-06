import { useState } from 'react';
import { addMonthsKey, fmtDow, fmtShort, isValidIso, parseISOToMs, type IsoDate } from '../../../engine/dates';
import { clampInt, clampPct, fmtMoney, round2 } from '../../../engine/money';
import { getPaydaysForMonth, describeRule } from '../../../engine/schedule';
import type { PayFrequency, PaySchedule, RecurringItem, Settings, TransferSplit } from '../../../engine/types';
import { DEFAULT_PAY } from '../../../data/defaults';
import { update, useActive, useStore } from '../../../state/store';
import { useEngine } from '../../../state/useEngine';
import { upcomingPaydays } from '../../../state/models';
import { Amount, Note } from '../../components/bits';
import { DateInput, Field, MoneyInput, NumberInput, Select, Switch } from '../../components/controls';
import { IconClose, IconDollar, IconPlus } from '../../icons';
import { nextOccurrences, openItemEditor } from './ItemEditor';
import { PlanHeader, useOpenOnRoute } from './common';

const FREQS: Array<{ value: PayFrequency; label: string }> = [
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Once a month' },
  { value: 'custom', label: 'On set dates' },
];

function nextCombinedPaydays(s: Pick<Settings, 'pay' | 'pay2'>, fromIso: IsoDate, count: number): number[] {
  const out: number[] = [];
  const from = parseISOToMs(fromIso);
  let mk = fromIso.slice(0, 7);
  for (let g = 0; g < 24 && out.length < count; g++) {
    for (const p of getPaydaysForMonth(mk, s)) if (p >= from && out.length < count) out.push(p);
    mk = addMonthsKey(mk, 1);
  }
  return out;
}

function PayEditor({ pay, onChange, today, label }: { pay: PaySchedule; onChange: (p: PaySchedule) => void; today: IsoDate; label: string }) {
  const [newDate, setNewDate] = useState<IsoDate>(today);
  const set = (patch: Partial<PaySchedule>) => onChange({ ...pay, ...patch });
  const next = upcomingPaydays(pay, today, 4);
  return (
    <div className="stack">
      <div className="fields two">
        <Field label={`${label} take-home`} hint="What lands in your account">
          {(id) => <MoneyInput id={id} value={pay.paycheckCap} onChange={(v) => Number.isFinite(v) && set({ paycheckCap: Math.max(0, round2(v)) })} />}
        </Field>
        <Field label="How often">{(id) => <Select id={id} value={pay.frequency} options={FREQS} onChange={(v) => set({ frequency: v })} />}</Field>
      </div>
      {pay.frequency === 'semimonthly' && (
        <div className="fields two">
          <Field label="First payday" hint="Day of the month">{(id) => <NumberInput id={id} value={pay.semimonthlyDom1} min={1} max={31} onChange={(v) => set({ semimonthlyDom1: clampInt(v, 1, 31) })} />}</Field>
          <Field label="Second payday" hint="31 means the last day">{(id) => <NumberInput id={id} value={pay.semimonthlyDom2} min={1} max={31} onChange={(v) => set({ semimonthlyDom2: clampInt(v, 1, 31) })} />}</Field>
        </div>
      )}
      {pay.frequency === 'monthly' && (
        <Field label="Payday" hint="Day of the month; short months use their last day">{(id) => <NumberInput id={id} value={pay.monthlyDom} min={1} max={31} onChange={(v) => set({ monthlyDom: clampInt(v, 1, 31) })} />}</Field>
      )}
      {(pay.frequency === 'weekly' || pay.frequency === 'biweekly') && (
        <Field label="Any one of your paydays" hint={pay.frequency === 'weekly' ? 'Paid every 7 days from this date.' : 'Paid every 14 days from this date, both ways.'}>
          {(id) => <DateInput id={id} value={isValidIso(pay.anchorNextPayday) ? pay.anchorNextPayday : today} onChange={(v) => set({ anchorNextPayday: v })} />}
        </Field>
      )}
      {pay.frequency === 'custom' && (
        <div className="stack">
          <div className="chips">
            {[...pay.customDates].sort().map((d) => (
              <span key={d} className="cp on with-x">{fmtShort(parseISOToMs(d))} {d.slice(0, 4)}
                <button type="button" aria-label={`Remove ${d}`} onClick={() => set({ customDates: pay.customDates.filter((x) => x !== d) })}><IconClose /></button>
              </span>
            ))}
            {!pay.customDates.length && <span className="sub">No dates yet.</span>}
          </div>
          <div className="inline-add">
            <DateInput value={newDate} onChange={setNewDate} />
            <button type="button" className="btn ghost sm" onClick={() => { if (isValidIso(newDate) && !pay.customDates.includes(newDate)) set({ customDates: [...pay.customDates, newDate].sort() }); }}><IconPlus />Add date</button>
          </div>
        </div>
      )}
      <p className="sub">{next.length ? <>Next: {next.map((ms) => fmtDow(ms)).join(' · ')}</> : 'No upcoming paydays.'}</p>
    </div>
  );
}

function SplitEditor({ split, hasPay2, hasOther, onChange }: { split: TransferSplit; hasPay2: boolean; hasOther: boolean; onChange: (s: TransferSplit) => void }) {
  const set = (patch: Partial<TransferSplit>) => {
    const n = { ...split, ...patch };
    for (const k of Object.keys(n) as Array<keyof TransferSplit>) n[k] = clampPct(n[k]);
    if (n.pay2BillsPct + n.otherBillsPct > 100) n.otherBillsPct = Math.max(0, 100 - n.pay2BillsPct);
    if (n.pay2SavingsPct + n.otherSavingsPct > 100) n.otherSavingsPct = Math.max(0, 100 - n.pay2SavingsPct);
    onChange(n);
  };
  const rest = (a: number, b: number) => Math.max(0, 100 - (hasPay2 ? a : 0) - (hasOther ? b : 0));
  return (
    <div className="stack">
      <p className="sub">On paydays with more than one source, this decides which source each transfer comes out of. It doesn't change the amounts.</p>
      <div className="split-grid">
        <span />
        <span className="lbl">To Bills</span>
        <span className="lbl">To Savings</span>
        {hasPay2 && <>
          <span className="strong">From paycheck 2</span>
          <PctInput value={split.pay2BillsPct} onChange={(v) => set({ pay2BillsPct: v })} label="Bills transfer from paycheck 2, percent" />
          <PctInput value={split.pay2SavingsPct} onChange={(v) => set({ pay2SavingsPct: v })} label="Savings transfer from paycheck 2, percent" />
        </>}
        {hasOther && <>
          <span className="strong">From extra income</span>
          <PctInput value={split.otherBillsPct} onChange={(v) => set({ otherBillsPct: v })} label="Bills transfer from extra income, percent" />
          <PctInput value={split.otherSavingsPct} onChange={(v) => set({ otherSavingsPct: v })} label="Savings transfer from extra income, percent" />
        </>}
        <span className="sub">From paycheck 1</span>
        <span className="sub">{rest(split.pay2BillsPct, split.otherBillsPct)}%</span>
        <span className="sub">{rest(split.pay2SavingsPct, split.otherSavingsPct)}%</span>
      </div>
    </div>
  );
}

function PctInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return <span className="pct-input"><NumberInput value={value} min={0} max={100} onChange={onChange} /><span aria-hidden="true">%</span><span className="sr-only">{label}</span></span>;
}

export function IncomePage({ sub }: { sub?: string }) {
  const data = useActive();
  const engine = useEngine();
  const today = useStore((s) => s.today);
  const s = data.settings;
  const mk = today.slice(0, 7);
  const plan = engine.plan(mk);
  const monthTotal = round2(plan.pay1Caps.reduce((t, x) => t + x, 0) + plan.pay2Caps.reduce((t, x) => t + x, 0));
  const upcoming = nextCombinedPaydays(s, today, 5);

  const setPay = (p: PaySchedule) => update((d) => { d.settings.pay = p; });
  const setPay2 = (p: PaySchedule | null) => update((d) => { d.settings.pay2 = p; }, p ? {} : { undo: 'Second paycheck removed' });

  const saveExtra = (item: RecurringItem) => update((d) => {
    const exists = d.settings.otherIncomes.some((x) => x.id === item.id);
    d.settings.otherIncomes = exists ? d.settings.otherIncomes.map((x) => (x.id === item.id ? item : x)) : [...d.settings.otherIncomes, item];
  }, { undo: s.otherIncomes.some((x) => x.id === item.id) ? 'Extra income saved' : 'Extra income added' });
  const removeExtra = (item: RecurringItem) => update((d) => { d.settings.otherIncomes = d.settings.otherIncomes.filter((x) => x.id !== item.id); }, { undo: `${item.name || 'Extra income'} deleted` });
  const openExtra = (item?: RecurringItem) => openItemEditor({ kind: 'income', item, onSave: saveExtra, onDelete: removeExtra });
  useOpenOnRoute(sub === 'extra-new', '/plan/income', () => openExtra());

  const extras = [...s.otherIncomes].sort((a, b) => (nextOccurrences(a, s, today, 1)[0] ?? 9e15) - (nextOccurrences(b, s, today, 1)[0] ?? 9e15));

  return (
    <div className="page page-narrow">
      <PlanHeader title="Income" />

      <section className="card">
        <div className="kv">
          <dt>Paydays this month</dt><dd>{plan.paydays.length}</dd>
          <dt>Paychecks this month</dt><dd>{fmtMoney(monthTotal)}</dd>
          {plan.otherIncomeTotal > 0 && <><dt>Extra income this month</dt><dd>{fmtMoney(plan.otherIncomeTotal)}</dd></>}
        </div>
        {upcoming.length > 0 && <p className="sub">Coming up: {upcoming.map((ms) => fmtShort(ms)).join(' · ')}</p>}
      </section>

      <section className="card">
        <span className="lbl">Your paycheck</span>
        <PayEditor pay={s.pay} onChange={setPay} today={today} label={s.pay2 ? 'Paycheck 1' : 'Paycheck'} />
        {!(s.pay.paycheckCap > 0) && <Note tone="info">Enter your take-home pay so the app can plan each payday's transfers.</Note>}
      </section>

      <section className="card">
        <div className="field-row">
          <div className="grow"><div className="t">Second paycheck</div><div className="sub">A second job or a partner's pay that goes into the same plan.</div></div>
          <Switch checked={!!s.pay2} label="Second paycheck" onChange={(on) => setPay2(on ? { ...DEFAULT_PAY(today), frequency: 'biweekly' } : null)} />
        </div>
        {s.pay2 && <PayEditor pay={s.pay2} onChange={(p) => setPay2(p)} today={today} label="Paycheck 2" />}
      </section>

      <section className="card flush">
        <div className="card-head pad"><span className="lbl">Extra income</span><button type="button" className="link-btn" onClick={() => openExtra()}><IconPlus />Add</button></div>
        {extras.length ? (
          <div className="list">
            {extras.map((x) => {
              const n = nextOccurrences(x, s, today, 1)[0];
              return (
                <button key={x.id} type="button" className="row no-lead" onClick={() => openExtra(x)}>
                  <span className="main-col"><span className="title">{x.name || 'Extra income'}</span><span className="sub">{describeRule(x.rule)}{n != null ? ` · next ${fmtShort(n)}` : ' · already happened'}</span></span>
                  <span className="trail"><Amount value={x.amount} tone="pos" signed /></span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="pad"><div className="empty"><IconDollar /><div className="t-sm">Bonuses, side gigs or refunds. Each one is added to the paycheck of the pay period it lands in, so that pay period has more spending money.</div></div></div>
        )}
      </section>

      {(s.pay2 || s.otherIncomes.length > 0) && (
        <section className="card">
          <span className="lbl">Where transfers come from</span>
          <SplitEditor split={s.transferSplit} hasPay2={!!s.pay2} hasOther={s.otherIncomes.length > 0} onChange={(v) => update((d) => { d.settings.transferSplit = v; })} />
        </section>
      )}
    </div>
  );
}
