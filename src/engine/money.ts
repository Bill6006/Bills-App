/** Money helpers, ported from v117 (same rounding rules). */

export function round2(n: unknown): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Round up to the cent, ignoring float noise just above a whole cent. */
export function ceil2(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.ceil((v - 1e-9) * 100) / 100;
}

export function clampInt(n: unknown, lo: number, hi: number): number {
  const v = Math.floor(Number(n) || 0);
  return Math.max(lo, Math.min(hi, v));
}

export function clampPct(v: unknown): number {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0;
  n = Math.round(n);
  return Math.max(0, Math.min(100, n));
}

export function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });

/** "$1,234.56"; negatives use a true minus sign: "−$12.00". */
export function fmtMoney(n: unknown): string {
  const v = round2(n);
  const s = usd.format(Math.abs(v));
  return v < 0 ? `−${s}` : s;
}

/** Signed: "+$12.00" / "−$12.00" / "$0.00". */
export function fmtSigned(n: unknown): string {
  const v = round2(n);
  if (v > 0) return `+${usd.format(v)}`;
  if (v < 0) return `−${usd.format(-v)}`;
  return usd.format(0);
}

/** Whole dollars: "$3,200". */
export function fmtWhole(n: unknown): string {
  const v = Math.round(Number(n) || 0);
  const s = usd0.format(Math.abs(v));
  return v < 0 ? `−${s}` : s;
}

/** Compact: "$1.2k", "$950", "$45.5" (v117 graph labels). */
export function fmtMoneyCompact(n: unknown): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const trim = (s: string) => s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  if (abs >= 1_000_000) return `${sign}$${trim(abs >= 10_000_000 ? (abs / 1e6).toFixed(0) : (abs / 1e6).toFixed(1))}m`;
  if (abs >= 1000) return `${sign}$${trim(abs >= 10_000 ? (abs / 1000).toFixed(0) : (abs / 1000).toFixed(1))}k`;
  if (abs >= 100) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
  if (Number.isInteger(abs)) return `${sign}$${abs.toLocaleString('en-US')}`;
  return `${sign}$${trim(abs.toFixed(abs >= 10 ? 1 : 2))}`;
}

/** Split dollars and cents for display: 1158.74 → { whole: "1,158", cents: "74", negative: false }. */
export function moneyParts(n: unknown) {
  const v = round2(n);
  const neg = v < 0;
  const abs = Math.abs(v);
  const whole = Math.floor(abs + 1e-9);
  const cents = Math.round((abs - whole) * 100);
  return { whole: whole.toLocaleString('en-US'), cents: String(cents).padStart(2, '0'), negative: neg };
}

/** Cent-exact split of a transfer between income sources (v117 splitTransferAmount). */
export function splitTransferAmount(total: number, pctPay2: number, pctOther: number) {
  const totalC = Math.round(Number(total || 0) * 100);
  if (!Number.isFinite(totalC) || totalC <= 0) return { source1: 0, pay2: 0, other: 0 };
  let p2C = Math.max(0, Math.round(totalC * (Number(pctPay2 || 0) / 100)) || 0);
  let oC = Math.max(0, Math.round(totalC * (Number(pctOther || 0) / 100)) || 0);
  if (p2C + oC > totalC) oC = Math.max(0, totalC - p2C);
  const s1C = totalC - p2C - oC;
  return { source1: s1C / 100, pay2: p2C / 100, other: oC / 100 };
}

/** Parse user-typed money: "$1,234.5" → 1234.5; returns NaN when empty or invalid. */
export function parseMoneyInput(s: string): number {
  const cleaned = String(s ?? '').replace(/[$,\s]/g, '');
  if (!cleaned) return NaN;
  const v = Number(cleaned);
  return Number.isFinite(v) ? round2(v) : NaN;
}
