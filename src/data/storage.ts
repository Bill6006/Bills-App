/**
 * On-device storage. IndexedDB (via idb-keyval) with a localStorage fallback for browsers that block it.
 * Nothing leaves the device from here; cloud sync (src/sync) uploads an encrypted copy only when it's turned on.
 */
import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { AppData } from '../engine/types';
import { upgradeData } from './upgrade';

const KEY_DATA = 'data.v1';
const KEY_WHATIF = 'whatif.v1';
const KEY_SYNC = 'sync.v1';
const LS_PREFIX = 'bills-planner:';

let idb: UseStore | null = null;
function store(): UseStore | null {
  if (idb) return idb;
  try {
    if (typeof indexedDB === 'undefined') return null;
    idb = createStore('bills-planner', 'kv');
    return idb;
  } catch {
    return null;
  }
}

async function read<T>(key: string): Promise<T | undefined> {
  const s = store();
  if (s) {
    try { return await get<T>(key, s); } catch { /* fall through */ }
  }
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  const s = store();
  if (s) {
    try { await set(key, value, s); return; } catch { /* fall through */ }
  }
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

async function remove(key: string): Promise<void> {
  const s = store();
  if (s) { try { await del(key, s); } catch { /* ignore */ } }
  try { localStorage.removeItem(LS_PREFIX + key); } catch { /* ignore */ }
}

export async function loadAll(today: string): Promise<{ data: AppData | null; whatIf: AppData | null }> {
  const [d, w] = await Promise.all([read<unknown>(KEY_DATA), read<unknown>(KEY_WHATIF)]);
  return { data: d ? upgradeData(d, today) : null, whatIf: w ? upgradeData(w, today) : null };
}

export const saveData = (d: AppData) => write(KEY_DATA, d);
export const saveWhatIf = (d: AppData | null) => (d ? write(KEY_WHATIF, d) : remove(KEY_WHATIF));
export const clearAll = async () => { await remove(KEY_DATA); await remove(KEY_WHATIF); };

/** Cloud sync settings for this device (keys derived from the sync password, never the password itself). */
export const loadSyncConfig = () => read<unknown>(KEY_SYNC);
export const saveSyncConfig = (cfg: unknown) => write(KEY_SYNC, cfg);
export const clearSyncConfig = () => remove(KEY_SYNC);
