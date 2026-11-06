/**
 * Paydays and recurrence rules, ported line-for-line from v117
 * (getPaydaysForPay, getPaydaysForMonth, getPayCapInfoForMonth, nextPaydayAfterMs,
 *  billOccurrencesForMonth, billOccurrencesForRange).
 */
import {
  addDaysMs, addMonthsKey, daysInMonth, isoDate, monthEndMs, monthStartMs, msUTC, parseISOToMs,
  parseMonthKey, toDateObj, type MonthKey,
} from './dates';
import { clampInt, round2 } from './money';
import type { PaySchedule, RecurringItem, Rule, Settings } from './types';

export interface Occ { id: string; name: string; amount: number; debtId?: string }
export type OccMap = Map<number, Occ[]>;

function uniqSorted(list: number[]): number[] {
  return list.slice().sort((a, b) => a - b).filter((v, i, a) => i === 0 || v !== a[i - 1]);
}

export function getPaydaysForPay(monthKey: MonthKey, pay: Partial<PaySchedule> | null | undefined): number[] {
  const start = monthStartMs(monthKey);
  const end = monthEndMs(monthKey);
  const p = pay && typeof pay === 'object' ? pay : {};
  const freq = String(p.frequency || 'semimonthly');

  if (freq === 'semimonthly') {
    const { y, m } = parseMonthKey(monthKey);
    const dim = daysInMonth(y, m);
    const dom1 = clampInt(p.semimonthlyDom1 ?? 15, 1, dim);
    const dom2 = Math.max(1, Math.min(dim, clampInt(p.semimonthlyDom2 ?? dim, 1, 31)));
    return uniqSorted([msUTC(y, m, dom1), msUTC(y, m, dom2)]);
  }

  if (freq === 'monthly') {
    const { y, m } = parseMonthKey(monthKey);
    const dim = daysInMonth(y, m);
    let dom = Number(p.monthlyDom || 0);
    if (!dom) dom = Number(String(p.anchorNextPayday ?? '').split('-')[2] || 1);
    return [msUTC(y, m, clampInt(dom, 1, dim))];
  }

  if (freq === 'custom') {
    const out: number[] = [];
    for (const iso of Array.isArray(p.customDates) ? p.customDates : []) {
      if (String(iso).slice(0, 7) === monthKey) {
        const ms = parseISOToMs(iso);
        if (ms >= start && ms <= end) out.push(ms);
      }
    }
    return uniqSorted(out);
  }

  const step = freq === 'weekly' ? 7 : 14;
  const anchor = parseISOToMs(String(p.anchorNextPayday ?? ''));
  let first = anchor;
  while (first > start) first = addDaysMs(first, -step);
  const out: number[] = [];
  let cur = first;
  while (cur < start) cur = addDaysMs(cur, step);
  while (cur <= end) {
    out.push(cur);
    cur = addDaysMs(cur, step);
  }
  return out;
}

export function getPaydaysForMonth(monthKey: MonthKey, settings: Pick<Settings, 'pay' | 'pay2'>): number[] {
  const p1 = getPaydaysForPay(monthKey, settings.pay);
  const p2 = settings.pay2 ? getPaydaysForPay(monthKey, settings.pay2) : [];
  return uniqSorted(p1.concat(p2));
}

export function nextPaydayAfterMs(ms: number, settings: Pick<Settings, 'pay' | 'pay2'>): number | null {
  let mk = isoDate(ms).slice(0, 7);
  for (let guard = 0; guard < 36; guard++) {
    for (const p of getPaydaysForMonth(mk, settings)) if (p > ms) return p;
    mk = addMonthsKey(mk, 1);
  }
  return null;
}

