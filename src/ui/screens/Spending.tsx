import { useMemo } from 'react';
import { fmtRange } from '../../engine/dates';
import { useEngine } from '../../state/useEngine';
import { currentPeriod } from '../../state/models';
import { Money } from '../components/bits';

/** Temporary: the full Spending screen (budgets, logging, history, trends) lands in the next update. */
export function Spending() {
  const engine = useEngine();
  const cur = useMemo(() => currentPeriod(engine, engine.today()), [engine]);
  return (
    <div className="page page-narrow">
      <header className="page-head"><div className="titles"><div className="eyebrow">{fmtRange(cur.period.startMs, cur.period.endMs)}</div><h1 className="page-title">Spending</h1></div></header>
      <section className="card">
        <span className="lbl">Left this pay period</span>
        <Money value={cur.snapshot.totals.remaining} size="md" />
        <p className="sub">Budgets, logging purchases, history and trends arrive in the next update.</p>
      </section>
    </div>
  );
}
