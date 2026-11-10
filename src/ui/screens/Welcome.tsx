import sample from '../../data/sample.v117.json';
import { importV117 } from '../../data/importV117';
import { navigate } from '../../app/router';
import { replaceAll, useStore } from '../../state/store';
import { Guilloche } from '../components/Guilloche';
import { openImport } from '../sheets/ImportSheet';
import { IconFile, IconLock, IconSparkle, IconDollar, IconRefresh } from '../icons';
import { syncAvailable } from '../../sync/config';
import { restoreWithSavedPassword, useSync } from '../../sync/sync';
import { toast } from '../../state/toast';
import { openRestoreSheet } from './plan/SyncPage';

export function Welcome() {
  const today = useStore((s) => s.today);
  const restoring = useSync((s) => s.phase === 'working');
  const restoreFromCloud = async () => {
    const r = await restoreWithSavedPassword();
    if (r?.ok) return;
    if (r) toast(r.message);
    openRestoreSheet();
  };
  const loadSample = () => {
    const { data } = importV117(sample, today, { fileName: 'sample' });
    data.meta.sample = true;
    data.meta.importedFrom = undefined;
    replaceAll(data, 'Sample data loaded. Clear it any time from Plan.');
  };
  return (
    <div className="page page-narrow welcome">
      <section className="hero welcome-hero">
        <Guilloche x={0.82} y={0.42} scale={1.25} />
        <span className="lbl">Bills Planner</span>
        <h1 className="welcome-title">Every paycheck, <em>already planned</em></h1>
        <p className="welcome-lede">Tell it your paycheck and bills once. On every payday it shows what to move to Bills, what to save, and what's yours to spend, and today what each account should have.</p>
      </section>

      <div className="welcome-actions">
        {syncAvailable() && (
          <button type="button" className="card tap welcome-option primary" disabled={restoring} onClick={() => void restoreFromCloud()}>
            <span className="icon-badge s"><IconRefresh /></span>
            <span className="main-col"><span className="title-wrap strong">{restoring ? 'Restoring…' : 'Restore from the cloud'}</span><span className="sub">Already use cloud sync? Get all your data back with your sync password.</span></span>
          </button>
        )}
        <button type="button" className={`card tap welcome-option${syncAvailable() ? '' : ' primary'}`} onClick={openImport}>
          <span className="icon-badge p"><IconFile /></span>
          <span className="main-col"><span className="title-wrap strong">Import from Bills Account Planner</span><span className="sub">Bring over everything from your v117 export.</span></span>
        </button>
        <button type="button" className="card tap welcome-option" onClick={loadSample}>
          <span className="icon-badge s"><IconSparkle /></span>
          <span className="main-col"><span className="title-wrap strong">Look around with sample data</span><span className="sub">Made-up bills, loans and budgets. Clear it whenever you like.</span></span>
        </button>
        <button type="button" className="card tap welcome-option" onClick={() => navigate('/plan/income')}>
          <span className="icon-badge b"><IconDollar /></span>
          <span className="main-col"><span className="title-wrap strong">Start from scratch</span><span className="sub">Begin with your paycheck, then add bills.</span></span>
        </button>
      </div>

      <p className="sub center"><IconLock className="inline-icon" /> Your data stays on this device. Nothing is uploaded unless you turn on cloud sync, which encrypts it first.</p>
    </div>
  );
}