function parseAnchorIso(rule: Rule & Record<string, unknown>): string | null {
  const a = rule.anchor || rule.iso || rule.date || rule.ymd || '';
  const iso = String(a || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

export function occurrencesForMonth(monthKey: MonthKey, items: RecurringItem[], settings: Pick<Settings, 'pay' | 'pay2'>): OccMap {
  const start = monthStartMs(monthKey);
  const end = monthEndMs(monthKey);
  const { y, m } = parseMonthKey(monthKey);
  const dim = daysInMonth(y, m);
  const occ: OccMap = new Map();
  const addOcc = (ms: number, item: Occ) => {
    if (!Number.isFinite(ms) || ms < start || ms > end) return;
    const list = occ.get(ms);
    if (list) list.push(item); else occ.set(ms, [item]);
  };

  for (const b of items || []) {
    const rule = (b && b.rule ? b.rule : {}) as Rule & Record<string, unknown>;
    const type = String(rule.type || 'monthly_dom');
    const item: Occ = { id: b.id, name: b.name, amount: Number(b.amount) };
    const debtId = (b as RecurringItem & { _debtId?: string })._debtId;
    if (debtId) item.debtId = debtId;

    if (type === 'monthly_dom') {
      addOcc(msUTC(y, m, clampInt(rule.dom ?? 1, 1, dim)), item);
    } else if (type === 'weekly_dow') {
      const target = clampInt(rule.dow ?? 1, 0, 6);
      for (let d = 1; d <= dim; d++) {
        const ms = msUTC(y, m, d);
        if (toDateObj(ms).dow === target) addOcc(ms, item);
      }
    } else if (type === 'annual_md') {
      const iso = parseAnchorIso(rule);
      if (!iso) continue;
      const mm = clampInt(Number(iso.slice(5, 7)), 1, 12);
      const dd = clampInt(Number(iso.slice(8, 10)), 1, 31);
      if (mm !== m) continue;
      addOcc(msUTC(y, m, clampInt(dd, 1, dim)), item);
    } else if (type === 'one_time') {
      const iso = parseAnchorIso(rule);
      if (!iso || iso.slice(0, 7) !== monthKey) continue;
      addOcc(parseISOToMs(iso), item);
    } else if (type === 'biweekly') {
      const iso = parseAnchorIso(rule);
      if (!iso) continue;
      let first = parseISOToMs(iso);
      while (first > start) first = addDaysMs(first, -14);
      let cur = first;
      while (cur < start) cur = addDaysMs(cur, 14);
      while (cur <= end) {
        addOcc(cur, item);
        cur = addDaysMs(cur, 14);
      }
    } else if (type === 'perpay') {
      if (b._extraMonth && String(b._extraMonth).length === 7 && monthKey < String(b._extraMonth)) continue;
      for (const p of getPaydaysForMonth(monthKey, settings)) addOcc(p, item);
    }
  }
  return occ;
}

/** Occurrences across month boundaries (used for pay periods that cross months). */
export function occurrencesForRange(startMs: number, endMs: number, items: RecurringItem[], settings: Pick<Settings, 'pay' | 'pay2'>): OccMap {
  const out: OccMap = new Map();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return out;
  let mk = isoDate(startMs).slice(0, 7);
  const mkEnd = isoDate(endMs).slice(0, 7);
  for (let guard = 0; guard < 36; guard++) {
    for (const [dms, list] of occurrencesForMonth(mk, items, settings)) {
      if (dms < startMs || dms > endMs) continue;
      const cur = out.get(dms);
      if (cur) cur.push(...list); else out.set(dms, [...list]);
    }
    if (mk === mkEnd) break;
    mk = addMonthsKey(mk, 1);
  }
  return out;
}

export interface PayCapInfo {
  paydays: number[];
  payCaps: number[];
  pay1Caps: number[];
  pay2Caps: number[];
  minCap: number;
  otherIncomeTotal: number;
  otherIncomePerPayday: number;
  otherIncomeAlloc: number[];
}

/** Paycheck amount for each payday, with extra income credited to the pay period it lands in. */
export function getPayCapInfoForMonth(monthKey: MonthKey, settings: Settings, paydays?: number[]): PayCapInfo {
  const days = (Array.isArray(paydays) ? paydays : getPaydaysForMonth(monthKey, settings)).slice().sort((a, b) => a - b);
  const p1 = settings.pay || ({} as PaySchedule);
  const p2 = settings.pay2 || null;
  const p1days = getPaydaysForPay(monthKey, p1);
  const p2days = p2 ? getPaydaysForPay(monthKey, p2) : [];
  const baseCaps = new Map<number, number>(), cap1Caps = new Map<number, number>(), cap2Caps = new Map<number, number>();
  for (const d of days) { baseCaps.set(d, 0); cap1Caps.set(d, 0); cap2Caps.set(d, 0); }
  const cap1 = Number(p1.paycheckCap || 0);
  for (const d of p1days) if (baseCaps.has(d)) { baseCaps.set(d, baseCaps.get(d)! + cap1); cap1Caps.set(d, cap1Caps.get(d)! + cap1); }
  const cap2 = p2 ? Number(p2.paycheckCap || 0) : 0;
  for (const d of p2days) if (baseCaps.has(d)) { baseCaps.set(d, baseCaps.get(d)! + cap2); cap2Caps.set(d, cap2Caps.get(d)! + cap2); }

  const occ = occurrencesForMonth(monthKey, Array.isArray(settings.otherIncomes) ? settings.otherIncomes : [], settings);
  const alloc = new Array<number>(days.length).fill(0);
  let total = 0;
  const findPayIndexForDate = (ms: number) => {
    if (!days.length) return null;
    let lo = 0, hi = days.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? ans : 0;
  };
  for (const [ms, list] of occ) {
    for (const it of list) {
      const amt = Number(it.amount || 0);
      if (!amt) continue;
      total += amt;
      const idx = findPayIndexForDate(ms);
      if (idx != null) alloc[idx] = round2(Number(alloc[idx] || 0) + amt);
    }
  }
  const payCaps = days.map((d, i) => round2(Number(baseCaps.get(d) || 0) + Number(alloc[i] || 0)));
  return {
    paydays: days,
    payCaps,
    pay1Caps: days.map((d) => round2(Number(cap1Caps.get(d) || 0))),
    pay2Caps: days.map((d) => round2(Number(cap2Caps.get(d) || 0))),
    minCap: payCaps.length ? Math.min(...payCaps) : 0,
    otherIncomeTotal: round2(total),
    otherIncomePerPayday: days.length ? round2(total / days.length) : 0,
    otherIncomeAlloc: alloc,
  };
}

/** Human description of a repeat rule: "Monthly on the 1st", "Every other Fri from Oct 30". */
export function describeRule(rule: Rule | undefined): string {
  const r = rule || ({ type: 'monthly_dom', dom: 1 } as Rule);
  const ord = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const dows = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const anchorText = (iso?: string) => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    return `${mons[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
  };
  switch (r.type) {
    case 'monthly_dom': {
      const d = clampInt(r.dom ?? 1, 1, 31);
      return d >= 31 ? 'Monthly on the last day' : `Monthly on the ${ord(d)}`;
    }
    case 'weekly_dow': return `Every ${dows[clampInt(r.dow ?? 1, 0, 6)]}`;
    case 'annual_md': return `Yearly on ${anchorText(r.anchor) || 'a set date'}`;
    case 'one_time': return r.anchor ? `Once on ${anchorText(r.anchor)}, ${r.anchor.slice(0, 4)}` : 'Once';
    case 'biweekly': {
      const a = r.anchor ? toDateObj(parseISOToMs(r.anchor)) : null;
      return a ? `Every other ${dows[a.dow]}` : 'Every two weeks';
    }
    case 'perpay': return 'Every payday';
    default: return 'Repeats';
  }
}
