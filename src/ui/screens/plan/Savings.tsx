import { useMemo, useRef, useState } from 'react';
import { addMonthsKey, fmtMonthLong, fmtMonthShort, fmtShort, parseISOToMs, type MonthKey } from '../../../engine/dates';
import { clampInt, fmtMoney, fmtMoneyCompact, round2 } from '../../../engine/money';
import { newId } from '../../../engine/loans';
import { describeRule } from '../../../engine/schedule';
import type { Rule, SavingsEvent } from '../../../engine/types';
import type { PlanEngine } from '../../../engine/plan';
import { openSheet } from '../../../state/sheets';
import { update, useActive, useStore } from '../../../state/store';
import { useEngine } from '../../../state/useEngine';
import { Sheet } from '../../components/Sheet';
import { Amount, Money, Note } from '../../components/bits';
import { Field, MoneyInput, MonthInput, Segmented, TextInput } from '../../components/controls';
import { IconPlus, IconTrash, IconTrend } from '../../icons';
import { nextOccurrences, RulePicker } from './ItemEditor';
import { PlanHeader, useOpenOnRoute } from './common';

interface MonthPoint { mk: MonthKey; start: number; end: number; added: number; withdrawn: number; items: Array<{ name: string; amount: number }> }

function monthPoints(engine: PlanEngine, fromMk: MonthKey, n: number): MonthPoint[] {
  const out: MonthPoint[] = [];
  for (let i = 0; i < n; i++) {
    const mk = addMonthsKey(fromMk, i);
    const p = engine.plan(mk);
    let added = 0, withdrawn = 0;
    const items: MonthPoint['items'] = [];
    for (const r of p.rows) {
      added += r.savingsIn;
      withdrawn += r.savingsOut;
      for (const e of r.events) {
        const ev = engine.data.events.find((x) => x.id === e.id);
        items.push({ name: ev ? (ev.item ? `${ev.event}: ${ev.item}` : ev.event) : e.name, amount: Number(e.amount || 0) });
      }
    }
    out.push({ mk, start: p.startSavings, end: p.endSavings, added: round2(added), withdrawn: round2(withdrawn), items });
  }
  return out;
}

const eventTitle = (e: SavingsEvent) => (e.item ? `${e.event}: ${e.item}` : e.event);

