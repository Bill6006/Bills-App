import { useEffect, useMemo, useRef, useState } from 'react';
import { addMonthsKey, fmtDow, fmtMonthLong, fmtShort, isMonthKey, monthLong, parseMonthKey, type MonthKey } from '../../engine/dates';
import { fmtMoney } from '../../engine/money';
import { navigate } from '../../app/router';
import { openSheet } from '../../state/sheets';
import { update, useActive } from '../../state/store';
import { useEngine } from '../../state/useEngine';
import { monthDetails, timelineModel, type DayGroup, type Entry, type TimelineGroup } from '../../state/models';
import type { PlanEngine } from '../../engine/plan';
import { Amount, Chip, DateBadge, Money, Note } from '../components/bits';
import { Segmented, Switch } from '../components/controls';
import { Sheet } from '../components/Sheet';
import { openEntry } from '../sheets/EntrySheet';
import { openWhy } from '../sheets/WhySheet';
import { IconArrowDown, IconArrowUp, IconChevronLeft, IconChevronRight, IconInfo } from '../icons';

export function Timeline({ monthParam }: { monthParam?: string }) {
  const engine = useEngine();
  const data = useActive();
  const todayMk = engine.today().slice(0, 7);
  const mk: MonthKey = isMonthKey(monthParam) ? monthParam : todayMk;
  const group = data.prefs.timelineGroup;
  const density = data.prefs.timelineDensity;
  const groups = useMemo(() => timelineModel(engine, mk, group, density), [engine, mk, group, density]);
  const todayRef = useRef<HTMLDivElement>(null);
  const todayBtnRef = useRef<HTMLButtonElement>(null);
  const [todayBtnVisible, setTodayBtnVisible] = useState(true);
  const [todayVisible, setTodayVisible] = useState(true);
  const [todayAbove, setTodayAbove] = useState(false);
  const hasToday = groups.some((g) => g.days.some((d) => d.isToday));

  useEffect(() => {
    const el = todayRef.current;
    if (!el) { setTodayVisible(false); return; }
    const io = new IntersectionObserver(([en]) => {
      setTodayVisible(en.isIntersecting);
      setTodayAbove(en.boundingClientRect.top < 0);
    }, { rootMargin: '-80px 0px -90px 0px' });
    io.observe(el);
    // A fast fling can jump today from above the screen to below it without it ever being on screen,
    // which the observer doesn't report; keep the arrow's direction right on every scroll.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; setTodayAbove(el.getBoundingClientRect().top < 0); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener('scroll', onScroll); if (frame) window.cancelAnimationFrame(frame); };
  }, [groups]);

  // Land on today the first time the current month opens.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || mk !== todayMk) return;
    landed.current = true;
    window.setTimeout(() => todayRef.current?.scrollIntoView({ block: 'center' }), 60);
  }, [mk, todayMk]);

  const goToday = () => {
    if (mk !== todayMk) {
      navigate('/timeline');
      landed.current = false;
    } else todayRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // "Today" sits at the right of the first section's heading; once that scrolls off screen, the same button floats
  // at the top. Both stay in the page and fade, so nothing shifts while scrolling.
  useEffect(() => {
    const el = todayBtnRef.current;
    if (!el) { setTodayBtnVisible(false); return; }
    const io = new IntersectionObserver(([en]) => setTodayBtnVisible(en.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [groups]);
  const needToday = !todayVisible || mk !== todayMk || !hasToday;
  const todayArrow = (mk === todayMk && hasToday ? !todayAbove : mk < todayMk) ? <IconArrowDown /> : <IconArrowUp />;

  const setPref = (k: 'timelineGroup' | 'timelineDensity', v: string) => update((d) => { (d.prefs as unknown as Record<string, string>)[k] = v; }, { real: true });
  const prevMk = addMonthsKey(mk, -1), nextMk = addMonthsKey(mk, 1);

  return (
    <div className="page timeline">
      <header className="page-head">
        <div className="titles">
          <div className="eyebrow">Timeline</div>
          <h1 className="page-title">{fmtMonthLong(mk)}</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" aria-label={`Previous month, ${monthLong(parseMonthKey(prevMk).m)}`} onClick={() => navigate(`/timeline/${prevMk}`)}><IconChevronLeft /></button>
          <button type="button" className="icon-btn" aria-label={`Next month, ${monthLong(parseMonthKey(nextMk).m)}`} onClick={() => navigate(`/timeline/${nextMk}`)}><IconChevronRight /></button>
        </div>
      </header>

      <div className="tl-controls">
        <Segmented label="Group by" value={group} onChange={(v) => setPref('timelineGroup', v)} options={[{ value: 'period', label: 'Pay periods' }, { value: 'month', label: 'Month' }]} />
        <label className="inline-switch"><Switch label="Show every day" checked={density === 'all'} onChange={(v) => setPref('timelineDensity', v ? 'all' : 'activity')} /><span>Every day</span></label>
        <button type="button" className="btn ghost sm" onClick={() => openMonthDetails(engine, mk)}><IconInfo />Month details</button>
      </div>

      <div className="tl-table-head" aria-hidden="true">
        <span>Date</span><span>What</span><span className="right">Amount</span><span className="right">Bills account</span><span className="right">Savings</span>
      </div>

      {groups.map((g, i) => (
        <Group key={g.key} g={g} engine={engine} todayRef={todayRef} cushion={engine.settings.cushion}
          side={i === 0 ? (
            <button type="button" ref={todayBtnRef} className={`btn ghost sm tl-today${needToday ? '' : ' off'}`} onClick={goToday}
              aria-hidden={!needToday} tabIndex={needToday ? 0 : -1}>{todayArrow}Today</button>
          ) : undefined} />
      ))}

      <button type="button" className={`floating-pill${needToday && !todayBtnVisible ? ' shown' : ''}`} onClick={goToday}
        aria-hidden={!(needToday && !todayBtnVisible)} tabIndex={needToday && !todayBtnVisible ? 0 : -1}>{todayArrow}Today</button>
    </div>
  );
}

function Group({ g, engine, todayRef, cushion, side }: { g: TimelineGroup; engine: PlanEngine; todayRef: React.RefObject<HTMLDivElement | null>; cushion: number; side?: React.ReactNode }) {
  const p = g.payday;
  return (
    <section className="tl-group">
      <div className="tl-group-head">
        <div className="grow">
          <div className="strong tl-group-title">{g.title} {g.isCurrent && <Chip tone="brass">Now</Chip>}</div>
          <div className="sub">
            {g.lowest && <>Lowest {fmtMoney(g.lowest.amount)} on {fmtShort(g.lowest.ms)}</>}
            {p && <> · <button type="button" className="tap-text" onClick={() => openWhy(engine, { kind: 'spending', paydayMs: p.ms })}>{fmtMoney(p.spending)} spending money</button></>}
            {p && p.planned > 0 && <> · <button type="button" className="tap-text" onClick={() => openWhy(engine, { kind: 'free', paydayMs: p.ms })}>{fmtMoney(p.free)} free after budgets</button></>}
          </div>
        </div>
        <div className="tl-group-side">
          {side}
          {p?.minimum && <Chip tone="warn">Under minimum</Chip>}
          {g.lowest && g.lowest.amount < cushion - 0.009 && <Chip tone="bad">Below cushion</Chip>}
        </div>
      </div>
      <div className="card flush tl-list">
        {g.days.length === 0 && <p className="sub pad">No money moves in this period.</p>}
        {g.days.map((d) => <Day key={d.ms} d={d} engine={engine} todayRef={todayRef} lowestMs={g.lowest?.ms} />)}
      </div>
    </section>
  );
}

function Day({ d, engine, todayRef, lowestMs }: { d: DayGroup; engine: PlanEngine; todayRef: React.RefObject<HTMLDivElement | null>; lowestMs?: number }) {
  return (
    <>
      {d.isToday && (
        <div className="today-line" ref={todayRef}>
          <span>Today · {fmtDow(d.ms)}</span>
          <button type="button" className="today-amt" onClick={() => openWhy(engine, { kind: 'billsToday' })}>Should have {fmtMoney(d.billsEnd)}</button>
        </div>
      )}
      {d.entries.length === 0 && !d.isToday && (
        <div className={`row tl-row quiet ${d.isPast ? 'is-past' : ''}`}>
          <DateBadge ms={d.ms} /><span className="main-col"><span className="sub">No activity</span></span>
          <span className="tl-amt" /><span className="trail tl-bal"><span className="sub">{fmtMoney(d.billsEnd)}</span></span><span className="tl-sav sub">{fmtMoney(d.savingsEnd)}</span>
        </div>
      )}
      {d.entries.map((e, i) => <EntryRow key={e.key} e={e} first={i === 0} engine={engine} isLowest={e.ms === lowestMs && i === d.entries.length - 1 && e.kind === 'bill'} past={d.isPast} />)}
    </>
  );
}

function EntryRow({ e, first, engine, isLowest, past }: { e: Entry; first: boolean; engine: PlanEngine; isLowest: boolean; past: boolean }) {
  const isW = e.kind === 'withdrawal';
  return (
    <button type="button" className={`row tl-row ${e.kind === 'payday' ? 'is-pay' : ''} ${e.kind === 'adjust' ? 'is-adjust' : ''} ${isLowest ? 'is-low' : ''} ${past ? 'is-past' : ''} ${first ? '' : 'cont'}`} onClick={() => openEntry(engine, e)}>
      {first ? <DateBadge ms={e.ms} /> : <span className="datebadge" aria-hidden="true" />}
      <span className="main-col">
        <span className="title">
          {e.title} {e.debtId && <Chip tone="bills">Loan</Chip>} {isW && <Chip tone="good">Savings</Chip>} {isLowest && <Chip tone="warn">Lowest</Chip>}
        </span>
        {e.kind === 'payday' && <span className="sub">+{fmtMoney(e.savingsMove || 0)} to Savings</span>}
        {e.detail && <span className="sub">{e.detail}</span>}
      </span>
      <span className="tl-amt"><Amount value={e.amount} signed tone={e.amount > 0 ? 'pos' : undefined} /></span>
      <span className="trail tl-bal">
        <span className="tl-amt-m"><Amount value={e.amount} signed tone={e.amount > 0 ? 'pos' : undefined} /></span>
        <span className="sub">{isW ? `Savings ${fmtMoney(e.savingsAfter)}` : fmtMoney(e.billsAfter)}</span>
      </span>
      <span className="tl-sav sub">{fmtMoney(e.savingsAfter)}</span>
    </button>
  );
}

export function openMonthDetails(engine: PlanEngine, mk: MonthKey) {
  openSheet((close) => <MonthDetailsSheet engine={engine} mk={mk} onClose={close} />);
}

function MonthDetailsSheet({ engine, mk, onClose }: { engine: PlanEngine; mk: MonthKey; onClose: () => void }) {
  const d = monthDetails(engine, mk);
  const p = d.plan;
  const next = monthLong(parseMonthKey(addMonthsKey(mk, 1)).m);
  const Item = ({ label, old, value, onWhy, tone }: { label: string; old?: string; value: number; onWhy?: () => void; tone?: string }) => (
    <button type="button" className="row no-lead md-row" onClick={onWhy} disabled={!onWhy}>
      <span className="main-col"><span className="title-wrap">{label}</span>{old && <span className="sub">v117: {old}</span>}</span>
      <span className={`amt ${tone || ''}`}>{fmtMoney(value)}</span>
    </button>
  );
  return (
    <Sheet title={fmtMonthLong(mk)} eyebrow="Month details" onClose={onClose}>
      <div className="card flush"><div className="list">
        <Item label="Should have on the 1st" old="AS2 / Start balance" value={d.startBalance} onWhy={() => openWhy(engine, { kind: 'needed', mk })} />
        <Item label="Bills this month" old="Bills total" value={d.billsTotal} />
        <Item label="Move to Bills each payday" old="Fixed transfer per payday" value={p.billsPerPaycheck} onWhy={() => openWhy(engine, { kind: 'billsMove', mk })} />
        <Item label="Move to Savings each payday" value={p.savingsPerPaycheck} />
        <Item label="Lowest point" old="Lowest projected bills balance" value={p.lowestBillsBal} tone={p.lowestBillsBal < engine.settings.cushion - 0.009 ? 'bad-t' : ''} />
        <Item label="Should have at month end" old="End-of-month Bills" value={d.endBalance} />
        <Item label={`Carry into ${next}`} old="Target carry" value={p.TargetCarry} />
      </div></div>
      <div className="card flush"><div className="list">
        <Item label="Paychecks this month" value={d.paychecksTotal} />
        <Item label="Spending money this month" value={d.spendingMoneyTotal} />
        <Item label="Budgets this month" old="Pocket-only extra costs" value={d.budgetsTotal} />
        <Item label="Bills plus budgets" old="Bills + pocket costs" value={Math.round((d.billsTotal + d.budgetsTotal) * 100) / 100} />
        <Item label="Free after budgets" old="Pocket leftover (month)" value={d.freeTotal} />
      </div></div>
      {p.extraFunding > 0.009 && <Note tone="bad">This month needs {fmtMoney(p.extraFunding)} more at the start than your paychecks can move in time.</Note>}
      <div className="card">
        <div className="row-between"><span className="sub">Savings</span><span><Money value={p.startSavings} size="sm" /> <span className="sub">→</span> <Money value={p.endSavings} size="sm" /></span></div>
      </div>
    </Sheet>
  );
}
