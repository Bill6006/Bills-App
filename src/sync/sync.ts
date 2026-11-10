/**
 * Cloud sync in the running app: when to sync, what the screens show, and the actions they call.
 *
 * Uploads a few seconds after a change (and right away when the app goes to the background), checks for a newer
 * cloud copy on launch, on returning to the app and every few minutes, and catches up when the connection returns.
 */
import { create } from 'zustand';
import { replaceAll, useStore } from '../state/store';
import { clearSyncConfig, loadSyncConfig, saveSyncConfig } from '../data/storage';
import { httpApi, SyncError, type RemoteInfo } from './api';
import { syncAvailable } from './config';
import { rememberCredential, savedCredential, stopAutoRestore } from './credentials';
import { SnapshotError } from './crypto';
import { connect, isPlaceholder, readSnapshot, runSync, type SyncConfig, type SyncDeps, type SyncOutcome } from './engine';

export type SyncPhase = 'off' | 'idle' | 'working' | 'offline' | 'error' | 'conflict' | 'hold' | 'missing';

export interface SyncView {
  phase: SyncPhase;
  name: string | null;
  syncedAt: string | null;
  message: string;
  /** The cloud's latest copy as of the last check (null when there's nothing in the cloud yet). */
  remote: RemoteInfo | null;
}

export const useSync = create<SyncView>(() => ({ phase: 'off', name: null, syncedAt: null, message: '', remote: null }));

export type ActionResult = { ok: true } | { ok: false; message: string };

let cfg: SyncConfig | null = null;
let queue: Promise<unknown> = Promise.resolve();
let timer: number | undefined;
let lastCheck = 0;
let started = false;
let pullLabel = 'Updated from your cloud copy.';

const view = (patch: Partial<SyncView>) => useSync.setState(patch);

function isConfig(x: unknown): x is SyncConfig {
  const c = x as Partial<SyncConfig> | null;
  return !!c && typeof c.name === 'string' && typeof c.vaultId === 'string' && typeof c.token === 'string'
    && typeof c.encKey === 'string' && typeof c.macKey === 'string' && typeof c.version === 'number' && typeof c.mac === 'string';
}

function deps(): SyncDeps {
  return {
    api: httpApi,
    today: useStore.getState().today,
    getData: () => useStore.getState().data,
    applyRemote: (data) => replaceAll(data, pullLabel),
    saveConfig: async (next) => { cfg = next; await saveSyncConfig(next); },
  };
}

function show(out: SyncOutcome) {
  const base = { name: out.cfg.name, syncedAt: out.cfg.syncedAt, message: '' };
  if (out.kind === 'synced') view({ ...base, phase: 'idle', remote: out.remote });
  else if (out.kind === 'missing') view({ ...base, phase: 'missing', remote: null });
  else view({ ...base, phase: out.kind, remote: out.remote });
}

function failure(e: unknown): { phase: SyncPhase; message: string } {
  if (e instanceof SyncError) {
    if (e.kind === 'offline') return { phase: 'offline', message: "You're offline. Changes upload when you're back online." };
    if (e.kind === 'denied') return { phase: 'error', message: "The cloud no longer accepts this device's sync password. Turn sync off, then on again with your current password." };
    return { phase: 'error', message: e.message };
  }
  if (e instanceof SnapshotError) return { phase: 'error', message: e.message };
  return { phase: 'error', message: 'Sync stopped because of an unexpected problem. It will try again.' };
}

/** One job at a time, so uploads and downloads never overlap. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job);
  queue = p.catch(() => undefined);
  return p;
}

function run(force?: 'pull' | 'push', label = 'Updated from your cloud copy.'): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  return enqueue(async () => {
    if (!cfg) return;
    // What-if edits aren't real yet; sync again once What-if mode ends.
    if (!force && useStore.getState().whatIf) return;
    if (navigator.onLine === false) { view(failure(new SyncError('offline', ''))); return; }
    lastCheck = Date.now();
    pullLabel = label;
    view({ phase: 'working' });
    try {
      show(await runSync(cfg, deps(), force));
    } catch (e) {
      view(failure(e));
    }
  });
}

function schedule(delay = 3000) {
  if (!cfg) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void run(), delay);
}

function listen() {
  useStore.subscribe((s, prev) => { if (s.data !== prev.data || (prev.whatIf && !s.whatIf)) schedule(); });
  document.addEventListener('visibilitychange', () => {
    if (!cfg) return;
    if (document.visibilityState === 'hidden') { if (timer !== undefined) void run(); }
    else if (Date.now() - lastCheck > 60_000) void run();
  });
  window.addEventListener('online', () => { if (cfg) void run(); });
  window.setInterval(() => { if (cfg && document.visibilityState === 'visible') void run(); }, 5 * 60_000);
}

/** Call once the app has loaded its data. */
export async function startSync(): Promise<void> {
  if (started || !syncAvailable()) return;
  started = true;
  listen();
  const saved = await loadSyncConfig();
  if (isConfig(saved)) {
    cfg = saved;
    view({ phase: 'idle', name: saved.name, syncedAt: saved.syncedAt });
    await run();
  } else if (isPlaceholder(useStore.getState().data)) {
    // Chrome cleared the app's storage (or this is a new phone): if Chrome kept the sync password, restore on its own.
    const cred = await savedCredential('silent');
    if (cred) await turnOn(cred.name, cred.password, 'restore');
  }
}

