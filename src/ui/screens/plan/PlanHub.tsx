import { useEffect, useState, type ReactNode } from 'react';
import { addDaysMs, fmtMedium, fmtMonthLong, fmtRange, fmtShort, parseISOToMs } from '../../../engine/dates';
import { fmtMoney, round2 } from '../../../engine/money';
import { loanOutlook } from '../../../engine/loans';
import type { ThemePref } from '../../../engine/types';
import { navigate } from '../../../app/router';
import { backupFileName, makeBackupText, saveTextFile } from '../../../data/backup';
import { makeDefaultData } from '../../../data/defaults';
import { describePay } from '../../../data/importV117';
import { currentPeriod, nextPaydayOnOrAfter, paydayInfo, type PaydayInfo } from '../../../state/models';
import { discardWhatIf, keepWhatIf, replaceAll, setTimeZone, startWhatIf, update, useActive, useStore } from '../../../state/store';
import { toast } from '../../../state/toast';
import { useEngine } from '../../../state/useEngine';
import { Chip, Note } from '../../components/bits';
import { Field, MoneyInput, Segmented, TextInput } from '../../components/controls';
import { openImport } from '../../sheets/ImportSheet';
import {
  IconCard, IconChevronRight, IconDollar, IconDownload, IconEnvelope, IconFile, IconFlask, IconGear, IconReceipt, IconShield, IconTrend,
} from '../../icons';
import { BillsPage, BudgetsPage } from './Bills';
import { IncomePage } from './Income';
import { LoansPage } from './Loans';
import { SavingsPage } from './Savings';
import { PlanHeader } from './common';
import { BankPage } from './BankPage';
import { SyncPage } from './SyncPage';
import { syncAvailable } from '../../../sync/config';
import { syncedAgo, turnOff, useSync, type SyncView } from '../../../sync/sync';
import { IconRefresh } from '../../icons';

/** /plan and its pages. */
export function Plan({ parts }: { parts: string[] }) {
  const [page, sub] = parts;
  switch (page) {
    case 'income': return <IncomePage sub={sub} />;
    case 'bills': return <BillsPage sub={sub} />;
    case 'budgets': return <BudgetsPage sub={sub} />;
    case 'savings': return <SavingsPage sub={sub} />;
    case 'loans': return <LoansPage sub={sub} />;
    case 'safety': return <SafetyPage />;
    case 'settings': return <SettingsPage />;
    case 'backup': return <BackupPage />;
    case 'sync': return <SyncPage />;
    case 'bank': return <BankPage />;
    default: return <Hub />;
  }
}

function Tile({ icon, tone, title, value, sub, to }: { icon: ReactNode; tone: string; title: string; value: ReactNode; sub?: ReactNode; to: string }) {
  return (
    <button type="button" className="tile plan-tile" onClick={() => navigate(to)}>
      <span className="tile-top"><span className={`icon-badge ${tone}`}>{icon}</span><IconChevronRight /></span>
      <span className="t">{title}</span>
      <span className="v">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </button>
  );
}

