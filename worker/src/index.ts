/**
 * Bills Planner cloud copy.
 *
 * Each vault is one SQLite-backed Durable Object holding encrypted snapshots ("versions") of one person's data.
 * The app encrypts on the device before uploading, so this Worker only ever sees ciphertext, a keyed checksum of
 * the plaintext (to tell whether two copies match), and a hash of the access token.
 *
 * API (all vault calls need `Authorization: Bearer <64 hex token>`):
 *   GET    /v1/vaults/:id/head           -> { latest: { version, savedAt, size, mac } }
 *   GET    /v1/vaults/:id                -> latest snapshot (octet-stream; X-Version, X-Saved-At, X-Content-Mac)
 *   PUT    /v1/vaults/:id                -> store a snapshot; X-Base-Version must equal the latest version (0 creates)
 *   GET    /v1/vaults/:id/versions       -> { versions: [...] }, newest first
 *   GET    /v1/vaults/:id/versions/:v    -> that snapshot
 *   DELETE /v1/vaults/:id                -> deletes the vault and every snapshot
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  VAULTS: DurableObjectNamespace<Vault>;
  ALLOWED_ORIGINS?: string;
}

const MAX_BYTES = 8 * 1024 * 1024;
/** SQLite rows in Durable Objects are limited to 2 MB, so snapshots are stored in 1 MB chunks. */
const CHUNK_BYTES = 1_000_000;
const DAY_MS = 86_400_000;
/** Always keep this many of the newest versions. */
const KEEP_RECENT = 20;
/** Plus everything from the last day (up to KEEP_MAX), and the newest version of each day for KEEP_DAYS. */
const KEEP_DAYS = 30;
const KEEP_MAX = 300;
/** Wrong-token attempts allowed per vault before it answers 429 for a while. */
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 15 * 60_000;

type Status = 'ok' | 'missing' | 'denied' | 'locked' | 'conflict' | 'gone';

export interface VersionInfo { version: number; savedAt: number; size: number; mac: string }

function toInfo(r: Record<string, SqlStorageValue>): VersionInfo {
  return { version: Number(r.version), savedAt: Number(r.saved_at), size: Number(r.size), mac: String(r.mac) };
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Vault extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /** Tables are created on the first upload only, so looking up a vault that doesn't exist stores nothing. */
  private exists(): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  private create(tokenHash: string) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, saved_at INTEGER NOT NULL, size INTEGER NOT NULL, mac TEXT NOT NULL, chunks INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (version INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (version, idx))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS fails (at INTEGER NOT NULL)');
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('auth', ?), ('created', ?)", tokenHash, String(Date.now()));
  }

  private check(tokenHash: string): Status {
    if (!this.exists()) return 'missing';
    const stored = this.sql.exec("SELECT v FROM meta WHERE k = 'auth'").toArray()[0];
    if (!stored) return 'missing';
    const now = Date.now();
    const recent = Number(this.sql.exec('SELECT COUNT(*) AS n FROM fails WHERE at > ?', now - FAIL_WINDOW_MS).one().n);
    if (recent >= FAIL_LIMIT) return 'locked';
    if (!sameHash(String(stored.v), tokenHash)) {
      this.sql.exec('DELETE FROM fails WHERE at <= ?', now - FAIL_WINDOW_MS);
      this.sql.exec('INSERT INTO fails (at) VALUES (?)', now);
      return 'denied';
    }
    return 'ok';
  }

  private latest(): VersionInfo | null {
    const r = this.sql.exec('SELECT version, saved_at, size, mac FROM versions ORDER BY version DESC LIMIT 1').toArray()[0];
    return r ? toInfo(r) : null;
  }

  private load(info: VersionInfo): ArrayBuffer | null {
    const out = new Uint8Array(info.size);
    let off = 0;
    for (const r of this.sql.exec('SELECT data FROM chunks WHERE version = ? ORDER BY idx', info.version)) {
      const part = new Uint8Array(r.data as ArrayBuffer);
      if (off + part.byteLength > out.byteLength) return null;
      out.set(part, off);
      off += part.byteLength;
    }
    return off === info.size ? out.buffer : null;
  }

  private prune(now: number) {
    const rows = this.sql.exec('SELECT version, saved_at FROM versions ORDER BY version DESC').toArray();
    const seenDays = new Set<number>();
    rows.forEach((r, i) => {
      const at = Number(r.saved_at);
      const day = Math.floor(at / DAY_MS);
      const newestOfDay = !seenDays.has(day);
      seenDays.add(day);
      const keep = i < KEEP_RECENT || (at > now - DAY_MS && i < KEEP_MAX) || (at > now - KEEP_DAYS * DAY_MS && newestOfDay);
      if (!keep) {
        this.sql.exec('DELETE FROM chunks WHERE version = ?', r.version);
        this.sql.exec('DELETE FROM versions WHERE version = ?', r.version);
      }
    });
  }

  async head(tokenHash: string): Promise<{ status: Status; latest?: VersionInfo | null }> {
    const status = this.check(tokenHash);
    return status === 'ok' ? { status, latest: this.latest() } : { status };
  }

  async read(tokenHash: string, version?: number): Promise<{ status: Status; info?: VersionInfo; data?: ArrayBuffer }> {
    const status = this.check(tokenHash);
    if (status !== 'ok') return { status };
    const r = version == null ? this.latest() : (() => {
      const row = this.sql.exec('SELECT version, saved_at, size, mac FROM versions WHERE version = ?', version).toArray()[0];
      return row ? toInfo(row) : null;
    })();
    const data = r && this.load(r);
    return r && data ? { status, info: r, data } : { status: 'gone' };
  }

  async write(tokenHash: string, baseVersion: number, mac: string, data: ArrayBuffer): Promise<{ status: Status; latest?: VersionInfo | null }> {
    return this.ctx.storage.transactionSync(() => {
      if (!this.exists()) {
        if (baseVersion !== 0) return { status: 'missing' as Status };
        this.create(tokenHash);
      } else {
        const status = this.check(tokenHash);
        if (status !== 'ok') return { status };
      }
      const current = this.latest();
      if (baseVersion !== (current?.version ?? 0)) return { status: 'conflict' as Status, latest: current };
      const version = (current?.version ?? 0) + 1;
      const now = Date.now();
      const bytes = new Uint8Array(data);
      let idx = 0;
      for (let off = 0; off < bytes.byteLength; off += CHUNK_BYTES, idx++) {
        this.sql.exec('INSERT INTO chunks (version, idx, data) VALUES (?, ?, ?)', version, idx, bytes.slice(off, off + CHUNK_BYTES).buffer);
      }
      this.sql.exec('INSERT INTO versions (version, saved_at, size, mac, chunks) VALUES (?, ?, ?, ?, ?)', version, now, bytes.byteLength, mac, idx);
      this.prune(now);
      return { status: 'ok' as Status, latest: { version, savedAt: now, size: bytes.byteLength, mac } };
    });
  }

  async list(tokenHash: string): Promise<{ status: Status; versions?: VersionInfo[] }> {
    const status = this.check(tokenHash);
    if (status !== 'ok') return { status };
    return { status, versions: this.sql.exec('SELECT version, saved_at, size, mac FROM versions ORDER BY version DESC').toArray().map(toInfo) };
  }

  async destroy(tokenHash: string): Promise<{ status: Status }> {
    const status = this.check(tokenHash);
    if (status !== 'ok') return { status };
    await this.ctx.storage.deleteAll();
    return { status };
  }
}

