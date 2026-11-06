import { useMemo } from 'react';
import { fmtRange, fmtShort, type MonthKey } from '../../engine/dates';
import { fmtMoney, fmtMoneyCompact, round2 } from '../../engine/money';
import { averageBreakdown, graphData, type GraphMeta, type GraphRow } from '../../engine/spending';
import type { PlanEngine } from '../../engine/plan';
import { openSheet } from '../../state/sheets';
import { update, useActive } from '../../state/store';
import { displayName, rangeEntries } from '../../state/spendingModels';
import { Sheet } from '../components/Sheet';
import { Amount, Chip } from '../components/bits';
import { Segmented } from '../components/controls';
import { LogRow } from '../sheets/SpendSheets';

type Range = 'month' | 'last7' | 'custom';

export function Trends({ engine, mk }: { engine: PlanEngine; mk: MonthKey }) {
  const data = useActive();
  const p = data.prefs;
  const meta = useMemo(() => graphData(engine, mk, p.graphRange, p.graphCustomSource, p.graphHiddenIds), [engine, mk, p.graphRange, p.graphCustomSource, p.graphHiddenIds]);
  const avg = useMemo(() => averageBreakdown(engine, meta), [engine, meta]);
  const setRange = (r: Range) => update((d) => {
    if (r === 'custom' && !d.prefs.graphHiddenIds.length) r = d.prefs.graphCustomSource;
    d.prefs.graphRange = r;
  }, { real: true });
  const hiddenRows = (meta.sourceRows || []).filter((r) => p.graphHiddenIds.includes(r.id));
  const unhide = (id?: string) => update((d) => {
    d.prefs.graphHiddenIds = id ? d.prefs.graphHiddenIds.filter((x) => x !== id) : [];
    if (!d.prefs.graphHiddenIds.length) d.prefs.graphRange = d.prefs.graphCustomSource;
  }, { real: true });

  const options: Array<{ value: Range; label: string }> = [{ value: 'month', label: 'This month' }, { value: 'last7', label: 'Last 7 periods' }];
  if (p.graphRange === 'custom' || p.graphHiddenIds.length) options.push({ value: 'custom', label: 'Custom' });

  return (
    <div className="stack">
      <Segmented label="Chart range" value={p.graphRange} onChange={setRange} options={options} />
      <div className="trend-chips">
        <div className="card mini-stat"><span className="lbl">Average</span><span className="strong">{meta.completedCount ? fmtMoney(meta.averageSpent) : '—'}</span><span className="sub">per finished period</span></div>
        <div className="card mini-stat"><span className="lbl">Total</span><span className="strong">{fmtMoney(meta.totalSpent)}</span><span className="sub">{meta.count} pay period{meta.count === 1 ? '' : 's'}</span></div>
      </div>
      <section className="card">
        {meta.rows.length ? <BarChart meta={meta} onBar={(r) => openPeriod(engine, r)} /> : <p className="sub">No spending logged for these pay periods yet.</p>}
        <div className="chart-legend sub">
          <span><i className="dot bg-save" /> Current</span><span><i className="dot bg-bills" /> Under budget</span><span><i className="dot bg-warn" /> 90%+ of budget</span><span><i className="dot" style={{ background: 'var(--bad)' }} /> Over</span>
        </div>
        {!meta.completedCount && <p className="sub">The average appears after a pay period finishes.</p>}
      </section>
      {p.graphRange === 'custom' && hiddenRows.length > 0 && (
        <section className="card">
          <div className="card-head"><span className="lbl">Hidden from the chart</span><button type="button" className="link-btn" onClick={() => unhide()}>Show all</button></div>
          <div className="chips">{hiddenRows.map((r) => <button key={r.id} type="button" className="cp" onClick={() => unhide(r.id)}>{fmtRange(r.startMs, r.endMs)} · Show</button>)}</div>
        </section>
      )}
      {avg.length > 0 && (
        <section className="card flush">
          <div className="pad"><span className="lbl">Average per pay period, by budget</span><div className="sub">From {avg[0].completedCount} finished pay period{avg[0].completedCount === 1 ? '' : 's'} in this chart</div></div>
          <div className="list">
            {avg.map((a) => (
              <div key={a.id} className="row no-lead">
                <span className="main-col"><span className="title">{displayName(data, a.id, a.name)}</span><span className="sub">{a.entryCount} log{a.entryCount === 1 ? '' : 's'} · in {a.periodsHit} of {a.completedCount} periods · {fmtMoney(a.total)} total</span></span>
                <span className="trail"><Amount value={a.average} /></span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function tone(r: GraphRow): string {
  const budget = Math.max(0, r.budget);
  if (budget > 0 && r.spent > budget) return 'var(--bad)';
  if (budget > 0 && r.spent >= round2(budget * 0.9)) return 'var(--warn)';
  if (r.isCurrentPeriod) return 'var(--save)';
  return 'var(--bills)';
}

function BarChart({ meta, onBar }: { meta: GraphMeta; onBar: (r: GraphRow) => void }) {
  const W = 340, H = 210, top = 24, bottom = 34, left = 6, right = 6;
  const n = meta.rows.length;
  const inner = W - left - right;
  const slot = inner / n;
  const bw = Math.min(46, slot * 0.62);
  const scale = Math.max(1, meta.maxSpent, meta.averageSpent);
  const y = (v: number) => top + (H - top - bottom) * (1 - Math.max(0, Math.min(1, v / scale)));
  const avgY = y(meta.averageSpent);
  const compact = n >= 5;
  return (
    <svg className="bar-chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Spending per pay period">
      <line x1={left} x2={W - right} y1={H - bottom} y2={H - bottom} className="axis" />
      {meta.rows.map((r, i) => {
        const cx = left + slot * i + slot / 2;
        const v = Math.max(0, r.spent);
        const h = Math.max((H - top - bottom) * 0.04, (H - bottom) - y(v));
        const by = H - bottom - h;
        const label = `${fmtRange(r.startMs, r.endMs)}: spent ${fmtMoney(r.spent)} of ${fmtMoney(r.budget)} budgeted`;
        return (
          <g key={r.id} className="bar" role="button" tabIndex={0} aria-label={label} onClick={() => onBar(r)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBar(r); } }}>
            <rect x={cx - slot / 2} y={top - 6} width={slot} height={H - top - bottom + 6} fill="transparent" />
            <rect x={cx - bw / 2} y={by} width={bw} height={h} rx={Math.min(8, bw / 3)} fill={tone(r)} opacity={r.isComplete || r.isCurrentPeriod ? 1 : 0.55} />
            {r.budget > 0 && <line x1={cx - bw / 2 - 4} x2={cx + bw / 2 + 4} y1={y(r.budget)} y2={y(r.budget)} className="budget-tick" />}
            <text x={cx} y={by - 6} textAnchor="middle" className="val">{compact ? fmtMoneyCompact(r.spent) : fmtMoney(r.spent)}</text>
            <text x={cx} y={H - bottom + 15} textAnchor="middle" className="lab">{fmtShort(r.startMs)}</text>
            {!compact && <text x={cx} y={H - bottom + 27} textAnchor="middle" className="lab faint">to {fmtShort(r.endMs)}</text>}
          </g>
        );
      })}
      {meta.completedCount > 0 && meta.averageSpent > 0 && (
        <g aria-hidden="true">
          <line x1={left} x2={W - right} y1={avgY} y2={avgY} className="avg-line" />
          <text x={W - right} y={avgY - 5} textAnchor="end" className="avg-lab">avg {fmtMoneyCompact(meta.averageSpent)}</text>
        </g>
      )}
    </svg>
  );
}

function openPeriod(engine: PlanEngine, r: GraphRow) {
  openSheet((close) => <PeriodSheet engine={engine} r={r} onClose={close} />);
}

function PeriodSheet({ engine, r, onClose }: { engine: PlanEngine; r: GraphRow; onClose: () => void }) {
  const data = useActive();
  const logs = rangeEntries(engine.data, r.startMs, r.endMs);
  const byBudget = new Map<string, { name: string; total: number; count: number }>();
  for (const e of logs) {
    const k = e.extraId || e.extraName;
    const b = byBudget.get(k) || { name: displayName(data, e.extraId, e.extraName), total: 0, count: 0 };
    b.total = round2(b.total + e.amount);
    b.count += 1;
    byBudget.set(k, b);
  }
  const hide = () => {
    update((d) => {
      if (d.prefs.graphRange !== 'custom') {
        d.prefs.graphCustomSource = d.prefs.graphRange === 'last7' ? 'last7' : 'month';
        d.prefs.graphHiddenIds = [];
        d.prefs.graphRange = 'custom';
      }
      if (!d.prefs.graphHiddenIds.includes(r.id)) d.prefs.graphHiddenIds.push(r.id);
    }, { real: true });
    onClose();
  };
  return (
    <Sheet title={fmtRange(r.startMs, r.endMs)} eyebrow="Pay period" onClose={onClose}
      footer={<button type="button" className="btn ghost" onClick={hide}>Hide from chart</button>}>
      <div className="card-head end"><span><span className="lbl">Spent</span><br /><span className="strong" style={{ fontSize: 22 }}>{fmtMoney(r.spent)}</span></span>
        <span className="sub right">of {fmtMoney(r.budget)} budgeted<br />{r.isCurrentPeriod ? <Chip tone="good">Current</Chip> : r.isComplete ? 'Finished' : 'Upcoming'}</span></div>
      {byBudget.size > 0 && (
        <div className="card flush"><div className="pad lbl">By budget</div><div className="list">
          {[...byBudget.values()].sort((a, b) => b.total - a.total).map((b) => (
            <div key={b.name} className="row no-lead"><span className="main-col"><span className="title">{b.name}</span><span className="sub">{b.count} log{b.count === 1 ? '' : 's'}</span></span><span className="trail"><Amount value={b.total} /></span></div>
          ))}
        </div></div>
      )}
      <div className="card flush"><div className="pad lbl">All logs</div>
        {logs.length ? <div className="list">{logs.map((e) => <LogRow key={e.id} e={e} />)}</div> : <p className="sub pad">Nothing logged in this pay period.</p>}
      </div>
    </Sheet>
  );
}
