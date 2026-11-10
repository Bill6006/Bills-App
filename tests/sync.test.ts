import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importV117 } from '../src/data/importV117';
import { makeDefaultData } from '../src/data/defaults';
import type { AppData } from '../src/engine/types';
import { SyncError, type RemoteInfo, type SyncApi } from '../src/sync/api';
import { contentMac, deriveKeys, openSnapshot, sealSnapshot, SnapshotError } from '../src/sync/crypto';
import { connect, decide, runSync, type SyncConfig, type SyncDeps } from '../src/sync/engine';

const TODAY = '2026-11-06';
const FAST = 1000; // PBKDF2 iterations for tests; the app uses 600,000
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'sample-biweekly.v117.json'), 'utf8'));
const realData = (): AppData => importV117(structuredClone(SAMPLE), TODAY).data;

/** In-memory stand-in for the Worker with the same rules: token check, versions, 409 on a stale base. */
class FakeCloud implements SyncApi {
  vaults = new Map<string, { token: string; versions: Array<RemoteInfo & { bytes: Uint8Array<ArrayBuffer> }> }>();
  /** Lets a test sneak in another upload between head() and upload(). */
  beforeUpload: (() => Promise<void>) | null = null;
  private now = 1_700_000_000_000;

  private vault(id: string, token: string) {
    const v = this.vaults.get(id);
    if (!v) throw new SyncError('missing', 'missing');
    if (v.token !== token) throw new SyncError('denied', 'denied');
    return v;
  }
  latest(id: string) {
    const v = this.vaults.get(id);
    return v ? v.versions[v.versions.length - 1] ?? null : null;
  }
  async head(id: string, token: string) {
    const l = this.vault(id, token).versions.at(-1);
    return l ? { version: l.version, savedAt: l.savedAt, size: l.size, mac: l.mac } : null;
  }
  async download(id: string, token: string, version?: number) {
    const v = this.vault(id, token);
    const hit = version == null ? v.versions.at(-1) : v.versions.find((x) => x.version === version);
    if (!hit) throw new SyncError('gone', 'gone');
    return { info: { version: hit.version, savedAt: hit.savedAt, size: hit.size, mac: hit.mac }, bytes: hit.bytes };
  }
  async upload(id: string, token: string, base: number, mac: string, bytes: Uint8Array<ArrayBuffer>) {
    if (this.beforeUpload) { const f = this.beforeUpload; this.beforeUpload = null; await f(); }
    let v = this.vaults.get(id);
    if (!v) {
      if (base !== 0) throw new SyncError('missing', 'missing');
      v = { token, versions: [] };
      this.vaults.set(id, v);
    } else if (v.token !== token) throw new SyncError('denied', 'denied');
    const cur = v.versions.at(-1)?.version ?? 0;
    if (base !== cur) throw new SyncError('conflict', 'conflict', this.latest(id));
    const info = { version: cur + 1, savedAt: (this.now += 60_000), size: bytes.byteLength, mac };
    v.versions.push({ ...info, bytes });
    return info;
  }
  async versions(id: string, token: string) {
    return this.vault(id, token).versions.map((x) => ({ version: x.version, savedAt: x.savedAt, size: x.size, mac: x.mac })).reverse();
  }
  async destroy(id: string, token: string) {
    this.vault(id, token);
    this.vaults.delete(id);
  }
}

/** One phone or computer: its own data and its own saved sync settings. */
class Device {
  cfg: SyncConfig | null = null;
  pulls = 0;
  constructor(public data: AppData, private cloud: FakeCloud) {}
  deps(): SyncDeps {
    return {
      api: this.cloud,
      today: TODAY,
      getData: () => this.data,
      applyRemote: (d) => { this.data = d; this.pulls++; },
      saveConfig: async (c) => { this.cfg = c; },
    };
  }
  setup(name = 'Me@Example.com', pw = 'correct horse battery') { return connect(name, pw, 'setup', this.deps(), FAST); }
  restore(name = 'me@example.com', pw = 'correct horse battery') { return connect(name, pw, 'restore', this.deps(), FAST); }
  sync(force?: 'pull' | 'push') { return runSync(this.cfg!, this.deps(), force); }
  edit(cushion: number) { this.data = { ...structuredClone(this.data), settings: { ...this.data.settings, cushion } }; }
}

