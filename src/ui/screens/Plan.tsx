import { navigate } from '../../app/router';
import { backupFileName, makeBackupText, saveTextFile } from '../../data/backup';
import { setTimeZone, update, useActive, useStore } from '../../state/store';
import { toast } from '../../state/toast';
import { Segmented } from '../components/controls';
import { openImport } from '../sheets/ImportSheet';
import { IconChevronLeft, IconDownload, IconFile } from '../icons';
import type { ThemePref } from '../../engine/types';

/** Temporary Plan screen: backup, import and settings work; the planning pages land in the next update. */
export function Plan({ parts }: { parts: string[] }) {
  const page = parts[0] || '';
  if (page === 'backup') return <Backup />;
  if (page === 'settings') return <Settings />;
  return (
    <div className="page page-narrow">
      <header className="page-head"><div className="titles"><div className="eyebrow">Your setup</div><h1 className="page-title">Plan</h1></div></header>
      {page && <p className="sub">That page arrives in the next update.</p>}
      <div className="tiles">
        <button type="button" className="tile" onClick={() => navigate('/plan/backup')}><span className="t">Backup &amp; import</span><span className="sub">Save a copy or bring data in</span></button>
        <button type="button" className="tile" onClick={() => navigate('/plan/settings')}><span className="t">Settings</span><span className="sub">Theme and time zone</span></button>
      </div>
      <p className="sub">Income, bills, budgets, savings and loans pages arrive in the next update.</p>
    </div>
  );
}

function Back({ title }: { title: string }) {
  return (
    <header className="page-head">
      <div className="titles"><button type="button" className="link-btn back" onClick={() => navigate('/plan')}><IconChevronLeft />Plan</button><h1 className="page-title">{title}</h1></div>
    </header>
  );
}

function Backup() {
  const data = useActive();
  const today = useStore((s) => s.today);
  const exportNow = async () => {
    const res = await saveTextFile(makeBackupText(data), backupFileName(today));
    if (res !== 'cancelled') {
      update((d) => { d.meta.lastBackupAt = new Date().toISOString(); }, { real: true });
      toast(res === 'shared' ? 'Backup shared.' : 'Backup saved to your downloads.');
    }
  };
  return (
    <div className="page page-narrow">
      <Back title="Backup & import" />
      <section className="card">
        <span className="lbl">Back up</span>
        <p className="sub" style={{ fontSize: 14 }}>Saves everything to a file you keep. {data.meta.lastBackupAt ? `Last backup ${data.meta.lastBackupAt.slice(0, 10)}.` : 'No backup yet.'}</p>
        <button type="button" className="btn" onClick={() => void exportNow()}><IconDownload />Save a backup</button>
      </section>
      <section className="card">
        <span className="lbl">Import</span>
        <p className="sub" style={{ fontSize: 14 }}>From a Bills Account Planner export or one of these backups. You'll see a preview first.</p>
        <button type="button" className="btn ghost" onClick={openImport}><IconFile />Import a file</button>
      </section>
    </div>
  );
}

function Settings() {
  const data = useActive();
  return (
    <div className="page page-narrow">
      <Back title="Settings" />
      <section className="card">
        <span className="lbl">Theme</span>
        <Segmented<ThemePref> label="Theme" value={data.prefs.theme} onChange={(v) => update((d) => { d.prefs.theme = v; }, { real: true })}
          options={[{ value: 'system', label: 'Match phone' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
      </section>
      <section className="card">
        <span className="lbl">Today's date comes from</span>
        <Segmented label="Time zone" value={data.prefs.timeZone === 'device' ? 'device' : 'et'} onChange={(v) => setTimeZone(v === 'device' ? 'device' : 'America/New_York')}
          options={[{ value: 'et', label: 'Eastern time' }, { value: 'device', label: "This phone's time zone" }]} />
      </section>
    </div>
  );
}
