import { useMemo } from 'react';
import { fmtDow, fmtLong, fmtMonthShort, fmtShort, isoDate, parseISOToMs } from '../../engine/dates';
import { fmtMoney, fmtSigned, round2 } from '../../engine/money';
import { monthsLabel } from '../../engine/loans';
import { navigate } from '../../app/router';
import { useEngine, useRealEngine } from '../../state/useEngine';
import { update, useActive } from '../../state/store';
import { homeModel, type Entry, type PaydayInfo } from '../../state/models';
import { Guilloche } from '../components/Guilloche';
import { Amount, DateBadge, Meter, Money, Note, SplitBar } from '../components/bits';
import { openWhy } from '../sheets/WhySheet';
import { openEntry } from '../sheets/EntrySheet';
import { IconCheck, IconChevronRight, IconSliders } from '../icons';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home() {
  const engine = useEngine();
  const data = useActive();
  const m = useMemo(() => homeModel(engine), [engine]);
  const real = useRealEngine();
  const realNow = real ? real.rowFor(m.todayMs)?.billsBalanceWorking ?? null : null;
  const todayIso = engine.today();
  const cushion = engine.settings.cushion;
  const cur = m.current;
  const spent = cur.snapshot.totals.spent;
  const budget = cur.snapshot.totals.budget;
  const startPay = cur.startPayday;
  const showChecklist = startPay && parseISOToMs(todayIso) - startPay.ms <= 3 * 86400000;

  return (
    <div className="page home">
      <header className="page-head">
        <div className="titles">
          <div className="eyebrow">{greeting()}</div>
          <h1 className="page-title">{fmtLong(m.todayMs).replace(/,.*$/, '')}, {fmtShort(m.todayMs)}</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" aria-label="Settings" onClick={() => navigate('/plan/settings')}><IconSliders /></button>
        </div>
      </header>

      <div className="home-grid">
        <div className="home-col">
          <button type="button" className="hero hero-tap" onClick={() => openWhy(engine, { kind: 'billsToday' })} aria-label={`Bills account should have ${fmtMoney(m.billsNow)} today. Tap for details.`}>
            <Guilloche />
            <span className="lbl">Bills account should have today</span>
            <Money value={m.billsNow} size="hero" />
            {m.billsBeforeTodaysBills != null && (
              <span className="hero-sub">Before today's {m.todaysBills.map((b) => b.title).join(', ')}: <b>{fmtMoney(m.billsBeforeTodaysBills)}</b></span>
            )}
            {realNow != null && (
              <span className="hero-sub whatif-diff">{Math.abs(realNow - m.billsNow) < 0.005 ? 'Same as your real plan' : <>Real plan <b>{fmtMoney(realNow)}</b> · what-if {fmtSigned(round2(m.billsNow - realNow))}</>}</span>
            )}
            <span className="hero-meta">
              {m.lowest && <span>Lowest this pay period: <b>{fmtMoney(m.lowest.amount)}</b> {m.lowest.ms === m.todayMs ? 'today' : `on ${fmtDow(m.lowest.ms)}`}</span>}
              <span>Cushion: <b>{fmtMoney(cushion)}</b></span>
            </span>
          </button>

          <button type="button" className="card tap" onClick={() => navigate('/spending')}>
            <div className="lbl">Left to spend until payday</div>
            <div className="card-head end">
              <Money value={cur.snapshot.totals.remaining} size="md" />
              <div className="right sub">
                {cur.perDay > 0 ? <>About {fmtMoney(cur.perDay)} a day<br /></> : null}
                {cur.daysLeft} day{cur.daysLeft === 1 ? '' : 's'} until {fmtShort(cur.period.endMs + 86400000)}
              </div>
            </div>
            <Meter pct={budget > 0 ? (spent / budget) * 100 : 0} tone={spent > budget ? 'bad' : undefined} label="Spent this pay period" />
            <div className="row-between sub"><span>{fmtMoney(spent)} spent of {fmtMoney(budget)}</span><span className="link-btn">Spending <IconChevronRight /></span></div>
          </button>

          {showChecklist && startPay && <PaydayChecklist info={startPay} checks={data.prefs.paydayChecks[isoDate(startPay.ms)] || {}} isToday={startPay.ms === m.todayMs} />}

          {m.nextPayday && <NextPayday info={m.nextPayday} days={m.daysToPayday ?? 0} onWhy={(k) => openWhy(engine, k === 'bills' ? { kind: 'billsMove', mk: m.nextPayday!.planMonth } : k === 'free' ? { kind: 'free', paydayMs: m.nextPayday!.ms } : { kind: 'spending', paydayMs: m.nextPayday!.ms })} />}
        </div>

        <div className="home-col">
          {m.alerts.length > 0 && (
            <div className="stack">
              {m.alerts.map((a) => (
                <Note key={a.id} tone={a.tone === 'bad' ? 'bad' : a.tone === 'info' ? 'info' : 'warn'}
                  action={a.action ? <button type="button" className="link-btn" onClick={() => navigate(a.action!.to)}>{a.action.label} <IconChevronRight /></button> : undefined}>
                  {a.text}
                </Note>
              ))}
            </div>
          )}

          <section className="card flush">
            <div className="card-head pad"><span className="lbl">Coming up</span><button type="button" className="link-btn" onClick={() => navigate('/timeline')}>Timeline <IconChevronRight /></button></div>
            {m.comingUp.length ? (
              <div className="list">{m.comingUp.map((e) => <ComingRow key={e.key} e={e} lowestMs={m.lowest?.ms} onOpen={() => openEntry(engine, e)} />)}</div>
            ) : <p className="sub pad">Nothing due in the next three weeks.</p>}
          </section>

          <div className="glance">
            <button type="button" className="card tap" onClick={() => openWhy(engine, { kind: 'savingsToday' })}>
              <span className="lbl">Savings should have</span>
              <Money value={m.savingsNow} size="sm" cents={false} />
              <span className="sub pos">{fmtMoney(m.savingsEndOfMonth)} by month end</span>
            </button>
            <button type="button" className="card tap" onClick={() => navigate('/plan/loans')}>
              <span className="lbl">Loans</span>
              {m.loans.activeCount ? (
                <>
                  <Money value={m.loans.totalBalance} size="sm" cents={false} />
                  <span className="sub">{m.loans.nextPayoff ? `${m.loans.nextPayoff.name} paid off ${fmtMonthShort(m.loans.nextPayoff.month)}` : monthsLabel(m.loans.longestMonths)}</span>
                </>
              ) : <span className="sub">No loans</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComingRow({ e, lowestMs, onOpen }: { e: Entry; lowestMs?: number; onOpen: () => void }) {
  return (
    <button type="button" className={`row ${e.kind === 'payday' ? 'is-pay' : ''} ${e.kind === 'adjust' ? 'is-adjust' : ''}`} onClick={onOpen}>
      <DateBadge ms={e.ms} />
      <span className="main-col">
        <span className="title">{e.title} {e.debtId && <span className="chip bills">Loan</span>} {e.ms === lowestMs && e.kind === 'bill' && <span className="chip warn">Lowest</span>}</span>
        <span className="sub">{e.kind === 'withdrawal' ? `Savings after: ${fmtMoney(e.savingsAfter)}` : e.kind === 'adjust' ? `${e.detail}. Bills after: ${fmtMoney(e.billsAfter)}` : `Bills after: ${fmtMoney(e.billsAfter)}`}</span>
      </span>
      <span className="trail"><Amount value={e.amount} signed tone={e.amount > 0 ? 'pos' : undefined} /></span>
    </button>
  );
}

function NextPayday({ info, days, onWhy }: { info: PaydayInfo; days: number; onWhy: (k: 'bills' | 'spending' | 'free') => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <div className="lbl">Next payday</div>
          <div className="strong">{fmtDow(info.ms)} · {days === 1 ? 'tomorrow' : `in ${days} days`}</div>
        </div>
        <Amount value={info.paycheck} />
      </div>
      <SplitBar parts={[
        { value: info.billsMove, cls: 'bg-bills', label: 'Move to Bills' },
        { value: info.savingsMove, cls: 'bg-save', label: 'Move to Savings' },
        { value: Math.max(0, info.spending), cls: 'bg-brass', label: 'Yours to spend' },
      ]} />
      <div className="legend">
        <button type="button" className="legend-row" onClick={() => onWhy('bills')}><i className="dot bg-bills" /><span>Move to Bills</span><Amount value={info.billsMove} /></button>
        <div className="legend-row"><i className="dot bg-save" /><span>Move to Savings</span><Amount value={info.savingsMove} /></div>
        <button type="button" className="legend-row" onClick={() => onWhy('spending')}><i className="dot bg-brass" /><span>Yours to spend</span><Amount value={info.spending} /></button>
      </div>
      {info.planned > 0 && (
        <button type="button" className="row-between sub tap-text" onClick={() => onWhy('free')}>
          <span>Budgets take {fmtMoney(info.planned)}, leaving</span><span className={info.minimum ? 'warn-t strong' : 'strong'}>{fmtMoney(info.free)} free</span>
        </button>
      )}
      {info.minimum && (
        <Note tone="warn">{info.minimum.mode === 'base' ? `Spending money is ${fmtMoney(info.minimum.shortBy)} under your ${fmtMoney(info.minimum.minimum)} minimum.` : `That's ${fmtMoney(info.minimum.shortBy)} under your ${fmtMoney(info.minimum.minimum)} minimum.`}</Note>
      )}
    </section>
  );
}

function PaydayChecklist({ info, checks, isToday }: { info: PaydayInfo; checks: { bills?: boolean; savings?: boolean }; isToday: boolean }) {
  const key = isoDate(info.ms);
  const toggle = (k: 'bills' | 'savings') => update((d) => {
    const cur = d.prefs.paydayChecks[key] || {};
    d.prefs.paydayChecks[key] = { ...cur, [k]: !cur[k] };
  }, { real: true });
  const done = !!checks.bills && !!checks.savings;
  return (
    <section className={`card checklist ${done ? 'done' : ''}`}>
      <div className="card-head">
        <div>
          <div className="lbl">{isToday ? "Today's payday" : `Payday · ${fmtDow(info.ms)}`}</div>
          <div className="strong">{done ? 'All moved. Nice.' : 'Move your money'}</div>
        </div>
        <Amount value={info.paycheck} />
      </div>
      {(['bills', 'savings'] as const).map((k) => (
        <button key={k} type="button" className={`check-row ${checks[k] ? 'on' : ''}`} role="checkbox" aria-checked={!!checks[k]} onClick={() => toggle(k)}>
          <span className="box">{checks[k] && <IconCheck />}</span>
          <span className="grow">{k === 'bills' ? 'Move to Bills' : 'Move to Savings'}</span>
          <Amount value={k === 'bills' ? info.billsMove : info.savingsMove} />
        </button>
      ))}
    </section>
  );
}