function Hub() {
  const data = useActive();
  const engine = useEngine();
  const whatIf = useStore((s) => s.whatIf);
  const today = engine.today();
  const s = data.settings;
  const todayMs = parseISOToMs(today);
  const mk = today.slice(0, 7);
  const core = engine.core(mk);
  let billsMonth = 0;
  for (const list of core.occ.values()) for (const it of list) if (!it.debtId) billsMonth += it.amount;
  const nextPay = nextPaydayOnOrAfter(engine, addDaysMs(todayMs, 1));
  const cur = currentPeriod(engine, today);
  const row = engine.rowFor(todayMs);
  const active = data.debts.filter((d) => d.balance > 0);
  const owed = round2(active.reduce((t, d) => t + d.balance, 0));
  const lastPayoff = active.reduce((m, d) => { const p = loanOutlook(d, today).payoffMk; return p && p > m ? p : m; }, '');
  const backupAge = data.meta.lastBackupAt ? Math.floor((Date.now() - Date.parse(data.meta.lastBackupAt)) / 86400000) : null;
  const sync = useSync();

  return (
    <div className="page page-narrow">
      <header className="page-head"><div className="titles"><div className="eyebrow">Your setup</div><h1 className="page-title">Plan</h1></div></header>

      {!whatIf ? (
        <button type="button" className="card tap whatif-card" onClick={() => { startWhatIf(); toast('What-if mode is on. Change anything, then keep it or discard it.'); }}>
          <span className="icon-badge p"><IconFlask /></span>
          <span className="main-col"><span className="strong">Try a what-if</span><span className="sub">Change a bill, your pay or a loan payment and see the effect. Nothing is saved unless you keep it.</span></span>
          <IconChevronRight />
        </button>
      ) : (
        <section className="card whatif-card on">
          <span className="icon-badge p"><IconFlask /></span>
          <span className="main-col"><span className="strong">What-if mode is on</span><span className="sub">Edits below aren't saved until you keep them.</span></span>
          <span className="btn-row"><button type="button" className="btn sm ghost" onClick={discardWhatIf}>Discard</button><button type="button" className="btn sm" onClick={keepWhatIf}>Keep</button></span>
        </section>
      )}

      <div className="tiles">
        <Tile icon={<IconDollar />} tone="s" title="Income" to="/plan/income"
          value={s.pay.paycheckCap > 0 ? describePay(s.pay) : 'Not set up'} sub={s.pay2 ? 'Plus a second paycheck' : nextPay != null ? `Next payday ${fmtShort(nextPay)}` : undefined} />
        <Tile icon={<IconReceipt />} tone="b" title="Bills" to="/plan/bills"
          value={`${data.bills.length} bill${data.bills.length === 1 ? '' : 's'}`} sub={`${fmtMoney(round2(billsMonth))} this month`} />
        <Tile icon={<IconEnvelope />} tone="p" title="Spending budgets" to="/plan/budgets"
          value={`${data.extras.length} budget${data.extras.length === 1 ? '' : 's'}`} sub={cur.startPayday ? `${fmtMoney(cur.startPayday.planned)} this pay period` : undefined} />
        <Tile icon={<IconTrend />} tone="s" title="Savings" to="/plan/savings"
          value={fmtMoney(row?.savingsBalance ?? 0)} sub={`${fmtMoney(s.savings.monthlyGoal)} a month${data.events.length ? ` · ${data.events.length} withdrawal${data.events.length === 1 ? '' : 's'}` : ''}`} />
        <Tile icon={<IconCard />} tone="b" title="Loans" to="/plan/loans"
          value={active.length ? fmtMoney(owed) : data.debts.length ? 'All paid off' : 'None'} sub={active.length ? (lastPayoff ? `Debt-free ${fmtMonthLong(lastPayoff)}` : 'Check the payment') : undefined} />
        <Tile icon={<IconShield />} tone="w" title="Safety net" to="/plan/safety"
          value={`${fmtMoney(s.cushion)} cushion`} sub={s.pocket.minimumSurvival > 0 ? `Warn under ${fmtMoney(s.pocket.minimumSurvival)}` : 'No minimum set'} />
        <Tile icon={<IconFile />} tone="p" title="Bank import" to="/plan/bank"
          value={data.bank.lastImportAt ? `Imported ${fmtShort(Date.parse(data.bank.lastImportAt))}` : 'Not set up'}
          sub={data.bank.txns.some((t) => t.status === 'review') ? `${data.bank.txns.filter((t) => t.status === 'review').length} to review` : 'Files purchases for you'} />
        {syncAvailable() && <Tile icon={<IconRefresh />} tone="s" title="Cloud sync" to="/plan/sync" value={syncTileValue(sync)} />}
        <Tile icon={<IconDownload />} tone="n" title="Backup & import" to="/plan/backup"
          value={backupAge == null ? 'No backup yet' : backupAge === 0 ? 'Backed up today' : `Backed up ${backupAge}d ago`} />
        <Tile icon={<IconGear />} tone="n" title="Settings" to="/plan/settings"
          value={data.prefs.theme === 'system' ? 'Matches your phone' : data.prefs.theme === 'dark' ? 'Dark theme' : 'Light theme'} />
      </div>
    </div>
  );
}

function syncTileValue(v: SyncView): string {
  switch (v.phase) {
    case 'off': return 'Off';
    case 'working': return 'Syncing…';
    case 'offline': return 'Offline';
    case 'idle': return v.remote ? `Synced ${syncedAgo(v.syncedAt)}` : 'On';
    default: return 'Needs attention';
  }
}

// ---------- Safety net ----------