describe('sync encryption', () => {
  it('derives the same keys from the same name and password, ignoring case and spaces in the name', async () => {
    const a = await deriveKeys('Me@Example.com', 'pw-123456789', FAST);
    const b = await deriveKeys('  me@example.com ', 'pw-123456789', FAST);
    expect(b).toEqual(a);
    expect(a.vaultId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different password keeps the vault but changes every secret', async () => {
    const a = await deriveKeys('me', 'pw-one-111111', FAST);
    const b = await deriveKeys('me', 'pw-two-222222', FAST);
    expect(b.vaultId).toBe(a.vaultId);
    expect(b.token).not.toBe(a.token);
    expect(b.encKey).not.toBe(a.encKey);
    expect(b.macKey).not.toBe(a.macKey);
  });

  it('round-trips a snapshot and never puts readable data on the wire', async () => {
    const keys = await deriveKeys('me', 'pw-123456789', FAST);
    const text = JSON.stringify({ secret: 'Mortgage 1,234.56', n: [1, 2, 3] });
    const sealed = await sealSnapshot(text, keys);
    expect(Buffer.from(sealed).toString('latin1')).not.toContain('Mortgage');
    expect(await openSnapshot(sealed, keys)).toBe(text);
    // Fresh IV each time.
    expect(Buffer.from(await sealSnapshot(text, keys)).equals(Buffer.from(sealed))).toBe(false);
  });

  it('refuses a wrong password, a tampered file or a file from another vault', async () => {
    const keys = await deriveKeys('me', 'pw-123456789', FAST);
    const sealed = await sealSnapshot('{"a":1}', keys);
    const wrong = await deriveKeys('me', 'pw-987654321', FAST);
    await expect(openSnapshot(sealed, wrong)).rejects.toBeInstanceOf(SnapshotError);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(openSnapshot(tampered, keys)).rejects.toBeInstanceOf(SnapshotError);
    await expect(openSnapshot(sealed, { ...keys, vaultId: '0'.repeat(64) })).rejects.toBeInstanceOf(SnapshotError);
  });

  it('checksums depend on the data and the key', async () => {
    const a = await deriveKeys('me', 'pw-123456789', FAST);
    const b = await deriveKeys('you', 'pw-123456789', FAST);
    expect(await contentMac('{"x":1}', a.macKey)).toBe(await contentMac('{"x":1}', a.macKey));
    expect(await contentMac('{"x":2}', a.macKey)).not.toBe(await contentMac('{"x":1}', a.macKey));
    expect(await contentMac('{"x":1}', b.macKey)).not.toBe(await contentMac('{"x":1}', a.macKey));
  });
});

describe('sync decisions', () => {
  const r = (version: number, mac: string): RemoteInfo => ({ version, mac, savedAt: 0, size: 1 });
  const cases: Array<[string, Parameters<typeof decide>, ReturnType<typeof decide>['kind']]> = [
    ['no cloud copy, real data: create it', [{ mac: 'L', placeholder: false }, { version: 0, mac: '' }, null], 'push'],
    ['no cloud copy, empty device: nothing to upload', [{ mac: 'L', placeholder: true }, { version: 0, mac: '' }, null], 'none'],
    ['in sync', [{ mac: 'A', placeholder: false }, { version: 3, mac: 'A' }, r(3, 'A')], 'none'],
    ['only this device changed: upload', [{ mac: 'B', placeholder: false }, { version: 3, mac: 'A' }, r(3, 'A')], 'push'],
    ['only the cloud changed: download', [{ mac: 'A', placeholder: false }, { version: 3, mac: 'A' }, r(4, 'C')], 'pull'],
    ['both changed: ask', [{ mac: 'B', placeholder: false }, { version: 3, mac: 'A' }, r(4, 'C')], 'conflict'],
    ['both made the same change: just catch up', [{ mac: 'C', placeholder: false }, { version: 3, mac: 'A' }, r(4, 'C')], 'adopt'],
    ['wiped device, cloud has data: download', [{ mac: 'E', placeholder: true }, { version: 0, mac: '' }, r(4, 'C')], 'pull'],
    ['device emptied after syncing: never upload the empty copy', [{ mac: 'E', placeholder: true }, { version: 4, mac: 'C' }, r(4, 'C')], 'hold'],
    ['new device with its own data meets an existing copy: ask', [{ mac: 'B', placeholder: false }, { version: 0, mac: '' }, r(4, 'C')], 'conflict'],
  ];
  for (const [name, args, kind] of cases) it(name, () => expect(decide(...args).kind).toBe(kind));
});

describe('syncing two devices', () => {
  it('a wiped phone gets everything back, and later edits flow both ways', async () => {
    const cloud = new FakeCloud();
    const phone = new Device(realData(), cloud);
    expect((await phone.setup()).kind).toBe('synced');
    expect(phone.cfg!.version).toBe(1);

    // Chrome clears the phone's storage: the app starts empty, then signs in again.
    const wiped = new Device(makeDefaultData(TODAY), cloud);
    const out = await wiped.restore();
    expect(out.kind === 'synced' && out.action).toBe('pull');
    expect(wiped.data.bills.length).toBe(phone.data.bills.length);
    expect(wiped.data.bills.length).toBeGreaterThan(0);
    // A restored copy is already in sync: no extra upload.
    expect(await wiped.sync()).toMatchObject({ kind: 'synced', action: 'none' });
    expect(cloud.latest(phone.cfg!.vaultId)!.version).toBe(1);

    phone.edit(321);
    expect(await phone.sync()).toMatchObject({ kind: 'synced', action: 'push' });
    expect(await wiped.sync()).toMatchObject({ kind: 'synced', action: 'pull' });
    expect(wiped.data.settings.cushion).toBe(321);
  });

  it('asks when both sides changed, and either choice settles it', async () => {
    const cloud = new FakeCloud();
    const phone = new Device(realData(), cloud);
    await phone.setup();
    const laptop = new Device(makeDefaultData(TODAY), cloud);
    await laptop.restore();

    phone.edit(1111);
    expect(await phone.sync()).toMatchObject({ action: 'push' });
    laptop.edit(2222);
    expect((await laptop.sync()).kind).toBe('conflict');
    expect(laptop.data.settings.cushion).toBe(2222); // nothing was overwritten while asking

    expect(await laptop.sync('push')).toMatchObject({ kind: 'synced', action: 'push' });
    expect(await phone.sync()).toMatchObject({ action: 'pull' });
    expect(phone.data.settings.cushion).toBe(2222);

    phone.edit(3333);
    expect(await phone.sync()).toMatchObject({ action: 'push' });
    laptop.edit(4444);
    expect((await laptop.sync()).kind).toBe('conflict');
    expect(await laptop.sync('pull')).toMatchObject({ action: 'pull' });
    expect(laptop.data.settings.cushion).toBe(3333);
    // The laptop's 4444 never reached the cloud; the four uploads before it are all still there.
    expect((await cloud.versions(phone.cfg!.vaultId, phone.cfg!.token)).map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('never uploads an empty or sample copy over real data', async () => {
    const cloud = new FakeCloud();
    const phone = new Device(realData(), cloud);
    await phone.setup();
    const before = cloud.latest(phone.cfg!.vaultId)!;

    phone.data = makeDefaultData(TODAY);
    expect((await phone.sync()).kind).toBe('hold');
    expect(await phone.sync('push')).toMatchObject({ kind: 'hold' });
    const sample = realData();
    sample.meta.sample = true;
    phone.data = sample;
    expect((await phone.sync()).kind).toBe('hold');
    expect(cloud.latest(phone.cfg!.vaultId)).toBe(before);

    // Asking for the cloud copy brings the real data back.
    expect(await phone.sync('pull')).toMatchObject({ action: 'pull' });
    expect(phone.data.meta.sample).toBeFalsy();
    expect(phone.data.bills.length).toBeGreaterThan(0);
  });

  it('a fresh, empty app does not create a cloud copy until there is something in it', async () => {
    const cloud = new FakeCloud();
    const fresh = new Device(makeDefaultData(TODAY), cloud);
    expect(await fresh.setup('new-person', 'pw-123456789')).toMatchObject({ kind: 'synced', action: 'none' });
    expect(cloud.vaults.size).toBe(0);
    fresh.data = realData();
    expect(await fresh.sync()).toMatchObject({ action: 'push' });
    expect(cloud.vaults.size).toBe(1);
  });

  it('restore needs the right name and password, and setup cannot take over a used name', async () => {
    const cloud = new FakeCloud();
    const phone = new Device(realData(), cloud);
    await phone.setup();
    const other = new Device(makeDefaultData(TODAY), cloud);
    await expect(other.restore('me@example.con')).rejects.toMatchObject({ kind: 'missing' });
    await expect(other.restore('me@example.com', 'wrong password!')).rejects.toMatchObject({ kind: 'denied' });
    const stranger = new Device(realData(), cloud);
    await expect(stranger.setup('me@example.com', 'someone else 123')).rejects.toMatchObject({ kind: 'denied' });
    expect(cloud.latest(phone.cfg!.vaultId)!.version).toBe(1);
  });

  it('retries when another device uploads in between', async () => {
    const cloud = new FakeCloud();
    const phone = new Device(realData(), cloud);
    await phone.setup();
    const laptop = new Device(makeDefaultData(TODAY), cloud);
    await laptop.restore();
    // The laptop uploads the very same change while the phone is mid-upload: the phone retries, sees a match, catches up.
    phone.edit(555);
    laptop.edit(555);
    cloud.beforeUpload = async () => { await laptop.sync(); };
    expect(await phone.sync()).toMatchObject({ kind: 'synced', action: 'adopt' });
    expect(phone.cfg!.version).toBe(2);
  });

  it('notices a deleted cloud copy instead of silently re-creating it', async () => {
    const cloud = new FakeCloud();
    const phone = new Device(realData(), cloud);
    await phone.setup();
    await cloud.destroy(phone.cfg!.vaultId, phone.cfg!.token);
    expect((await phone.sync()).kind).toBe('missing');
    expect(cloud.vaults.size).toBe(0);
    expect(await phone.sync('push')).toMatchObject({ action: 'push' });
    expect(cloud.latest(phone.cfg!.vaultId)!.version).toBe(1);
  });
});
