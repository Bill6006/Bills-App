/**
 * The plan engine: v117's "fixed transfer" model (computeAS2ForMonth, projectedSavingsAtMonthStart,
 * buildPlanRange), ported exactly. With all fixes off it reproduces v117 to the cent.
 */
import {
  addDaysMs, addMonthsKey, isoDate, monthEndMs, monthIndex, monthKeyFromIndex, monthStartMs,
  normalizeISODateLoose, type IsoDate, type MonthKey,
} from './dates';
import { ceil2, round2 } from './money';
import {
  getPayCapInfoForMonth, getPaydaysForMonth, nextPaydayAfterMs, occurrencesForMonth, occurrencesForRange,
  type Occ, type OccMap,
} from './schedule';
import { debtBillsForMonth, type PayoffSchedule } from './loans';
import type { AppData, EngineOptions, RecurringItem, Settings } from './types';

export interface PlanRow {
  ms: number;
  isPayday: boolean;
  transferIn: number;
  billsOut: number;
  savingsIn: number;
  savingsOut: number;
  pocketOut: number;
  /** True balance (includes any surplus carried from earlier months). */
  billsBalance: number;
  /** What the Bills account should have: the plan's working balance (v117 Ledger column). */
  billsBalanceWorking: number;
  savingsBalance: number;
  bills: Occ[];
  events: Occ[];
  extras: Occ[];
}

export interface MonthPlan {
  mk: MonthKey;
  monthStart: number;
  monthEnd: number;
  /** Needed before first payday: bills before the first payday + cushion. */
  AS2: number;
  prePaycheckTotal: number;
  /** Carry into next month: next month's AS2. */
  TargetCarry: number;
  /** Month's bills total (including loan payments). */
  TB1: number;
  paydays: number[];
  payCaps: number[];
  pay1Caps: number[];
  pay2Caps: number[];
  minPayCap: number;
  otherIncomeTotal: number;
  otherIncomePerPayday: number;
  otherIncomeAlloc: number[];
  nextPaydayAfterLast: number | null;
  billsPerPaycheck: number;
  desiredBillsPerPaycheck: number;
  nominalBillsPerPaycheck: number;
  minBillsPerPaycheckForCushion: number;
  maxBillsPerPaycheck: number;
  extraFunding: number;
  /** v117 value: goal ÷ paydays, to the cent. */
  savingsPerPaycheck: number;
  /** Per-payday savings move (equals savingsPerPaycheck unless the cents fix gives the last payday the remainder). */
  savingsByPayIndex: number[];
  savingsGoal: number;
  /** Planned working balance at the start of the month (AS2 + extra funding). */
  seedWanted: number;
  topup: number;
  startAfterTopup: number;
  TB2_at_start: number;
  startBills: number;
  startSavings: number;
  billsStartSurplus: number;
  endBills: number;
  endSavings: number;
  lowestBillsBal: number;
  lowestBillsBalDate: number | null;
  pocketSpentByPayIndex: number[];
  rows: PlanRow[];
  ledgerBills: RecurringItem[];
}

interface MonthCore {
  mk: MonthKey;
  ledgerBills: RecurringItem[];
  occ: OccMap;
  xocc: OccMap;
  eocc: OccMap;
  TB1: number;
  AS2: number;
  pre: number;
  paydays: number[];
}

export class PlanEngine {
  readonly data: AppData;
  readonly opts: EngineOptions;
  private cores = new Map<MonthKey, MonthCore>();
  private single = new Map<MonthKey, MonthPlan>();
  private ranges = new Map<string, Map<MonthKey, MonthPlan>>();
  readonly debtSchedules = new Map<string, PayoffSchedule>();

  constructor(data: AppData, opts: EngineOptions) {
    this.data = data;
    this.opts = opts;
  }

  get settings(): Settings { return this.data.settings; }

