// End-to-end checks against a running Worker.
// Usage: npm run dev (in another terminal), then: node test/smoke.mjs [baseUrl] [--skip-lockout]
// (default http://127.0.0.1:8787). Use --skip-lockout against a deployed Worker: that check leaves a locked test vault behind.
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:8787').replace(/\/$/, '');
const skipLockout = args.includes('--skip-lockout');
const hex = (n) => randomBytes(n).toString('hex');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}
function vaultClient(vault = hex(32), token = hex(32)) {
  const url = (p = '') => `${base}/v1/vaults/${vault}${p}`;
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const put = (baseVersion, body, t = token, mac = hex(32)) =>
    fetch(url(), { method: 'PUT', headers: { ...auth(t), 'X-Base-Version': String(baseVersion), 'X-Content-Mac': mac }, body });
  return { url, auth, put };
}

let r = await fetch(`${base}/v1/health`);
check('health', r.status === 200, r.status);

const v = vaultClient();
const other = hex(32);
r = await fetch(v.url('/head'), { headers: v.auth() });
check('head of a vault that does not exist is 404', r.status === 404, r.status);
r = await v.put(1, new Uint8Array([1]));
check('put with base 1 to a missing vault is 404', r.status === 404, r.status);

const body1 = randomBytes(2_500_000); // spans three 1 MB chunks
const mac1 = hex(32);
r = await v.put(0, body1, undefined, mac1);
let j = await r.json();
check('first upload creates version 1', r.status === 200 && j.latest?.version === 1, j);
r = await fetch(v.url('/head'), { headers: v.auth() });
j = await r.json();
check('head shows version 1, its size and checksum', j.latest?.version === 1 && j.latest.mac === mac1 && j.latest.size === body1.length, j);
r = await fetch(v.url(), { headers: v.auth() });
let got = Buffer.from(await r.arrayBuffer());
check('download returns the same bytes', r.status === 200 && got.equals(body1) && r.headers.get('X-Version') === '1', r.status);

r = await fetch(v.url('/head'), { headers: v.auth(other) });
check('wrong token is 401', r.status === 401, r.status);
r = await v.put(0, new Uint8Array([2]), other);
check('a different token cannot overwrite (401)', r.status === 401, r.status);
r = await v.put(0, new Uint8Array([2]));
j = await r.json();
check('stale base version is 409 and reports the latest', r.status === 409 && j.latest?.version === 1, j);

const body2 = randomBytes(1000);
r = await v.put(1, body2);
j = await r.json();
check('upload on top of version 1 makes version 2', r.status === 200 && j.latest?.version === 2, j);
r = await fetch(v.url('/versions'), { headers: v.auth() });
j = await r.json();
check('version list has 2 entries, newest first', j.versions?.length === 2 && j.versions[0].version === 2, j);
r = await fetch(v.url('/versions/1'), { headers: v.auth() });
got = Buffer.from(await r.arrayBuffer());
check('older version is still readable', r.status === 200 && got.equals(body1), r.status);
r = await fetch(v.url('/versions/9'), { headers: v.auth() });
check('unknown version is 404', r.status === 404, r.status);

r = await fetch(v.url(), { method: 'OPTIONS', headers: { Origin: 'https://bill6006.github.io', 'Access-Control-Request-Method': 'PUT' } });
check('CORS allows the app', r.headers.get('Access-Control-Allow-Origin') === 'https://bill6006.github.io');
r = await fetch(v.url(), { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'PUT' } });
check('CORS refuses other sites', !r.headers.get('Access-Control-Allow-Origin'));
r = await v.put(2, randomBytes(8 * 1024 * 1024 + 1));
check('more than 8 MB is 413', r.status === 413, r.status);
r = await fetch(v.url(), { headers: { Authorization: 'Bearer nope' } });
check('malformed token is 401', r.status === 401, r.status);

r = await fetch(v.url(), { method: 'DELETE', headers: v.auth() });
check('delete', r.status === 200, r.status);
r = await fetch(v.url('/head'), { headers: v.auth() });
check('vault is gone after delete (404)', r.status === 404, r.status);

if (!skipLockout) {
  const lock = vaultClient();
  await lock.put(0, new Uint8Array([1]));
  const codes = [];
  for (let i = 0; i < 21; i++) codes.push((await fetch(lock.url('/head'), { headers: lock.auth(hex(32)) })).status);
  check('20 wrong tokens are 401, the next is 429', codes.slice(0, 20).every((c) => c === 401) && codes[20] === 429, codes);
  r = await fetch(lock.url('/head'), { headers: lock.auth() });
  check('locked vault refuses even the right token for a while (429)', r.status === 429, r.status);
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
