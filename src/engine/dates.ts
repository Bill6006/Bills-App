/**
 * Date helpers, ported from v117. All calendar math uses UTC-midnight milliseconds so
 * daylight-saving changes never shift a day. "Today" is computed in a chosen time zone.
 */
export type MonthKey = string; // "YYYY-MM"
export type IsoDate = string; // "YYYY-MM-DD"

export const DAY_MS = 86400000;
export const DEFAULT_TZ = 'America/New_York';

export function msUTC(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

export function toDateObj(ms: number) {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

export function isoDate(ms: number): IsoDate {
  const { y, m, d } = toDateObj(ms);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseISOToMs(iso: string): number {
  const [Y, M, D] = String(iso).split('-').map(Number);
  return msUTC(Y, M, D);
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY or YYYY/MM/DD; returns YYYY-MM-DD or "". */
export function normalizeISODateLoose(v: unknown): IsoDate {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${String(Number(m[3])).padStart(4, '0')}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${String(Number(m[1])).padStart(4, '0')}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  return '';
}

export function isValidIso(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const ms = parseISOToMs(iso);
  return Number.isFinite(ms) && isoDate(ms) === iso;
}

export function parseMonthKey(s: MonthKey) {
  const [Y, M] = String(s).split('-').map(Number);
  return { y: Y, m: M };
}

export function monthKeyFrom(y: number, m: number): MonthKey {
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function addMonthsKey(key: MonthKey, delta: number): MonthKey {
  const { y, m } = parseMonthKey(key);
  const mm = y * 12 + (m - 1) + delta;
  return monthKeyFrom(Math.floor(mm / 12), (mm % 12) + 1);
}

export function daysInMonth(y: number, m: number): number {
  const next = m === 12 ? msUTC(y + 1, 1, 1) : msUTC(y, m + 1, 1);
  return Math.round((next - msUTC(y, m, 1)) / DAY_MS);
}

export function monthStartMs(key: MonthKey): number {
  const { y, m } = parseMonthKey(key);
  return msUTC(y, m, 1);
}

export function monthEndMs(key: MonthKey): number {
  const { y, m } = parseMonthKey(key);
  return msUTC(y, m, daysInMonth(y, m));
}

export function addDaysMs(ms: number, days: number): number {
  return ms + days * DAY_MS;
}

export function monthIndex(key: MonthKey): number {
  const { y, m } = parseMonthKey(key);
  return y * 12 + (m - 1);
}

export function monthKeyFromIndex(i: number): MonthKey {
  return monthKeyFrom(Math.floor(i / 12), (i % 12) + 1);
}

export function monthOf(iso: IsoDate): MonthKey {
  return iso.slice(0, 7);
}

export function isMonthKey(s: unknown): s is MonthKey {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function tzParts(date: Date, tz: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return { year: get('year'), month: get('month'), day: get('day') };
  } catch {
    return {
      year: String(date.getFullYear()),
      month: String(date.getMonth() + 1).padStart(2, '0'),
      day: String(date.getDate()).padStart(2, '0'),
    };
  }
}

/** Today's date in the given IANA zone ("device" uses the phone's own zone). */
export function todayIso(tz: string = DEFAULT_TZ, now: Date = new Date()): IsoDate {
  if (tz === 'device') {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const p = tzParts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Milliseconds until a few seconds past the next local midnight in the zone. */
export function msUntilNextMidnight(tz: string = DEFAULT_TZ, now: Date = new Date()): number {
  const today = todayIso(tz, now);
  for (let step = 1; step <= 36; step++) {
    const probe = new Date(now.getTime() + step * 3600000);
    if (todayIso(tz, probe) !== today) {
      // Narrow down to the minute the date flipped.
      let lo = now.getTime() + (step - 1) * 3600000, hi = probe.getTime();
      while (hi - lo > 60000) {
        const mid = Math.floor((lo + hi) / 2);
        if (todayIso(tz, new Date(mid)) === today) lo = mid; else hi = mid;
      }
      return Math.max(1000, hi - now.getTime() + 5000);
    }
  }
  return 3600000;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const dowName = (dow: number) => DOW[dow];
export const dowLong = (dow: number) => DOW_LONG[dow];
export const monthAbbr = (m: number) => MON[m - 1];
export const monthLong = (m: number) => MON_LONG[m - 1];

/** "Nov 6" */
export function fmtShort(ms: number): string {
  const { m, d } = toDateObj(ms);
  return `${MON[m - 1]} ${d}`;
}
/** "Fri, Nov 6" */
export function fmtDow(ms: number): string {
  const { m, d, dow } = toDateObj(ms);
  return `${DOW[dow]}, ${MON[m - 1]} ${d}`;
}
/** "Friday, November 6" */
export function fmtLong(ms: number): string {
  const { m, d, dow } = toDateObj(ms);
  return `${DOW_LONG[dow]}, ${MON_LONG[m - 1]} ${d}`;
}
/** "Nov 6, 2026" */
export function fmtMedium(ms: number): string {
  const { y, m, d } = toDateObj(ms);
  return `${MON[m - 1]} ${d}, ${y}`;
}
/** "November 2026" */
export function fmtMonthLong(key: MonthKey): string {
  const { y, m } = parseMonthKey(key);
  return `${MON_LONG[m - 1]} ${y}`;
}
/** "Nov 2026" */
export function fmtMonthShort(key: MonthKey): string {
  const { y, m } = parseMonthKey(key);
  return `${MON[m - 1]} ${y}`;
}
/** "Oct 30 – Nov 12" (adds years only when they differ from each other) */
export function fmtRange(startMs: number, endMs: number): string {
  const a = toDateObj(startMs), b = toDateObj(endMs);
  if (a.y !== b.y) return `${MON[a.m - 1]} ${a.d}, ${a.y} – ${MON[b.m - 1]} ${b.d}, ${b.y}`;
  return `${MON[a.m - 1]} ${a.d} – ${MON[b.m - 1]} ${b.d}`;
}
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / DAY_MS);
}