  /** Month-local facts: bills (with loans), budget and withdrawal occurrences, AS2, paydays. */
  core(mk: MonthKey): MonthCore {
    let c = this.cores.get(mk);
    if (c) return c;
    const s = this.settings;
    const ledgerBills = this.data.bills.concat(debtBillsForMonth(mk, this.data.debts, this.opts.today, this.opts.fixes, this.debtSchedules));
    const occ = occurrencesForMonth(mk, ledgerBills, s);
    const xocc = occurrencesForMonth(mk, this.data.extras, s);
    const eocc = occurrencesForMonth(mk, this.data.events, s);
    let tb1 = 0;
    for (const arr of occ.values()) for (const it of arr) tb1 += Number(it.amount);
    const paydays = getPaydaysForMonth(mk, s);
    const end = monthEndMs(mk);
    const P1 = paydays.length > 0 ? paydays[0] : addDaysMs(end, 1);
    let pre = 0;
    for (const [ms, list] of occ) if (ms < P1) for (const it of list) pre += Number(it.amount);
    c = { mk, ledgerBills, occ, xocc, eocc, TB1: round2(tb1), AS2: round2(pre + Number(s.cushion || 0)), pre: round2(pre), paydays };
    this.cores.set(mk, c);
    return c;
  }

  /** Savings balance at the start of a month, projected from the savings balance you entered. */
  projectedSavingsAtMonthStart(mk: MonthKey, goalOverride?: number): number {
    const s = this.settings;
    if (!mk) return 0;
    const goal = Number(goalOverride != null && Number.isFinite(Number(goalOverride)) ? goalOverride : s.savings?.monthlyGoal || 0);
    const trueMonth = String(s.trueSavingsMonth || '').trim() || mk;
    const trueBal = Number(s.baseSavingsBalance || 0);
    const a = monthIndex(mk), b = monthIndex(trueMonth);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return round2(trueBal);
    if (this.opts.fixes.consistentEvents) {
      // Same withdrawals the ledger uses (recurring ones counted every time they occur).
      let bal = trueBal;
      if (a >= b) {
        for (let i = b; i < a; i++) bal += goal - this.eventsTotal(monthKeyFromIndex(i));
      } else {
        for (let i = a; i < b; i++) bal -= goal - this.eventsTotal(monthKeyFromIndex(i));
      }
      return round2(bal);
    }
    let base = round2(trueBal + (a - b) * goal);
    let evSum = 0;
    for (const x of this.data.events || []) {
      if (!x) continue;
      const iso = normalizeISODateLoose(x.rule?.anchor || (x as unknown as { date?: string }).date || (x as unknown as { iso?: string }).iso || '');
      if (!iso) continue;
      const ix = monthIndex(iso.slice(0, 7));
      if (!Number.isFinite(ix) || ix < b || ix >= a) continue;
      evSum += Number(x.amount || 0);
    }
    if (evSum) base = round2(base - evSum);
    return round2(base);
  }

  eventsTotal(mk: MonthKey): number {
    let t = 0;
    for (const list of this.core(mk).eocc.values()) for (const it of list) t += Number(it.amount || 0);
    return round2(t);
  }

  /** Plan for one month, seeded from that month itself (exact for every working-balance and savings figure when fixes are on). */
  plan(mk: MonthKey): MonthPlan {
    let p = this.single.get(mk);
    if (p) return p;
    p = this.buildRange(mk, mk).get(mk)!;
    this.single.set(mk, p);
    return p;
  }

