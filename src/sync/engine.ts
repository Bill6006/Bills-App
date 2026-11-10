/**
 * Sync decisions. Pure apart from the injected API, so it can be tested without a browser.
 *
 * The device keeps the version number and checksum of the last copy it uploaded or downloaded. Comparing those with
 * the cloud's latest version tells which side changed:
 *   only this device changed  -> upload (on top of the version it knows, so a newer cloud copy is never overwritten blindly)
 *   only the cloud changed    -> download
 *   both changed              -> ask
 * A device with nothing in it (fresh install, wiped storage, sample data) never uploads over a real cloud copy.
 */
import type { IsoDate } from '../engine/dates';
import type { AppData } from '../engine/types';
import { isEmptyData } from '../data/defaults';
import { makeBackupText, parseImportText } from '../data/backup';
import { SyncError, type RemoteInfo, type SyncApi } from './api';
import { contentMac, deriveKeys, openSnapshot, sealSnapshot, type SyncKeys } from './crypto';

export interface SyncConfig extends SyncKeys {
  /** The sync name as typed (for display). */
  name: string;
  /** Version and checksum of the last copy this device uploaded or downloaded; 0 and '' before the first. */
  version: number;
  mac: string;
  syncedAt: string | null;
}

/** Nothing worth keeping: an untouched app or the built-in sample data. */
export const isPlaceholder = (d: AppData): boolean => !!d.meta.sample || (isEmptyData(d) && !d.meta.importedFrom);

export type Decision =
  | { kind: 'none' }
  /** The cloud already holds exactly this data; just remember its version. */
  | { kind: 'adopt' }
  | { kind: 'push'; base: number }
  | { kind: 'pull' }
  | { kind: 'conflict' }
  /** This device is empty but the cloud copy isn't: keep the cloud copy and ask. */
  | { kind: 'hold' };

export function decide(local: { mac: string; placeholder: boolean }, synced: { version: number; mac: string }, remote: RemoteInfo | null): Decision {
  if (!remote) return local.placeholder ? { kind: 'none' } : { kind: 'push', base: 0 };
  if (remote.mac === local.mac) return remote.version === synced.version ? { kind: 'none' } : { kind: 'adopt' };
  if (remote.version === synced.version) return local.placeholder ? { kind: 'hold' } : { kind: 'push', base: remote.version };
  // The cloud moved on (or was reset) since this device last synced.
  if (local.placeholder || local.mac === synced.mac) return { kind: 'pull' };
  return { kind: 'conflict' };
}

export interface SyncDeps {
  api: SyncApi;
  today: IsoDate;
  getData(): AppData;
  /** Replace the app's data with a copy from the cloud. */
  applyRemote(data: AppData, info: RemoteInfo): void;
  saveConfig(cfg: SyncConfig): Promise<void>;
  now?: () => Date;
}

export type SyncOutcome =
  | { kind: 'synced'; action: 'none' | 'adopt' | 'push' | 'pull'; cfg: SyncConfig; remote: RemoteInfo | null }
  | { kind: 'conflict'; cfg: SyncConfig; remote: RemoteInfo }
  | { kind: 'hold'; cfg: SyncConfig; remote: RemoteInfo }
  | { kind: 'missing'; cfg: SyncConfig };

/** Reads a downloaded snapshot back into app data (it's a normal backup file once decrypted). */
export async function readSnapshot(bytes: Uint8Array<ArrayBuffer>, cfg: SyncConfig, today: IsoDate): Promise<AppData> {
  return parseImportText(await openSnapshot(bytes, cfg), today).data;
}

/**
 * One sync round. `force` settles a conflict: 'pull' takes the cloud copy, 'push' makes this device's data the newest.
 * Throws SyncError / SnapshotError on failure.
 */
export async function runSync(cfg: SyncConfig, deps: SyncDeps, force?: 'pull' | 'push'): Promise<SyncOutcome> {
  const now = () => (deps.now ? deps.now() : new Date());
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = deps.getData();
    const json = JSON.stringify(data);
    const mac = await contentMac(json, cfg.macKey);
    const placeholder = isPlaceholder(data);
    let remote: RemoteInfo | null;
    try {
      remote = await deps.api.head(cfg.vaultId, cfg.token);
    } catch (e) {
      if (!(e instanceof SyncError) || e.kind !== 'missing') throw e;
      // No vault yet is normal before the first upload. Later it means someone deleted it: don't quietly re-create it.
      if (cfg.version > 0 && force !== 'push') return { kind: 'missing', cfg };
      remote = null;
    }

    let d = decide({ mac, placeholder }, cfg, remote);
    if (force === 'pull' && remote) d = remote.mac === mac ? { kind: 'adopt' } : { kind: 'pull' };
    if (force === 'push' && !placeholder) d = remote?.mac === mac ? { kind: 'adopt' } : { kind: 'push', base: remote?.version ?? 0 };

    switch (d.kind) {
      case 'none':
      case 'adopt': {
        const next: SyncConfig = { ...cfg, version: remote?.version ?? cfg.version, mac: remote ? mac : cfg.mac, syncedAt: now().toISOString() };
        await deps.saveConfig(next);
        return { kind: 'synced', action: d.kind, cfg: next, remote };
      }
      case 'push': {
        const bytes = await sealSnapshot(makeBackupText(data, now().toISOString()), cfg);
        let info: RemoteInfo;
        try {
          info = await deps.api.upload(cfg.vaultId, cfg.token, d.base, mac, bytes);
        } catch (e) {
          if (e instanceof SyncError && e.kind === 'conflict') continue; // another device uploaded first: look again
          throw e;
        }
        const next: SyncConfig = { ...cfg, version: info.version, mac, syncedAt: now().toISOString() };
        await deps.saveConfig(next);
        return { kind: 'synced', action: 'push', cfg: next, remote: info };
      }
      case 'pull': {
        const { info, bytes } = await deps.api.download(cfg.vaultId, cfg.token);
        const pulled = await readSnapshot(bytes, cfg, deps.today);
        const next: SyncConfig = { ...cfg, version: info.version, mac: info.mac, syncedAt: now().toISOString() };
        await deps.saveConfig(next);
        deps.applyRemote(pulled, info);
        return { kind: 'synced', action: 'pull', cfg: next, remote: info };
      }
      case 'conflict':
        return { kind: 'conflict', cfg, remote: remote! };
      case 'hold':
        return { kind: 'hold', cfg, remote: remote! };
    }
  }
  throw new SyncError('conflict', 'The cloud copy kept changing. Try again in a moment.');
}

/**
 * Links this device to a cloud copy. 'setup' creates the copy when the name is new; 'restore' requires it to exist,
 * so a mistyped name can't start an empty copy.
 */
export async function connect(name: string, password: string, mode: 'setup' | 'restore', deps: SyncDeps, iterations?: number): Promise<SyncOutcome> {
  const keys = await deriveKeys(name, password, iterations);
  const cfg: SyncConfig = { ...keys, name: name.trim(), version: 0, mac: '', syncedAt: null };
  if (mode === 'restore') await deps.api.head(cfg.vaultId, cfg.token);
  const outcome = await runSync(cfg, deps);
  await deps.saveConfig(outcome.cfg);
  return outcome;
}
