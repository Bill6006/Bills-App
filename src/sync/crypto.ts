/**
 * Encryption for the cloud copy. Everything here runs on the device; the server only ever receives the output.
 *
 * From the sync name and password, PBKDF2 derives three independent secrets:
 * - an AES-GCM key that encrypts each snapshot (gzip first, so snapshots stay small),
 * - an access token the server checks (it stores only a hash of it),
 * - an HMAC key for a checksum of the data, so two copies can be compared without downloading either.
 * The vault id is a hash of the name alone, so a wrong password reads as "wrong password", not "no cloud copy".
 */
type Bytes = Uint8Array<ArrayBuffer>;

export const PBKDF2_ITERATIONS = 600_000;
const MAGIC = 'BSY1';
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface SyncKeys {
  vaultId: string;
  token: string;
  encKey: string;
  macKey: string;
}

/** The decrypt step failed: wrong key, or the file was changed. */
export class SnapshotError extends Error {}

export const normalizeName = (name: string) => name.normalize('NFC').trim().toLowerCase();

const toHex = (b: Bytes) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function toB64(b: Bytes): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromB64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function deriveKeys(name: string, password: string, iterations = PBKDF2_ITERATIONS): Promise<SyncKeys> {
  const n = normalizeName(name);
  const vaultId = toHex(await sha256(`bills-sync/v1/vault|${n}`));
  const salt = await sha256(`bills-sync/v1/salt|${n}`);
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 768));
  return { vaultId, encKey: toB64(bits.slice(0, 32)), token: toHex(bits.slice(32, 64)), macKey: toB64(bits.slice(64, 96)) };
}

/** Keyed checksum of the data's JSON. Equal checksums mean equal data; the server can't learn anything from it. */
export async function contentMac(json: string, macKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromB64(macKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(json))));
}

async function transform(bytes: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** gzip, then AES-GCM with a fresh IV. Layout: "BSY1" | 12-byte IV | ciphertext. Bound to the vault id. */
export async function sealSnapshot(text: string, keys: Pick<SyncKeys, 'encKey' | 'vaultId'>): Promise<Bytes> {
  const zipped = await transform(enc.encode(text), new CompressionStream('gzip'));
  const key = await crypto.subtle.importKey('raw', fromB64(keys.encKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keys.vaultId) }, key, zipped));
  const out = new Uint8Array(4 + iv.length + ct.length);
  out.set(enc.encode(MAGIC), 0);
  out.set(iv, 4);
  out.set(ct, 4 + iv.length);
  return out;
}

export async function openSnapshot(bytes: Bytes, keys: Pick<SyncKeys, 'encKey' | 'vaultId'>): Promise<string> {
  if (bytes.byteLength < 4 + 12 + 16 || dec.decode(bytes.slice(0, 4)) !== MAGIC) throw new SnapshotError("This isn't a Bills Planner cloud copy.");
  const key = await crypto.subtle.importKey('raw', fromB64(keys.encKey), 'AES-GCM', false, ['decrypt']);
  let zipped: Bytes;
  try {
    zipped = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(4, 16), additionalData: enc.encode(keys.vaultId) }, key, bytes.slice(16)));
  } catch {
    throw new SnapshotError("The cloud copy couldn't be unlocked with this password.");
  }
  return dec.decode(await transform(zipped, new DecompressionStream('gzip')));
}
