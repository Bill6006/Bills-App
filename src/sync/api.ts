/** HTTP client for the bills-sync Worker. */
import { SYNC_URL } from './config';

export interface RemoteInfo { version: number; savedAt: number; size: number; mac: string }

export type SyncErrorKind = 'offline' | 'missing' | 'gone' | 'denied' | 'locked' | 'conflict' | 'too_large' | 'server';

export class SyncError extends Error {
  constructor(public kind: SyncErrorKind, message: string, public latest: RemoteInfo | null = null) {
    super(message);
  }
}

export interface SyncApi {
  /** Latest version's details, or null when the vault exists but holds nothing. Throws `missing` when there's no vault. */
  head(vaultId: string, token: string): Promise<RemoteInfo | null>;
  download(vaultId: string, token: string, version?: number): Promise<{ info: RemoteInfo; bytes: Uint8Array<ArrayBuffer> }>;
  /** Throws `conflict` (with the latest version) when baseVersion isn't the latest. baseVersion 0 creates the vault. */
  upload(vaultId: string, token: string, baseVersion: number, mac: string, bytes: Uint8Array<ArrayBuffer>): Promise<RemoteInfo>;
  versions(vaultId: string, token: string): Promise<RemoteInfo[]>;
  destroy(vaultId: string, token: string): Promise<void>;
}

const MESSAGES: Record<SyncErrorKind, string> = {
  offline: "Can't reach the cloud right now.",
  missing: 'There is no cloud copy under that name.',
  gone: "That copy isn't in the cloud anymore.",
  denied: "The cloud didn't accept this password.",
  locked: 'Too many wrong passwords were tried. Wait 15 minutes and try again.',
  conflict: 'The cloud copy changed in the meantime.',
  too_large: 'Your data is too big to upload (over 8 MB).',
  server: 'The cloud had a problem. It will try again later.',
};

function kindFor(status: number, error: unknown): SyncErrorKind {
  if (status === 404) return error === 'gone' ? 'gone' : 'missing';
  if (status === 401) return 'denied';
  if (status === 429) return 'locked';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  return 'server';
}

async function call(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${SYNC_URL}${path}`, { ...init, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  } catch {
    throw new SyncError('offline', MESSAGES.offline);
  }
  if (res.ok) return res;
  let body: { error?: string; latest?: RemoteInfo | null } = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  const kind = kindFor(res.status, body.error);
  throw new SyncError(kind, MESSAGES[kind], body.latest ?? null);
}

function infoFrom(res: Response): RemoteInfo {
  return {
    version: Number(res.headers.get('X-Version')),
    savedAt: Number(res.headers.get('X-Saved-At')),
    size: Number(res.headers.get('Content-Length') || 0),
    mac: res.headers.get('X-Content-Mac') || '',
  };
}

export const httpApi: SyncApi = {
  async head(vaultId, token) {
    const res = await call(`/v1/vaults/${vaultId}/head`, token);
    return ((await res.json()) as { latest: RemoteInfo | null }).latest;
  },
  async download(vaultId, token, version) {
    const res = await call(version == null ? `/v1/vaults/${vaultId}` : `/v1/vaults/${vaultId}/versions/${version}`, token);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { info: { ...infoFrom(res), size: bytes.byteLength }, bytes };
  },
  async upload(vaultId, token, baseVersion, mac, bytes) {
    const res = await call(`/v1/vaults/${vaultId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Base-Version': String(baseVersion), 'X-Content-Mac': mac },
      body: bytes,
    });
    return ((await res.json()) as { latest: RemoteInfo }).latest;
  },
  async versions(vaultId, token) {
    const res = await call(`/v1/vaults/${vaultId}/versions`, token);
    return ((await res.json()) as { versions: RemoteInfo[] }).versions;
  },
  async destroy(vaultId, token) {
    await call(`/v1/vaults/${vaultId}`, token, { method: 'DELETE' });
  },
};
