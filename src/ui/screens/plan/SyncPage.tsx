import { useEffect, useState, type FormEvent } from 'react';
import { openSheet } from '../../../state/sheets';
import { toast } from '../../../state/toast';
import type { RemoteInfo } from '../../../sync/api';
import { syncAvailable } from '../../../sync/config';
import {
  fmtWhen, keepThisDevice, listVersions, restoreVersion, syncedAgo, syncNow, takeCloudCopy, turnOff, turnOn, useSync, type SyncView,
} from '../../../sync/sync';
import { Chip, Note } from '../../components/bits';
import { Field, TextInput } from '../../components/controls';
import { Sheet } from '../../components/Sheet';
import { IconLock, IconRefresh, IconUndo } from '../../icons';
import { PlanHeader } from './common';

export function SyncPage() {
  const v = useSync();
  const [mode, setMode] = useState<'setup' | 'restore'>('setup');
  if (!syncAvailable()) {
    return (
      <div className="page page-narrow">
        <PlanHeader title="Cloud sync" />
        <Note tone="info">Cloud sync isn't set up for this copy of the app.</Note>
      </div>
    );
  }
  return (
    <div className="page page-narrow">
      <PlanHeader title="Cloud sync" />
      {v.phase === 'off' ? (
        <>
          <section className="card">
            <span className="lbl">Keep a copy in the cloud</span>
            <p className="sub body">
              Cloud sync saves an encrypted copy of your data a few seconds after every change. If Chrome clears this
              app's storage, or you get a new phone, open the app and your data comes back.
            </p>
            <p className="sub body">
              <IconLock className="inline-icon" /> Your data is locked with your sync password on this device before it's
              sent, so nobody else can read it. If you forget the password, the cloud copy can't be opened, so let Chrome
              save it when it asks.
            </p>
          </section>
          <section className="card">
            <span className="lbl">{mode === 'setup' ? 'Turn on cloud sync' : 'Connect to your cloud copy'}</span>
            <SyncForm mode={mode} onModeChange={setMode} />
          </section>
        </>
      ) : <SyncStatus v={v} />}
    </div>
  );
}

