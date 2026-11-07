import { useMemo, useState } from 'react';
import { addMonthsKey, fmtRange, fmtShort, isoDate, parseISOToMs, type IsoDate, type MonthKey } from '../../engine/dates';
import { fmtMoney } from '../../engine/money';
import { nextPeriod, periodForDate, snapshotForRange } from '../../engine/spending';
import { occurrencesForRange } from '../../engine/schedule';
import { paydayInfo } from '../../state/models';
import { MISC_ID, type AppData } from '../../engine/types';
import type { PlanEngine } from '../../engine/plan';
import { navigate } from '../../app/router';
import { update, useActive } from '../../state/store';
import { useEngine } from '../../state/useEngine';
import { daysLeftIn, historyGroups, isArchived, meterTone, orderedRows, rangeEntries, rangeTransfers, scopeRange, type Scope } from '../../state/spendingModels';
import { Amount, Chip, Meter, Money, Note } from '../components/bits';
import { Segmented } from '../components/controls';
import { LogRow, openBudgetDetail, openLogSpend, openMoveMoney } from '../sheets/SpendSheets';
import { openWhy } from '../sheets/WhySheet';
import { Trends } from './SpendingTrends';
import { IconChevronLeft, IconChevronRight, IconEnvelope, IconFile, IconMove, IconPlus, IconSearch } from '../icons';
import { openBankImport } from '../sheets/BankImportSheet';
import { openReview } from '../sheets/ReviewSheet';
import { useOpenOnRoute } from './plan/common';

type View = 'budgets' | 'history' | 'trends';