function SafetyPage() {
  const data = useActive();
  const engine = useEngine();
  const today = engine.today();
  const s = data.settings;
  const periods: PaydayInfo[] = [];
  let ms: number | null = nextPaydayOnOrAfter(engine, parseISOToMs(today) - 20 * 86400000);
  for (let g = 0; g < 12 && ms != null && periods.length < 6; g++) {
    const info = paydayInfo(engine, ms);
    if (info && info.periodEnd >= parseISOToMs(today)) periods.push(info);
    ms = nextPaydayOnOrAfter(engine, addDaysMs(ms, 1));
  }
  const mode = s.pocket.thresholdMode;

  return (
    <div className="page page-narrow">
      <PlanHeader title="Safety net" />
      <section className="card">
        <Field label="Cushion in the Bills account" hint="Always kept on top of what bills need, so a bill that comes in a little high is covered. It's part of what the Bills account should have.">
          {(id) => <MoneyInput id={id} value={s.cushion} onChange={(v) => Number.isFinite(v) && update((d) => { d.settings.cushion = Math.max(0, round2(v)); })} />}
        </Field>
      </section>
      <section className="card">
        <Field label="Minimum spending money" hint="You'll get a heads-up on Home when a pay period leaves less than this. It doesn't change any transfer.">
          {(id) => <MoneyInput id={id} value={s.pocket.minimumSurvival} onChange={(v) => Number.isFinite(v) && update((d) => { d.settings.pocket.minimumSurvival = Math.max(0, round2(v)); })} />}
        </Field>
        <div className="field"><span className="lbl">Compare it with</span>
          <Segmented label="Compare the minimum with" value={mode} onChange={(v) => update((d) => { d.settings.pocket.thresholdMode = v; })}
            options={[{ value: 'net', label: 'Free after budgets' }, { value: 'base', label: 'All spending money' }]} />
        </div>
      </section>
      {periods.length > 0 && (
        <section className="card flush">
          <div className="pad"><span className="lbl">Coming pay periods</span></div>
          <div className="list">
            {periods.map((p) => {
              const value = mode === 'base' ? p.spending : p.free;
              const under = !!p.minimum;
              return (
                <div key={p.ms} className={`row no-lead ${under ? 'is-low' : ''}`}>
                  <span className="main-col"><span className="title">{fmtRange(p.ms, p.periodEnd)}</span><span className="sub">{fmtMoney(p.spending)} spending money · {fmtMoney(p.planned)} budgeted</span></span>
                  <span className="trail"><span className={`amt ${value < 0 ? 'bad' : ''}`}>{fmtMoney(value)}</span>{under ? <Chip tone="warn">{fmtMoney(p.minimum!.shortBy)} under</Chip> : <span className="sub">{mode === 'base' ? 'spending money' : 'free'}</span>}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- Backup ----------

function BackupPage() {
  const data = useActive();
  const today = useStore((s) => s.today);
  const exportNow = async () => {
    const res = await saveTextFile(makeBackupText(useStore.getState().data), backupFileName(today));
    if (res !== 'cancelled') {
      update((d) => { d.meta.lastBackupAt = new Date().toISOString(); }, { real: true });
      toast(res === 'shared' ? 'Backup shared.' : 'Backup saved to your downloads.');
    }
  };
  const last = data.meta.lastBackupAt;
  const syncOn = useSync((s) => s.phase !== 'off');
  return (
    <div className="page page-narrow">
      <PlanHeader title="Backup & import" />
      {syncAvailable() && !syncOn && (
        <button type="button" className="card tap whatif-card" onClick={() => navigate('/plan/sync')}>
          <span className="icon-badge s"><IconRefresh /></span>
          <span className="main-col"><span className="strong">Turn on cloud sync</span><span className="sub">Keeps an encrypted copy up to date for you, so you don't have to rely on backup files.</span></span>
          <IconChevronRight />
        </button>
      )}
      <section className="card">
        <span className="lbl">Back up</span>
        <p className="sub body">{syncOn ? 'Cloud sync keeps a copy for you. A backup file is an extra copy you keep yourself, in Files, Google Drive or your email.' : 'Everything lives on this device only. A backup is one small file you can keep in Files, Google Drive or your email.'} {last ? `Last backup: ${fmtMedium(Date.parse(last))}.` : 'You have no backup yet.'}</p>
        <button type="button" className="btn" onClick={() => void exportNow()}><IconDownload />Save a backup</button>
      </section>
      <section className="card">
        <span className="lbl">Import or restore</span>
        <p className="sub body">From a Bills Account Planner export (v117 or older) or one of these backups. You'll see what's in it before anything changes, and you can undo it right after.</p>
        <button type="button" className="btn ghost" onClick={openImport}><IconFile />Choose a file</button>
      </section>
      {data.meta.importedFrom && <p className="sub">Imported from Bills Account Planner on {fmtMedium(Date.parse(data.meta.importedFrom.at))}{data.meta.importedFrom.fileName ? ` (${data.meta.importedFrom.fileName})` : ''}.</p>}
    </div>
  );
}

// ---------- Settings ----------

function SettingsPage() {
  const data = useActive();
  const whatIf = useStore((s) => s.whatIf);
  const today = useStore((s) => s.today);
  const [confirm, setConfirm] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const syncOn = useSync((s) => s.phase !== 'off');
  useEffect(() => { void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null)); }, []);
  const erase = async () => {
    let saved: Awaited<ReturnType<typeof saveTextFile>>;
    try { saved = await saveTextFile(makeBackupText(useStore.getState().data), backupFileName(today)); } catch { saved = 'cancelled'; }
    if (saved === 'cancelled') { toast('Nothing was erased. Save the backup to continue.'); return; }
    // Erasing this device must not reach the cloud copy, and the app must not restore it right back.
    if (syncOn) await turnOff(false);
    replaceAll(makeDefaultData(today), 'Everything was erased.');
    setConfirm('');
    navigate('/');
  };
  return (
    <div className="page page-narrow">
      <PlanHeader title="Settings" />
      <section className="card">
        <span className="lbl">Theme</span>
        <Segmented<ThemePref> label="Theme" value={data.prefs.theme} onChange={(v) => update((d) => { d.prefs.theme = v; }, { real: true })}
          options={[{ value: 'system', label: 'Match phone' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
      </section>
      <section className="card">
        <span className="lbl">Today's date comes from</span>
        <Segmented label="Time zone" value={data.prefs.timeZone === 'device' ? 'device' : 'et'} onChange={(v) => setTimeZone(v === 'device' ? 'device' : 'America/New_York')}
          options={[{ value: 'et', label: 'Eastern time' }, { value: 'device', label: "This device's time zone" }]} />
        <p className="sub">The day changes at midnight in this time zone. Bills Account Planner always used Eastern time.</p>
      </section>
      <section className="card">
        <span className="lbl">What-if mode</span>
        <p className="sub body">Try a change, like a new bill or a bigger loan payment, and see how it plays out. Keep it or throw it away when you're done.</p>
        {whatIf ? (
          <div className="btn-row"><button type="button" className="btn ghost" onClick={discardWhatIf}>Discard changes</button><button type="button" className="btn" onClick={keepWhatIf}>Keep changes</button></div>
        ) : <button type="button" className="btn ghost" onClick={() => { startWhatIf(); toast('What-if mode is on.'); }}><IconFlask />Start what-if</button>}
      </section>
      <section className="card">
        <span className="lbl">Storage</span>
        <p className="sub body">{persisted ? 'Your browser has agreed to keep this app’s data until you remove it.' : 'Saved on this device. Install the app to your home screen and keep backups so nothing is lost if the browser clears its storage.'}</p>
        {syncAvailable() && <p className="sub body">{syncOn ? 'Cloud sync is on, so your data comes back even if the browser clears it.' : <>Turn on <button type="button" className="link-btn" onClick={() => navigate('/plan/sync')}>cloud sync</button> so your data comes back even if the browser clears it.</>}</p>}
      </section>
      <section className="card danger-zone">
        <span className="lbl">Erase everything</span>
        <p className="sub body">Removes all your data from this device. A backup file is saved first, and you can undo for a few seconds after.{syncOn ? ' Cloud sync is turned off on this device; your cloud copy is kept.' : ''}</p>
        <Field label='Type "erase" to confirm'>{(id) => <TextInput id={id} value={confirm} onChange={setConfirm} placeholder="erase" />}</Field>
        <button type="button" className="btn danger" disabled={confirm.trim().toLowerCase() !== 'erase'} onClick={() => void erase()}>Erase everything</button>
      </section>
      {whatIf && <Note tone="info">What-if mode is on. Settings on this page always apply to your real data.</Note>}
    </div>
  );
}