/** A real form, so Chrome offers to save the sync password and fills it in later. */
export function SyncForm({ mode, onModeChange, onDone }: { mode: 'setup' | 'restore'; onModeChange?: (m: 'setup' | 'restore') => void; onDone?: () => void }) {
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Enter a sync name.'); return; }
    if (mode === 'setup' && pw.length < 10) { setError('Use at least 10 characters for the sync password.'); return; }
    if (mode === 'setup' && pw !== pw2) { setError("The two passwords don't match."); return; }
    if (!pw) { setError('Enter your sync password.'); return; }
    setBusy(true);
    const r = await turnOn(name, pw, mode);
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    if (mode === 'setup') toast('Cloud sync is on.');
    onDone?.();
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <Field label="Sync name" hint={mode === 'setup' ? 'Any name you\'ll remember, like your email address. Capital letters don\'t matter.' : undefined}>
        {(id) => <input id={id} className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Sync password" hint={mode === 'setup' ? 'At least 10 characters, and not one you use anywhere else.' : undefined}>
        {(id) => <input id={id} className="input" type="password" name="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} />}
      </Field>
      {mode === 'setup' && (
        <Field label="Sync password again">
          {(id) => <input id={id} className="input" type="password" name="password-confirm" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}
        </Field>
      )}
      {error && <Note tone="bad">{error}</Note>}
      <button type="submit" className="btn block" disabled={busy}>
        {busy ? 'Unlocking…' : mode === 'setup' ? 'Turn on cloud sync' : 'Restore my data'}
      </button>
      {onModeChange && (
        <button type="button" className="btn ghost block" disabled={busy} onClick={() => { setError(''); onModeChange(mode === 'setup' ? 'restore' : 'setup'); }}>
          {mode === 'setup' ? 'I already have a cloud copy' : 'Make a new cloud copy instead'}
        </button>
      )}
    </form>
  );
}

export function openRestoreSheet() {
  openSheet((close) => (
    <Sheet title="Restore from the cloud" onClose={close}>
      <p className="sub" style={{ fontSize: 14 }}>Enter the sync name and password you chose when you turned on cloud sync.</p>
      <SyncForm mode="restore" onDone={close} />
    </Sheet>
  ));
}

function statusLine(v: SyncView): string {
  switch (v.phase) {
    case 'working': return 'Syncing…';
    case 'offline':
    case 'error': return v.message;
    case 'conflict':
    case 'hold':
    case 'missing': return 'Waiting for you. See below.';
    default: return v.remote ? `Up to date. Last synced ${syncedAgo(v.syncedAt)}.` : 'On. Your data uploads as soon as there\'s something in the app.';
  }
}

function SyncStatus({ v }: { v: SyncView }) {
  const [confirm, setConfirm] = useState('');
  const busy = v.phase === 'working';
  const attention = v.phase === 'error' || v.phase === 'conflict' || v.phase === 'hold' || v.phase === 'missing';
  const off = async (deleteCloud: boolean) => {
    const r = await turnOff(deleteCloud);
    if (!r.ok) { toast(r.message); return; }
    toast(deleteCloud ? 'Your cloud copy was deleted and sync is off.' : 'Cloud sync is off on this device. Your cloud copy is kept.');
  };
  const saved = v.remote ? fmtWhen(v.remote.savedAt) : '';

  return (
    <>
      <section className="card">
        <div className="card-head"><span className="lbl">Cloud sync</span><Chip tone={attention ? 'warn' : 'good'}>{attention ? 'Needs attention' : 'On'}</Chip></div>
        <p className="sub body">{statusLine(v)}</p>
        <p className="sub">Sync name: <b>{v.name}</b></p>
        <div className="btn-row">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void syncNow()}><IconRefresh />Sync now</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={openVersions}><IconUndo />Earlier versions</button>
        </div>
      </section>

      {v.phase === 'conflict' && (
        <Note tone="warn" action={(
          <div className="btn-row wrap">
            <button type="button" className="btn sm ghost" onClick={() => void takeCloudCopy()}>Use the cloud copy</button>
            <button type="button" className="btn sm" onClick={() => void keepThisDevice()}>Keep this device's data</button>
          </div>
        )}>
          This device and your cloud copy (saved {saved}) both changed since they last matched. Using the cloud copy
          replaces this device's data (you can undo right after). Keeping this device's data makes it the newest cloud
          copy; the other one stays under Earlier versions.
        </Note>
      )}
      {v.phase === 'hold' && (
        <Note tone="warn" action={<button type="button" className="btn sm" onClick={() => void takeCloudCopy()}>Restore the cloud copy</button>}>
          This device has no data, but your cloud copy (saved {saved}) does. Nothing was uploaded over it.
        </Note>
      )}
      {v.phase === 'missing' && (
        <Note tone="warn" action={<button type="button" className="btn sm" onClick={() => void keepThisDevice()}>Upload this device's data</button>}>
          Your cloud copy was deleted, maybe from another device. Upload this device's data to start a new one, or turn sync off below.
        </Note>
      )}

      <section className="card">
        <span className="lbl">Turn off</span>
        <p className="sub body">Stops syncing on this device. Your cloud copy stays, and you can connect to it again any time.</p>
        <button type="button" className="btn ghost" onClick={() => void off(false)}>Turn off on this device</button>
      </section>
      <section className="card danger-zone">
        <span className="lbl">Delete the cloud copy</span>
        <p className="sub body">Deletes every version from the cloud and turns sync off. The data on this device stays.</p>
        <Field label='Type "delete" to confirm'>{(id) => <TextInput id={id} value={confirm} onChange={setConfirm} placeholder="delete" />}</Field>
        <button type="button" className="btn danger" disabled={confirm.trim().toLowerCase() !== 'delete'} onClick={() => void off(true)}>Delete the cloud copy</button>
      </section>
    </>
  );
}

function fmtSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function openVersions() {
  openSheet((close) => <VersionsSheet onClose={close} />);
}

function VersionsSheet({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<RemoteInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    listVersions().then(setList).catch((e: Error) => setError(e.message || "Couldn't load the versions."));
  }, []);
  const restore = async (info: RemoteInfo) => {
    setBusy(info.version);
    const r = await restoreVersion(info);
    setBusy(null);
    if (r.ok) onClose();
    else setError(r.message);
  };
  return (
    <Sheet title="Earlier versions" onClose={onClose}>
      <p className="sub" style={{ fontSize: 14 }}>
        The cloud keeps every version from the last day and one a day for 30 days. Restoring one makes it your current
        data, and you can undo right after.
      </p>
      {error && <Note tone="bad">{error}</Note>}
      {!list && !error && <p className="sub">Loading…</p>}
      {list && list.length === 0 && <p className="sub">Nothing has been uploaded yet.</p>}
      {list && list.length > 0 && (
        <div className="list">
          {list.map((info, i) => (
            <div key={info.version} className="row no-lead">
              <span className="main-col"><span className="title">{fmtWhen(info.savedAt)}</span><span className="sub">{i === 0 ? 'Current' : `Version ${info.version}`} · {fmtSize(info.size)}</span></span>
              <span className="trail">
                {i > 0 && (
                  <button type="button" className="btn sm ghost" disabled={busy != null} onClick={() => void restore(info)}>
                    {busy === info.version ? 'Restoring…' : 'Restore'}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