// ---------- HTTP ----------

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && (allowed.includes(origin) || LOCAL_ORIGIN.test(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, PUT, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Base-Version, X-Content-Mac';
    h['Access-Control-Expose-Headers'] = 'X-Version, X-Saved-At, X-Content-Mac';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function snapshot(info: VersionInfo, data: ArrayBuffer, cors: Record<string, string>): Response {
  return new Response(data, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Version': String(info.version),
      'X-Saved-At': String(info.savedAt),
      'X-Content-Mac': info.mac,
    },
  });
}

function failure(status: Status, cors: Record<string, string>): Response {
  switch (status) {
    case 'missing': return json({ error: 'missing' }, 404, cors);
    case 'gone': return json({ error: 'gone' }, 404, cors);
    case 'denied': return json({ error: 'denied' }, 401, cors);
    case 'locked': return json({ error: 'locked' }, 429, cors);
    default: return json({ error: 'server' }, 500, cors);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const HEX64 = /^[0-9a-f]{64}$/;

async function route(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (url.pathname === '/' || url.pathname === '/v1/health') return json({ ok: true, service: 'bills-sync' }, 200, cors);

  const m = /^\/v1\/vaults\/([0-9a-f]{64})(\/head|\/versions(?:\/(\d{1,9}))?)?$/.exec(url.pathname);
  if (!m) return json({ error: 'not_found' }, 404, cors);
  const [, vaultId, sub = '', versionText] = m;
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] ?? '';
  if (!HEX64.test(token)) return json({ error: 'unauthorized' }, 401, cors);
  const tokenHash = await sha256Hex(token);
  const vault = env.VAULTS.get(env.VAULTS.idFromName(vaultId));

  if (sub === '/head' && method === 'GET') {
    const r = await vault.head(tokenHash);
    return r.status === 'ok' ? json({ latest: r.latest ?? null }, 200, cors) : failure(r.status, cors);
  }
  if (sub === '' && method === 'GET') {
    const r = await vault.read(tokenHash);
    return r.status === 'ok' && r.info && r.data ? snapshot(r.info, r.data, cors) : failure(r.status, cors);
  }
  if (sub === '' && method === 'PUT') {
    const base = Number(request.headers.get('X-Base-Version'));
    const mac = request.headers.get('X-Content-Mac') || '';
    if (!Number.isInteger(base) || base < 0 || !HEX64.test(mac)) return json({ error: 'bad_request' }, 400, cors);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too_large' }, 413, cors);
    const body = await request.arrayBuffer();
    if (!body.byteLength) return json({ error: 'bad_request' }, 400, cors);
    if (body.byteLength > MAX_BYTES) return json({ error: 'too_large' }, 413, cors);
    const r = await vault.write(tokenHash, base, mac, body);
    if (r.status === 'conflict') return json({ error: 'conflict', latest: r.latest ?? null }, 409, cors);
    return r.status === 'ok' ? json({ latest: r.latest }, 200, cors) : failure(r.status, cors);
  }
  if (sub === '' && method === 'DELETE') {
    const r = await vault.destroy(tokenHash);
    return r.status === 'ok' ? json({ ok: true }, 200, cors) : failure(r.status, cors);
  }
  if (sub.startsWith('/versions') && method === 'GET') {
    if (versionText) {
      const r = await vault.read(tokenHash, Number(versionText));
      return r.status === 'ok' && r.info && r.data ? snapshot(r.info, r.data, cors) : failure(r.status, cors);
    }
    const r = await vault.list(tokenHash);
    return r.status === 'ok' ? json({ versions: r.versions ?? [] }, 200, cors) : failure(r.status, cors);
  }
  return json({ error: 'method_not_allowed' }, 405, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request.headers.get('Origin'), env);
    try {
      return await route(request, env, cors);
    } catch (e) {
      console.error('bills-sync error', e instanceof Error ? e.message : String(e));
      return json({ error: 'server' }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;