export function Spending({ sub }: { sub?: string }) {
  const engine = useEngine();
  const data = useActive();
  const today = engine.today();
  const kind = data.prefs.spendingScope;
  const [view, setView] = useState<View>('budgets');
  const [anchor, setAnchor] = useState<IsoDate>(today);
  const [mk, setMk] = useState<MonthKey>(today.slice(0, 7));
  const [query, setQuery] = useState('');

  const scope: Scope = kind === 'period' ? { kind: 'period', period: periodForDate(engine, anchor) } : { kind: 'month', mk };
  const range = useMemo(() => scopeRange(engine, scope), [engine, kind, anchor, mk]); // eslint-disable-line react-hooks/exhaustive-deps
  const isCurrent = kind === 'period' ? parseISOToMs(today) >= range.startMs && parseISOToMs(today) <= range.endMs : mk === today.slice(0, 7);

  const shift = (dir: -1 | 1) => {
    if (kind === 'period') {
      const p = periodForDate(engine, anchor);
      setAnchor(isoDate(dir < 0 ? p.startMs - 86400000 : p.endMs + 86400000));
    } else setMk(addMonthsKey(mk, dir));
  };
  const setKind = (k: 'period' | 'month') => {
    update((d) => { d.prefs.spendingScope = k; }, { real: true });
    setAnchor(today);
    setMk(today.slice(0, 7));
  };
  const goNow = () => { setAnchor(today); setMk(today.slice(0, 7)); };

  const trendsMonth = kind === 'month' ? mk : isoDate(range.endMs).slice(0, 7);
  const reviewCount = data.bank.txns.filter((t) => t.status === 'review').length;
  useOpenOnRoute(sub === 'review' || sub === 'import', '/spending', () => (sub === 'review' ? openReview() : openBankImport()));
  const noBudgets = !data.extras.length && !data.spendEntries.length;

  return (
    <div className="page page-narrow spending">
      <header className="page-head">
        <div className="titles">
          <div className="eyebrow">{range.title}{isCurrent ? ' · now' : ''}</div>
          <h1 className="page-title">Spending</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" aria-label={kind === 'period' ? 'Previous pay period' : 'Previous month'} onClick={() => shift(-1)}><IconChevronLeft /></button>
          <button type="button" className="icon-btn" aria-label={kind === 'period' ? 'Next pay period' : 'Next month'} onClick={() => shift(1)}><IconChevronRight /></button>
        </div>
      </header>

      <div className="spend-controls">
        <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'budgets', label: 'Budgets' }, { value: 'history', label: 'History' }, { value: 'trends', label: 'Trends' }]} />
        {view === 'budgets' && <Segmented size="sm" label="Time span" value={kind} onChange={setKind} options={[{ value: 'period', label: 'Pay period' }, { value: 'month', label: 'Month' }]} />}
        {!isCurrent && view === 'budgets' && <button type="button" className="btn ghost sm" onClick={goNow}>Back to now</button>}
      </div>

      {reviewCount > 0 && (
        <button type="button" className="card tap review-banner" onClick={openReview}>
          <span className="icon-badge p"><IconFile /></span>
          <span className="main-col"><span className="strong">{reviewCount} imported purchase{reviewCount === 1 ? '' : 's'} need a budget</span><span className="sub">A tap each. The app learns from your picks.</span></span>
          <IconChevronRight />
        </button>
      )}

      {view === 'budgets' && (noBudgets ? (
        <section className="card">
          <div className="empty"><IconEnvelope /><div className="t">No spending budgets yet</div><div className="t-sm">Budgets are planned costs like groceries or gas that come out of your spending money, not the Bills account.</div></div>
          <button type="button" className="btn" onClick={() => navigate('/plan/budgets')}><IconPlus />Add a budget</button>
          <button type="button" className="btn ghost" onClick={() => openLogSpend({})}>Log spending anyway</button>
        </section>
      ) : (
        <>
          <Budgets engine={engine} data={data} scopeKind={kind} range={range} isCurrent={isCurrent} today={today} onShowHistory={() => setView('history')}
            onJump={(iso) => { setAnchor(iso); setMk(iso.slice(0, 7)); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
          <ComingPeriods engine={engine} data={data} today={today} onJump={(iso) => { if (kind !== 'period') setKind('period'); setAnchor(iso); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        </>
      ))}

      {view === 'history' && (
        <div className="stack">
          <label className="search">
            <IconSearch />
            <input className="input" placeholder="Search notes or budgets" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search spending" />
          </label>
          <History engine={engine} query={query} />
        </div>
      )}

      {view === 'trends' && <Trends engine={engine} mk={trendsMonth} />}
    </div>
  );
}

function Budgets({ engine, data, scopeKind, range: r, isCurrent: cur, today: t, onShowHistory, onJump }: { engine: PlanEngine; data: AppData; scopeKind: 'period' | 'month'; range: ReturnType<typeof scopeRange>; isCurrent: boolean; today: IsoDate; onShowHistory: () => void; onJump: (iso: IsoDate) => void }) {
    const rows = orderedRows(data, r.snapshot);
    const totals = r.snapshot.totals;
    const pct = totals.budget > 0 ? (Math.max(0, totals.spent) / totals.budget) * 100 : 0;
    const daysLeft = daysLeftIn(engine, r.endMs);
    const logs = rangeEntries(data, r.startMs, r.endMs);
    const moves = rangeTransfers(data, r.startMs, r.endMs);
    const logDate = cur ? t : isoDate(r.startMs);
    const status = cur ? (scopeKind === 'period' ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} until ${fmtShort(r.endMs + 86400000)}` : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in the month`)
      : r.endMs < parseISOToMs(t) ? 'Finished' : 'Upcoming';
    return (
      <>
        <button type="button" className="card tap summary" onClick={() => scopeKind === 'period' && openWhy(engine, { kind: 'leftToSpend', startMs: r.startMs, endMs: r.endMs })}>
          <Ring pct={pct} over={totals.spent > totals.budget} />
          <span className="main-col">
            <span className="lbl">{cur ? 'Left to spend' : 'Left'}</span>
            <Money value={totals.remaining} size="md" />
            <span className="sub">{fmtMoney(totals.spent)} spent of {fmtMoney(totals.budget)}</span>
            <span className="sub">{status}</span>
          </span>
        </button>
        {scopeKind === 'month' && <p className="sub">Month totals add up the pay periods that end in this month.</p>}

        <div className="btn-row">
          <button type="button" className="btn" onClick={() => openLogSpend({ date: logDate })}><IconPlus />Log spending</button>
          {scopeKind === 'period' && <button type="button" className="btn ghost" onClick={() => openMoveMoney({ date: logDate })}><IconMove />Move money</button>}
        </div>
        <button type="button" className="btn ghost block" onClick={openBankImport}><IconFile />Import from your bank</button>
        {data.bank.lastTxnDate && cur && (parseISOToMs(data.bank.lastTxnDate) < r.startMs
          ? <p className="sub center">Bank purchases imported through {fmtShort(parseISOToMs(data.bank.lastTxnDate))}, so they're in earlier {scopeKind === 'period' ? 'pay periods' : 'months'}. <button type="button" className="link-btn" onClick={() => onJump(data.bank.lastTxnDate!)}>See them</button></p>
          : <p className="sub center">Bank purchases imported through {fmtShort(parseISOToMs(data.bank.lastTxnDate))}.</p>)}

        <section className="card flush">
          <div className="list">
            {rows.map((row) => (
              <button key={row.id} type="button" className={`row no-lead budget-row ${isArchived(data, row.id) ? 'archived' : ''}`}
                onClick={() => openBudgetDetail({ id: row.id, startMs: r.startMs, endMs: r.endMs, title: r.title })}>
                <span className="main-col">
                  <span className="title">
                    {row.id === MISC_ID ? 'Unassigned' : row.name}
                    {isArchived(data, row.id) && <Chip>Archived</Chip>}
                    {Math.abs(row.transferNet) > 0.004 && <Chip tone={row.transferNet > 0 ? 'good' : undefined}>{row.transferNet > 0 ? '+' : '−'}{fmtMoney(Math.abs(row.transferNet))} moved</Chip>}
                  </span>
                  <Meter pct={row.budget > 0 ? (Math.max(0, row.spent) / row.budget) * 100 : row.spent > 0 ? 100 : 0} tone={meterTone(row)} label={`${row.name} spent`} />
                </span>
                <span className="trail">
                  <Amount value={row.remaining} tone={row.remaining < 0 ? 'bad' : undefined} />
                  <span className="sub">{row.remaining < 0 ? 'over' : 'left'} of {fmtMoney(row.budget)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {moves.length > 0 && <Note tone="info">{moves.length} budget move{moves.length === 1 ? '' : 's'} in this {scopeKind === 'period' ? 'pay period' : 'month'}. Open a budget to see or undo them.</Note>}

        <section className="card flush">
          <div className="card-head pad"><span className="lbl">Logged {scopeKind === 'period' ? 'this pay period' : 'this month'}</span>{logs.length > 5 && <button type="button" className="link-btn" onClick={onShowHistory}>All {logs.length} <IconChevronRight /></button>}</div>
          {logs.length ? <div className="list">{logs.slice(0, 5).map((e) => <LogRow key={e.id} e={e} />)}</div> : <p className="sub pad">Nothing logged yet. Logging is optional; without it, this shows your full spending money.</p>}
        </section>
      </>
    );
  }

/** The old app's "Pocket leftover": spending money and what's free after budgets, pay period by pay period. */
function ComingPeriods({ engine, data, today, onJump }: { engine: PlanEngine; data: AppData; today: IsoDate; onJump: (iso: IsoDate) => void }) {
  const rows = useMemo(() => {
    const out: Array<{ start: number; end: number; spending: number; free: number; spent: number; names: string[]; now: boolean }> = [];
    let p = periodForDate(engine, today);
    for (let i = 0; i < 5; i++) {
      const info = p.startsOnPayday ? paydayInfo(engine, p.startMs) : null;
      const snap = snapshotForRange(engine, p.startMs, p.endMs);
      const misc = snap.items.find((r) => r.id === MISC_ID);
      const ids = new Set<string>();
      for (const list of occurrencesForRange(p.startMs, p.endMs, data.extras, data.settings).values()) for (const o of list) ids.add(o.id);
      const names = data.order.extras.filter((id) => ids.has(id)).map((id) => data.extras.find((x) => x.id === id)?.name || '').filter(Boolean);
      out.push({
        start: p.startMs, end: p.endMs, now: i === 0, spent: snap.totals.spent, names,
        spending: info ? info.spending : snap.totals.budget,
        free: info ? info.free : misc ? misc.budget : 0,
      });
      p = nextPeriod(engine, p);
    }
    return out;
  }, [engine, data, today]);
  if (!rows.length) return null;
  const short = rows.filter((r) => r.free < -0.004);
  return (
    <section className="card flush">
      <div className="card-head pad"><span className="lbl">Coming pay periods</span><span className="sub">Free after budgets</span></div>
      <div className="list">
        {rows.map((r) => (
          <button key={r.start} type="button" className={`row no-lead ${r.free < -0.004 ? 'is-low' : ''}`} onClick={() => onJump(isoDate(r.start))}>
            <span className="main-col">
              <span className="title">{fmtRange(r.start, r.end)}{r.now && <Chip tone="good">Now</Chip>}</span>
              <span className="sub">{fmtMoney(r.spending)} spending money{r.names.length ? ` · ${r.names.join(', ')}` : ''}{r.spent > 0 ? ` · ${fmtMoney(r.spent)} spent` : ''}</span>
            </span>
            <span className="trail"><Amount value={r.free} tone={r.free < -0.004 ? 'bad' : undefined} /><span className="sub">{r.free < -0.004 ? 'short' : 'free'}</span></span>
          </button>
        ))}
      </div>
      {short.length > 0 && <p className="sub pad">{short.length === 1 ? 'One pay period has' : `${short.length} pay periods have`} budgets adding up to more than the spending money (as much as {fmtMoney(-Math.min(...short.map((r) => r.free)))} more). Lower a budget for those weeks or move money between budgets.</p>}
    </section>
  );
}

function History({ engine, query: q }: { engine: PlanEngine; query: string }) {
    const groups = useMemo(() => historyGroups(engine, q), [engine, q]);
    if (!groups.length) return <section className="card"><p className="sub">{q ? 'No logs match your search.' : 'No spending logged yet.'}</p></section>;
    return (
      <>
        {groups.slice(0, 40).map((g) => (
          <section key={g.key} className="card flush">
            <div className="card-head pad"><span className="strong">{g.title}</span><span className="sub">{g.entries.length} log{g.entries.length === 1 ? '' : 's'} · {fmtMoney(g.total)}</span></div>
            <div className="list">{g.entries.map((e) => <LogRow key={e.id} e={e} />)}</div>
          </section>
        ))}
        {groups.length > 40 && <p className="sub center">Showing the 40 most recent pay periods. Search to find older logs.</p>}
      </>
    );
}

function Ring({ pct, over }: { pct: number; over: boolean }) {
  const r = 38, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <svg className="ring" viewBox="0 0 96 96" aria-hidden="true">
      <circle cx="48" cy="48" r={r} className="trk" />
      {p > 0.5 && <circle cx="48" cy="48" r={r} className="val" style={{ stroke: over ? 'var(--bad)' : 'var(--brass)' }} strokeDasharray={`${(p / 100) * c} ${c}`} transform="rotate(-90 48 48)" />}
    </svg>
  );
}