export function SavingsPage({ sub }: { sub?: string }) {
  const data = useActive();
  const engine = useEngine();
  const today = useStore((st) => st.today);
  const s = data.settings;
  const mk = today.slice(0, 7);
  const horizon = clampInt(s.savings.timelineMonths || 12, 3, 36);
  const points = useMemo(() => monthPoints(engine, mk, horizon), [engine, mk, horizon]);
  const row = engine.rowFor(parseISOToMs(today));
  const now = row?.savingsBalance ?? points[0]?.start ?? 0;
  const plan = engine.plan(mk);
  const perPay = plan.savingsByPayIndex.length ? plan.savingsByPayIndex : [];
  const perPayText = perPay.length ? (perPay.every((x) => x === perPay[0]) ? `${fmtMoney(perPay[0])} each payday` : perPay.map((x) => fmtMoney(x)).join(' + ')) : '';

  useOpenOnRoute(sub === 'new', '/plan/savings', () => openWithdrawal());

  const [showPast, setShowPast] = useState(false);
  const { groups, past } = useMemo(() => {
    const m = new Map<string, { name: string; items: Array<{ e: SavingsEvent; next?: number }>; next: number }>();
    const done: SavingsEvent[] = [];
    for (const e of data.events) {
      const n = nextOccurrences({ id: e.id, name: e.name, amount: e.amount, rule: e.rule }, s, today, 1)[0];
      if (n == null) { done.push(e); continue; }
      const key = (e.event || 'Withdrawal').trim();
      const g = m.get(key) || { name: key, items: [], next: Infinity };
      g.items.push({ e, next: n });
      if (n < g.next) g.next = n;
      m.set(key, g);
    }
    done.sort((a, b) => String(b.rule.anchor || '').localeCompare(String(a.rule.anchor || '')));
    return { groups: [...m.values()].sort((a, b) => a.next - b.next || a.name.localeCompare(b.name)), past: done };
  }, [data.events, s, today]);

  const last = points[points.length - 1];

  return (
    <div className="page page-narrow">
      <PlanHeader title="Savings" action={<button type="button" className="btn sm" onClick={() => openWithdrawal()}><IconPlus />Withdrawal</button>} />

      <section className="card hero-lite">
        <span className="lbl">Savings should have today</span>
        <Money value={now} size="lg" />
        <span className="sub">{last ? `${fmtMoney(last.end)} by the end of ${fmtMonthLong(last.mk)}` : ''}</span>
      </section>

      <section className="card">
        <div className="card-head"><span className="lbl">Next {horizon} months</span>
          <Segmented size="sm" label="Months shown" value={String(horizon)} onChange={(v) => update((d) => { d.settings.savings.timelineMonths = Number(v); }, { real: true })}
            options={[{ value: '6', label: '6 mo' }, { value: '12', label: '1 yr' }, { value: '24', label: '2 yr' }]} />
        </div>
        <SavingsChart points={points} />
        <p className="sub">Month-end balance. Dots mark months with a planned withdrawal.</p>
      </section>

      <section className="card">
        <span className="lbl">Your plan</span>
        <div className="fields">
          <Field label="Save each month" hint={perPayText ? `This month: ${perPayText}` : 'Split across the month’s paydays'}>
            {(id) => <MoneyInput id={id} value={s.savings.monthlyGoal} onChange={(v) => Number.isFinite(v) && update((d) => { d.settings.savings.monthlyGoal = Math.max(0, round2(v)); })} />}
          </Field>
        </div>
        <div className="fields">
          <Field label="Starting month" hint="Your savings balance below is from the 1st of this month">
            {(id) => <MonthInput id={id} value={s.trueSavingsMonth} onChange={(v) => update((d) => { d.settings.trueSavingsMonth = v; })} />}
          </Field>
          <Field label="Savings balance that day">
            {(id) => <MoneyInput id={id} value={s.baseSavingsBalance} allowNegative onChange={(v) => Number.isFinite(v) && update((d) => { d.settings.baseSavingsBalance = round2(v); })} />}
          </Field>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => openSetToday(engine)}>Update from today's balance</button>
        <p className="sub">From that starting point the app adds your monthly amount on paydays and takes out planned withdrawals. You only need to update it if your account drifts from the plan.</p>
      </section>

      <section className="card flush">
        <div className="card-head pad"><span className="lbl">Planned withdrawals</span><button type="button" className="link-btn" onClick={() => openWithdrawal()}><IconPlus />Add</button></div>
        {groups.map((g) => (
          <div key={g.name} className="group">
            <div className="group-head pad"><span className="strong">{g.name}</span><span className="sub">{g.items.length} item{g.items.length === 1 ? '' : 's'} · {fmtMoney(g.items.reduce((t, x) => t + x.e.amount, 0))}</span></div>
            <div className="list">
              {g.items.map(({ e, next }) => (
                <button key={e.id} type="button" className="row no-lead" onClick={() => openWithdrawal(e)}>
                  <span className="main-col"><span className="title">{e.item || e.event}</span><span className="sub">{describeRule(e.rule)}{next != null ? ` · next ${fmtShort(next)}` : ''}</span></span>
                  <span className="trail"><Amount value={-e.amount} /></span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && (
          <div className="pad"><div className="empty"><IconTrend /><div className="t-sm">{past.length ? 'Nothing planned ahead.' : 'Plan big costs paid from savings, like holiday gifts or a trip. They come out of the savings projection on their date.'}</div></div></div>
        )}
        {past.length > 0 && (
          <div className="group">
            <button type="button" className="group-head pad past-toggle" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>
              <span className="sub">Past withdrawals ({past.length})</span><span className="link-btn">{showPast ? 'Hide' : 'Show'}</span>
            </button>
            {showPast && (
              <div className="list">
                {past.map((e) => (
                  <button key={e.id} type="button" className="row no-lead is-past" onClick={() => openWithdrawal(e)}>
                    <span className="main-col"><span className="title">{eventTitle(e)}</span><span className="sub">{describeRule(e.rule)}</span></span>
                    <span className="trail"><Amount value={-e.amount} /></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card flush">
        <div className="card-head pad"><span className="lbl">Month by month</span><span className="sub">+{fmtMoney(s.savings.monthlyGoal)} each month</span></div>
        <div className="table-scroll">
          <table className="mini-table">
            <thead><tr><th scope="col">Month</th><th scope="col">Withdrawals</th><th scope="col">End balance</th></tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.mk} className={p.mk === mk ? 'is-now' : ''}>
                  <th scope="row">{fmtMonthShort(p.mk)}</th>
                  <td>{p.withdrawn ? `−${fmtMoney(p.withdrawn)}` : '—'}</td>
                  <td className="strong">{fmtMoney(p.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- chart ----------

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function SavingsChart({ points }: { points: MonthPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 340, H = 190, L = 44, R = 12, T = 18, B = 26;
  const n = points.length;
  const vals = points.map((p) => p.end);
  const lo = Math.min(0, ...vals);
  const hi = niceMax(Math.max(...vals, 1) * 1.05);
  const x = (i: number) => L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.end).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${y(Math.max(lo, 0)).toFixed(1)}L${x(0).toFixed(1)},${y(Math.max(lo, 0)).toFixed(1)}Z`;
  const ticks = [0, hi / 2, hi].filter((t) => t >= lo);
  const labelEvery = n > 12 ? 4 : n > 6 ? 2 : 1;
  const withdrawals = points.map((p, i) => ({ p, i })).filter(({ p }) => p.withdrawn > 0);
  const labelWithdrawals = withdrawals.length <= 4;

  const pick = (clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  };
  const a = active != null ? points[active] : null;
  const tipLeft = active != null ? Math.min(78, Math.max(22, (x(active) / W) * 100)) : 0;

  return (
    <div className="chart-wrap">
      <svg ref={svgRef} className="line-chart" viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0}
        aria-label={`Savings at the end of each month, from ${fmtMoney(points[0]?.end)} in ${fmtMonthLong(points[0]?.mk || '')} to ${fmtMoney(points[n - 1]?.end)} in ${fmtMonthLong(points[n - 1]?.mk || '')}. The table below lists every month.`}
        onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); setActive((v) => Math.min(n - 1, (v ?? -1) + 1)); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); setActive((v) => Math.max(0, (v ?? n) - 1)); }
          if (e.key === 'Escape') setActive(null);
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 6} y={y(t) + 3.5} textAnchor="end" className="tick">{fmtMoneyCompact(t)}</text>
          </g>
        ))}
        <path d={area} className="area" />
        <path d={line} className="ln" />
        {points.map((p, i) => (i % labelEvery === 0 || i === n - 1) && (
          <text key={p.mk} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="tick">{fmtMonthShort(p.mk).split(' ')[0]}</text>
        ))}
        {withdrawals.map(({ p, i }) => (
          <g key={p.mk}>
            <circle cx={x(i)} cy={y(p.end)} r={4.5} className="wd-dot" />
            {labelWithdrawals && <text x={x(i)} y={y(p.end) - 9} textAnchor="middle" className="wd-lab">−{fmtMoneyCompact(p.withdrawn)}</text>}
          </g>
        ))}
        <circle cx={x(n - 1)} cy={y(points[n - 1]?.end ?? 0)} r={4} className="end-dot" />
        {a && active != null && (
          <g aria-hidden="true">
            <line x1={x(active)} x2={x(active)} y1={T - 6} y2={H - B} className="crosshair" />
            <circle cx={x(active)} cy={y(a.end)} r={4.5} className="end-dot" />
          </g>
        )}
      </svg>
      {a && (
        <div className="chart-tip" style={{ left: `${tipLeft}%` }} role="status">
          <span className="strong">{fmtMoney(a.end)}</span>
          <span className="sub">End of {fmtMonthLong(a.mk)}</span>
          <span className="sub">+{fmtMoney(a.added)} saved{a.withdrawn ? ` · −${fmtMoney(a.withdrawn)} out` : ''}</span>
          {a.items.slice(0, 3).map((it, k) => <span key={k} className="sub">{it.name} {fmtMoney(it.amount)}</span>)}
        </div>
      )}
    </div>
  );
}

// ---------- sheets ----------

function openSetToday(engine: PlanEngine) {
  openSheet((close) => <SetTodaySheet engine={engine} onClose={close} />);
}

function SetTodaySheet({ engine, onClose }: { engine: PlanEngine; onClose: () => void }) {
  const today = engine.today();
  const mk = today.slice(0, 7);
  const plan = engine.plan(mk);
  const todayMs = parseISOToMs(today);
  const [amount, setAmount] = useState<number>(NaN);
  let added = 0, out = 0;
  for (const r of plan.rows) if (r.ms <= todayMs) { added += r.savingsIn; out += r.savingsOut; }
  const base = round2(amount - added + out);
  const ok = Number.isFinite(amount);
  return (
    <Sheet title="Update savings" onClose={onClose}
      footer={<button type="button" className="btn" disabled={!ok} onClick={() => {
        update((d) => { d.settings.trueSavingsMonth = mk; d.settings.baseSavingsBalance = base; }, { undo: 'Savings balance updated' });
        onClose();
      }}>Save</button>}>
      <Field label="What your savings account has today">{(id) => <MoneyInput id={id} value={null} onChange={setAmount} autoFocus />}</Field>
      {ok && (
        <Note tone="info">
          This month the plan has added {fmtMoney(round2(added))}{out ? ` and taken out ${fmtMoney(round2(out))}` : ''} so far, so your balance on {fmtShort(parseISOToMs(`${mk}-01`))} works out to {fmtMoney(base)}. Everything after today follows from there.
        </Note>
      )}
    </Sheet>
  );
}

export function openWithdrawal(item?: SavingsEvent) {
  openSheet((close) => <WithdrawalSheet item={item} onClose={close} />);
}

function WithdrawalSheet({ item, onClose }: { item?: SavingsEvent; onClose: () => void }) {
  const data = useActive();
  const today = useStore((st) => st.today);
  const [event, setEvent] = useState(item?.event ?? '');
  const [what, setWhat] = useState(item?.item ?? '');
  const [amount, setAmount] = useState<number>(item ? item.amount : NaN);
  const [rule, setRule] = useState<Rule>(item?.rule ?? { type: 'one_time', anchor: today });
  const names = [...new Set(data.events.map((e) => e.event).filter(Boolean))].slice(0, 8);
  const valid = event.trim().length > 0 && Number.isFinite(amount) && amount > 0;
  const draft: SavingsEvent = {
    id: item?.id ?? newId('e'), event: event.trim(), item: what.trim(), amount: round2(amount), rule,
    name: `Event: ${event.trim()}${what.trim() ? ` - ${what.trim()}` : ''}`,
  };
  const next = Number.isFinite(amount) ? nextOccurrences({ id: draft.id, name: draft.name, amount: draft.amount, rule }, data.settings, today, 3) : [];
  const save = () => {
    update((d) => {
      d.events = d.events.some((x) => x.id === draft.id) ? d.events.map((x) => (x.id === draft.id ? draft : x)) : [...d.events, draft];
    }, { undo: item ? 'Withdrawal saved' : 'Withdrawal planned' });
    onClose();
  };
  const remove = () => {
    if (!item) return;
    update((d) => { d.events = d.events.filter((x) => x.id !== item.id); }, { undo: `${eventTitle(item)} deleted` });
    onClose();
  };
  return (
    <Sheet title={item ? 'Edit withdrawal' : 'Plan a withdrawal'} eyebrow="From savings" onClose={onClose}
      footer={<>
        {item && <button type="button" className="btn danger" style={{ flex: '0 0 auto' }} aria-label="Delete" onClick={remove}><IconTrash /></button>}
        <button type="button" className="btn" disabled={!valid} onClick={save}>{item ? 'Save' : 'Add'}</button>
      </>}>
      <div className="fields">
        <Field label="Event" hint="Groups related costs, like Christmas or Vacation">{(id) => <TextInput id={id} value={event} onChange={setEvent} placeholder="Christmas" autoFocus={!item} />}</Field>
        {names.length > 0 && !item && (
          <div className="chips">{names.map((nm) => <button key={nm} type="button" className={`cp ${nm === event ? 'on' : ''}`} onClick={() => setEvent(nm)}>{nm}</button>)}</div>
        )}
        <Field label="What for (optional)">{(id) => <TextInput id={id} value={what} onChange={setWhat} placeholder="Gifts" />}</Field>
        <Field label="Amount">{(id) => <MoneyInput id={id} value={Number.isFinite(amount) ? amount : null} onChange={setAmount} />}</Field>
      </div>
      <div className="field"><span className="lbl">When</span><RulePicker rule={rule} onChange={setRule} today={today} /></div>
      {next.length > 0 && <Note tone="info">{describeRule(rule)}. Comes out of savings on {next.map((ms) => fmtShort(ms)).join(', ')}{next.length === 3 ? '…' : '.'}</Note>}
      {Number.isFinite(amount) && next.length === 0 && <Note tone="warn">This date has passed, so it won't change the projection.</Note>}
      <p className="sub">Withdrawals only change the Savings projection. They don't touch the Bills account.</p>
    </Sheet>
  );
}
