import type { IsoDate } from '../engine/dates';
import type { AppData, PaySchedule, Prefs } from '../engine/types';

export const DEFAULT_PAY = (today: IsoDate): PaySchedule => ({
  frequency: 'semimonthly',
  paycheckCap: 0,
  anchorNextPayday: today,
  semimonthlyDom1: 15,
  semimonthlyDom2: 31,
  monthlyDom: 15,
  customDates: [],
});

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  timeZone: 'America/New_York',
  billsSort: 'custom',
  debtStrategy: 'avalanche',
  timelineGroup: 'period',
  timelineDensity: 'activity',
  spendingScope: 'period',
  graphRange: 'month',
  graphCustomSource: 'month',
  graphHiddenIds: [],
  paydayChecks: {},
  lastSpendCategory: '',
};

export function makeDefaultData(today: IsoDate, nowIso: string = new Date().toISOString()): AppData {
  const mk = today.slice(0, 7);
  return {
    version: 1,
    settings: {
      baseMonth: mk,
      baseBillsBalance: 0,
      baseSavingsBalance: 0,
      trueSavingsMonth: mk,
      cushion: 0,
      pocket: { minimumSurvival: 0, thresholdMode: 'net' },
      pay: DEFAULT_PAY(today),
      pay2: null,
      otherIncomes: [],
      transferSplit: { pay2BillsPct: 0, pay2SavingsPct: 0, otherBillsPct: 0, otherSavingsPct: 0 },
      savings: { monthlyGoal: 0, timelineMonths: 12 },
    },
    bills: [],
    extras: [],
    debts: [],
    spendEntries: [],
    spendTransfers: [],
    events: [],
    bank: { txns: [], rules: [], profiles: [] },
    order: { bills: [], extras: [] },
    prefs: { ...DEFAULT_PREFS, paydayChecks: {}, graphHiddenIds: [] },
    meta: { createdAt: nowIso, updatedAt: nowIso },
  };
}

/** True when the app has nothing set up yet. */
export function isEmptyData(d: AppData): boolean {
  return !d.bills.length && !d.extras.length && !d.debts.length && !d.events.length && !d.spendEntries.length && !(Number(d.settings.pay.paycheckCap) > 0);
}