  /** v117 buildPlanRange(baseMonth, toMonthInclusive): plans for every month from start to end. */
  buildRange(startMk: MonthKey, endMk: MonthKey): Map<MonthKey, MonthPlan> {
    const key = `${startMk}|${endMk}`;
    const cached = this.ranges.get(key);
    if (cached) return cached;
    const s = this.settings;
    const fixes = this.opts.fixes;
    const months: MonthKey[] = [];
    for (let i = monthIndex(startMk); i <= monthIndex(endMk) + 1; i++) months.push(monthKeyFromIndex(i));
    const plans = new Map<MonthKey, MonthPlan>();
    const seedMonth = startMk;
    const anchorMonth = String(s.baseMonth || seedMonth).trim() || seedMonth;
    let billsStart = seedMonth === anchorMonth ? Number(s.baseBillsBalance || 0) : Number(this.core(seedMonth).AS2 || 0);
    let savingsStart = Number(this.projectedSavingsAtMonthStart(seedMonth) || 0);

    for (let idx = 0; idx < months.length - 1; idx++) {
      const mk = months[idx];
      const nextMk = months[idx + 1];
      if (anchorMonth && mk === anchorMonth && mk !== seedMonth) billsStart = Number(s.baseBillsBalance || 0);
      const c = this.core(mk);
      const monthStart = monthStartMs(mk), monthEnd = monthEndMs(mk);
      const startBills = billsStart, startSavings = savingsStart;
      const AS2 = c.AS2;
      const TargetCarry = this.core(nextMk).AS2;
      const TB1 = c.TB1;
      const capInfo = getPayCapInfoForMonth(mk, s, c.paydays);
      const paydays = capInfo.paydays;
      const sortedPaydays = paydays.slice().sort((a, b) => a - b);
      const lastPayday = sortedPaydays.length ? sortedPaydays[sortedPaydays.length - 1] : null;
      const nextPaydayAfterLast = lastPayday != null ? nextPaydayAfterMs(lastPayday, s) : null;
      const seedForPlanning = round2(AS2);
      const cushion = Number(s.cushion || 0);
      const b0 = round2(seedForPlanning - cushion);
      const N = paydays.length;
      const paydaySet = new Set(paydays);

      const savingsGoal = Number(s.savings?.monthlyGoal || 0);
      const savingsPerPaycheck = N > 0 ? round2(savingsGoal / N) : 0;
      const savingsByPayIndex = new Array<number>(N).fill(savingsPerPaycheck);
      if (fixes.savingsCents && N > 0) savingsByPayIndex[N - 1] = round2(savingsGoal - savingsPerPaycheck * (N - 1));
      const savingsForCap = N > 0 ? Math.max(...savingsByPayIndex) : 0;

      const cap = Number(capInfo.minCap || 0);
      const maxBillsPerPaycheck = Math.max(0, round2(cap - (fixes.savingsCents ? savingsForCap : savingsPerPaycheck)));
      const totalNeeded = Math.max(0, TargetCarry + TB1 - seedForPlanning);
      const nominalBillsPerPaycheck = N > 0 ? ceil2(totalNeeded / N) : 0;

      let minBillsPerPaycheckForCushion = 0;
      if (N > 0) {
        let D = 0, W = 0, maxReq = 0;
        for (let t = monthStart; t <= monthEnd; t = addDaysMs(t, 1)) {
          if (paydaySet.has(t)) D += 1;
          for (const it of c.occ.get(t) || []) W += Number(it.amount);
          if (D > 0) {
            const req = (W - b0) / D;
            if (req > maxReq) maxReq = req;
          }
        }
        minBillsPerPaycheckForCushion = ceil2(Math.max(0, maxReq));
      }
      const desiredBillsPerPaycheck = Math.max(nominalBillsPerPaycheck, minBillsPerPaycheckForCushion);
      const billsPerPaycheck = Math.min(desiredBillsPerPaycheck, maxBillsPerPaycheck);

      let extraFunding = 0;
      if (N > 0) {
        let D = 0, W = 0, maxNeed = 0;
        for (let t = monthStart; t <= monthEnd; t = addDaysMs(t, 1)) {
          if (paydaySet.has(t)) D += 1;
          for (const it of c.occ.get(t) || []) W += Number(it.amount);
          const need = W - (b0 + billsPerPaycheck * D);
          if (need > maxNeed) maxNeed = need;
        }
        const endWithoutExtra = round2(seedForPlanning + billsPerPaycheck * N - TB1);
        extraFunding = ceil2(Math.max(Math.max(0, maxNeed), Math.max(0, TargetCarry - endWithoutExtra)));
      } else {
        const endWithoutExtra = round2(seedForPlanning - TB1);
        extraFunding = ceil2(Math.max(0, TargetCarry - endWithoutExtra));
      }

      const seedWanted = round2(seedForPlanning + extraFunding);
      const billsStartSurplus = round2(Math.max(0, billsStart - seedWanted));
      const topup = round2(Math.max(0, seedWanted - billsStart));
      const startAfterTopup = round2(billsStart + topup);

      const rows: PlanRow[] = [];
      let billsBal = startAfterTopup;
      let savingsBal = savingsStart;
      let lowestBillsBal = Infinity;
      let lowestBillsBalDate: number | null = null;
      let payIdx = -1;
      for (let ms = monthStart; ms <= monthEnd; ms = addDaysMs(ms, 1)) {
        const isPayday = paydaySet.has(ms);
        if (isPayday) payIdx = sortedPaydays.indexOf(ms);
        let transferIn = 0, savingsIn = 0, billsOut = 0, pocketOut = 0, savingsOut = 0;
        if (isPayday) {
          transferIn += billsPerPaycheck;
          savingsIn += fixes.savingsCents ? savingsByPayIndex[payIdx] : savingsPerPaycheck;
        }
        const dayBills = c.occ.get(ms) || [];
        for (const it of dayBills) billsOut += Number(it.amount);
        const dayExtras = c.xocc.get(ms) || [];
        for (const it of dayExtras) pocketOut += Number(it.amount);
        const dayEvents = c.eocc.get(ms) || [];
        for (const it of dayEvents) savingsOut += Number(it.amount || 0);
        billsBal = round2(billsBal + transferIn - billsOut);
        savingsBal = round2(savingsBal + savingsIn - savingsOut);
        const billsBalDisplay = round2(billsBal - billsStartSurplus);
        if (billsBalDisplay < lowestBillsBal) {
          lowestBillsBal = billsBalDisplay;
          lowestBillsBalDate = ms;
        }
        rows.push({
          ms, isPayday,
          transferIn: round2(transferIn), billsOut: round2(billsOut), savingsIn: round2(savingsIn),
          savingsOut: round2(savingsOut), pocketOut: round2(pocketOut),
          billsBalance: billsBal, billsBalanceWorking: billsBalDisplay, savingsBalance: savingsBal,
          bills: dayBills, events: dayEvents, extras: dayExtras,
        });
      }

      const spentByPayIndex = new Array<number>(Math.max(0, sortedPaydays.length)).fill(0);
      if (sortedPaydays.length) {
        for (const r of rows) {
          if (r.pocketOut <= 0) continue;
          let pi = -1;
          for (let i = 0; i < sortedPaydays.length; i++) {
            if (sortedPaydays[i] <= r.ms) pi = i; else break;
          }
          if (pi >= 0) spentByPayIndex[pi] = round2(spentByPayIndex[pi] + r.pocketOut);
        }
        if (nextPaydayAfterLast) {
          const lastIdx = sortedPaydays.length - 1;
          const addStart = addDaysMs(monthEnd, 1);
          const addEnd = addDaysMs(nextPaydayAfterLast, -1);
          if (addStart <= addEnd) {
            for (const items of occurrencesForRange(addStart, addEnd, this.data.extras, s).values()) {
              for (const it of items) spentByPayIndex[lastIdx] = round2(spentByPayIndex[lastIdx] + Number(it.amount || 0));
            }
          }
        }
      }

      const endBills = billsBal, endSavings = savingsBal;
      billsStart = endBills;
      savingsStart = endSavings;

      plans.set(mk, {
        mk, monthStart, monthEnd, AS2, prePaycheckTotal: c.pre, TargetCarry, TB1,
        paydays, payCaps: capInfo.payCaps, pay1Caps: capInfo.pay1Caps, pay2Caps: capInfo.pay2Caps, minPayCap: cap,
        otherIncomeTotal: capInfo.otherIncomeTotal, otherIncomePerPayday: capInfo.otherIncomePerPayday, otherIncomeAlloc: capInfo.otherIncomeAlloc,
        nextPaydayAfterLast, billsPerPaycheck, desiredBillsPerPaycheck, nominalBillsPerPaycheck, minBillsPerPaycheckForCushion,
        maxBillsPerPaycheck, extraFunding, savingsPerPaycheck, savingsByPayIndex, savingsGoal, seedWanted,
        topup, startAfterTopup, TB2_at_start: round2(startBills), startBills: round2(startBills), startSavings: round2(startSavings),
        billsStartSurplus, endBills, endSavings, lowestBillsBal: round2(lowestBillsBal), lowestBillsBalDate,
        pocketSpentByPayIndex: spentByPayIndex, rows, ledgerBills: c.ledgerBills,
      });
    }
    this.ranges.set(key, plans);
    return plans;
  }

  /** The v117 range for viewing a month: min(base, view) → max(base, view) + horizon. */
  v117Range(viewMk: MonthKey): Map<MonthKey, MonthPlan> {
    const s = this.settings;
    const base = String(s.baseMonth || viewMk);
    const tlMonths = Number(s.savings?.timelineMonths || 6);
    const horizon = Math.max(12, (Number.isFinite(tlMonths) ? tlMonths : 6) + 2);
    const start = monthIndex(base) <= monthIndex(viewMk) ? base : viewMk;
    const endBase = monthIndex(base) >= monthIndex(viewMk) ? base : viewMk;
    return this.buildRange(start, addMonthsKey(endBase, horizon));
  }

  rowFor(ms: number): PlanRow | null {
    const mk = isoDate(ms).slice(0, 7);
    const p = this.plan(mk);
    return p.rows.find((r) => r.ms === ms) ?? null;
  }

  today(): IsoDate { return this.opts.today; }
}