function connectMessage(e: unknown, mode: 'setup' | 'restore'): string {
  if (e instanceof SyncError) {
    if (e.kind === 'missing') return "There's no cloud copy under that name. Check the spelling (capital letters don't matter).";
    if (e.kind === 'denied') {
      return mode === 'setup'
        ? 'That name is already used with a different password. If it\'s yours, choose "I already have a cloud copy". Otherwise pick another name.'
        : "That password doesn't match this name.";
    }
    if (e.kind === 'offline') return "Can't reach the cloud. Check your connection and try again.";
    return e.message;
  }
  if (e instanceof SnapshotError) return e.message;
  return 'Something went wrong. Try again.';
}

/** Turns sync on: 'setup' makes a new cloud copy (or joins one), 'restore' only connects to an existing copy. */
export function turnOn(name: string, password: string, mode: 'setup' | 'restore'): Promise<ActionResult> {
  return enqueue(async () => {
    const before = useSync.getState();
    pullLabel = 'Restored from your cloud copy.';
    view({ phase: 'working', message: '' });
    try {
      const out = await connect(name, password, mode, deps());
      cfg = out.cfg;
      show(out);
      void rememberCredential(name.trim(), password);
      return { ok: true } as const;
    } catch (e) {
      view(cfg ? before : { phase: 'off', message: '' });
      return { ok: false, message: connectMessage(e, mode) } as const;
    }
  });
}

/** Restores with the password Chrome saved, when the person picks it. Null when there's none saved. */
export async function restoreWithSavedPassword(): Promise<ActionResult | null> {
  const cred = await savedCredential('optional');
  return cred ? turnOn(cred.name, cred.password, 'restore') : null;
}

export const syncNow = () => run();
/** Settles a conflict in favour of the cloud, or brings the cloud copy back to an emptied device. */
export const takeCloudCopy = () => run('pull', 'Replaced with your cloud copy.');
/** Settles a conflict in favour of this device, or re-uploads after the cloud copy was deleted. */
export const keepThisDevice = () => run('push');

export async function listVersions(): Promise<RemoteInfo[]> {
  return cfg ? httpApi.versions(cfg.vaultId, cfg.token) : [];
}

/** Puts an earlier version back. It becomes the newest version; the one it replaces stays in the list. */
export function restoreVersion(info: RemoteInfo): Promise<ActionResult> {
  return enqueue(async () => {
    if (!cfg) return { ok: false, message: 'Cloud sync is off.' } as const;
    view({ phase: 'working' });
    try {
      const { bytes } = await httpApi.download(cfg.vaultId, cfg.token, info.version);
      replaceAll(await readSnapshot(bytes, cfg, useStore.getState().today), `Restored your data from ${fmtWhen(info.savedAt)}.`);
      show(await runSync(cfg, deps(), 'push'));
      return { ok: true } as const;
    } catch (e) {
      const f = failure(e);
      view(f);
      return { ok: false, message: f.message } as const;
    }
  });
}

/** Stops syncing on this device; optionally deletes the cloud copy (every version) first. */
export function turnOff(deleteCloudCopy: boolean): Promise<ActionResult> {
  return enqueue(async () => {
    if (cfg && deleteCloudCopy) {
      try {
        await httpApi.destroy(cfg.vaultId, cfg.token);
      } catch (e) {
        if (!(e instanceof SyncError && e.kind === 'missing')) return { ok: false, message: failure(e).message } as const;
      }
    }
    cfg = null;
    window.clearTimeout(timer);
    timer = undefined;
    await clearSyncConfig();
    stopAutoRestore();
    view({ phase: 'off', name: null, syncedAt: null, message: '', remote: null });
    return { ok: true } as const;
  });
}

// ---------- for the screens ----------

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function syncedAgo(iso: string | null): string {
  if (!iso) return 'not yet';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** What needs the person's attention, for Home. */
export function syncAttention(v: SyncView): string | null {
  switch (v.phase) {
    case 'conflict': return 'This device and your cloud copy both changed. Choose which one to keep.';
    case 'hold': return 'This device is empty, but your cloud copy has your data. Restore it?';
    case 'missing': return 'Your cloud copy was deleted. Upload this device\'s data again?';
    case 'error': return v.message || 'Cloud sync has a problem.';
    default: return null;
  }
}

/** True when the cloud copy is current enough that backup-file reminders aren't needed. */
export function syncProtects(v: SyncView): boolean {
  return (v.phase === 'idle' || v.phase === 'working' || v.phase === 'offline')
    && !!v.remote && !!v.syncedAt && Date.now() - Date.parse(v.syncedAt) < 14 * 86_400_000;
}
