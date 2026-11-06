import type { IsoDate, MonthKey } from './dates';

/** How a bill, budget, extra income or withdrawal repeats (same rule types as v117). */
export type RuleType = 'monthly_dom' | 'weekly_dow' | 'annual_md' | 'one_time' | 'biweekly' | 'perpay';

export interface Rule {
  type: RuleType;
  /** Day of month 1–31 (monthly_dom); short months clamp to their last day. */
  dom?: number;
  /** Day of week 0–6, Sunday = 0 (weekly_dow). */
  dow?: number;
  /** YYYY-MM-DD (annual_md uses its month/day, one_time its date, biweekly steps 14 days from it). */
  anchor?: IsoDate;
}

/** Bills, spending budgets ("extras"), extra incomes and savings withdrawals all share this shape. */
export interface RecurringItem {
  id: string;
  name: string;
  amount: number;
  rule: Rule;
  /** Legacy v117 field: per-pay rules don't apply to months before this one. */
  _extraMonth?: MonthKey;
}

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'custom';

export interface PaySchedule {
  frequency: PayFrequency;
  /** Take-home amount per payday (v117 "paycheck cap"). */
  paycheckCap: number;
  /** Any payday in the series (weekly / every-two-weeks); also the monthly fallback day. */
  anchorNextPayday: IsoDate;
  semimonthlyDom1: number;
  semimonthlyDom2: number;
  monthlyDom: number;
  customDates: IsoDate[];
}

export interface TransferSplit {
  pay2BillsPct: number;
  pay2SavingsPct: number;
  otherBillsPct: number;
  otherSavingsPct: number;
}

export interface Settings {
  /** Month whose start the Bills balance below refers to (v117 "Base month"). */
  baseMonth: MonthKey;
  baseBillsBalance: number;
  /** Savings balance at the start of trueSavingsMonth. */
  baseSavingsBalance: number;
  trueSavingsMonth: MonthKey;
  cushion: number;
  pocket: { minimumSurvival: number; thresholdMode: 'net' | 'base' };
  pay: PaySchedule;
  pay2: PaySchedule | null;
  otherIncomes: RecurringItem[];
  transferSplit: TransferSplit;
  savings: { monthlyGoal: number; timelineMonths: number };
}

export interface DebtPayment {
  id: string;
  date: IsoDate;
  amount: number;
  principal: number;
  interest: number;
  balanceBefore: number;
  balanceAfter: number;
  note: string;
  createdAt: string;
  interestDays?: number | null;
  /** Applied automatically on the due date (the app assumed the scheduled payment was made). */
  auto?: boolean;
}

export interface Debt {
  id: string;
  name: string;
  /** Current balance. */
  balance: number;
  /** Starting balance, for "% paid". */
  originalBalance: number;
  apr: number;
  minPayment: number;
  extraPayment: number;
  dueDay: number;
  priority: number;
  /** Non-empty switches interest to daily (APR ÷ 365 × days since the last payment). */
  interestStartDate: IsoDate | '';
  payments: DebtPayment[];
  /** Apply the scheduled payment automatically on each due date. */
  autoPay: boolean;
  /** Due dates up to and including this date have already been considered for auto-pay. */
  autoPaidThrough: IsoDate;
}

export const MISC_ID = '__misc__';
export const MISC_NAME = 'Misc';

export interface SpendEntry {
  id: string;
  /** Budget id ("extra" id), or MISC_ID for Unassigned. */
  extraId: string;
  /** Budget name when logged. */
  extraName: string;
  /** Signed: spends are positive, refunds negative. */
  amount: number;
  entryType: 'spend' | 'refund';
  date: IsoDate;
  note: string;
  createdAt: string;
}

export interface SpendTransfer {
  id: string;
  fromExtraId: string;
  fromExtraName: string;
  toExtraId: string;
  toExtraName: string;
  amount: number;
  date: IsoDate;
  note: string;
  createdAt: string;
}

/** A planned savings withdrawal (v117 "Event"): grouped by event name, e.g. "Travel" › "Hotel". */
export interface SavingsEvent {
  id: string;
  event: string;
  item: string;
  amount: number;
  rule: Rule;
  /** Derived display name, kept for compatibility with v117 data. */
  name: string;
}

export type ThemePref = 'system' | 'dark' | 'light';
export type BillsSort = 'custom' | 'alpha' | 'date' | 'amountAsc' | 'amountDesc';
export type DebtStrategy = 'avalanche' | 'snowball' | 'custom';

export interface Prefs {
  theme: ThemePref;
  /** "America/New_York" (v117 behaviour) or "device". */
  timeZone: string;
  billsSort: BillsSort;
  debtStrategy: DebtStrategy;
  timelineGroup: 'period' | 'month';
  timelineDensity: 'activity' | 'all';
  spendingScope: 'period' | 'month';
  graphRange: 'month' | 'last7' | 'custom';
  graphCustomSource: 'month' | 'last7';
  graphHiddenIds: string[];
  /** Payday checklist ticks keyed by payday date. */
  paydayChecks: Record<IsoDate, { bills?: boolean; savings?: boolean }>;
  lastSpendCategory: string;
}

export interface AppData {
  version: 1;
  settings: Settings;
  bills: RecurringItem[];
  /** Spending budgets (v117 "Extra costs (pocket only)"). */
  extras: RecurringItem[];
  debts: Debt[];
  spendEntries: SpendEntry[];
  spendTransfers: SpendTransfer[];
  events: SavingsEvent[];
  order: { bills: string[]; extras: string[] };
  prefs: Prefs;
  meta: {
    createdAt: string;
    updatedAt: string;
    importedFrom?: { app: 'v117'; at: string; fileName?: string };
    lastBackupAt?: string;
  };
}

/** Deliberate fixes to v117 behaviour. All false reproduces v117 exactly (used by parity tests). */
export interface Fixes {
  /** Stop scheduling a loan's payment after its payoff month and cap the last payment. */
  loanPayoffStop: boolean;
  /** Give the last payday the leftover cent so each month's savings equals the goal. */
  savingsCents: boolean;
  /** Count recurring withdrawals the same way in savings projections as in the ledger. */
  consistentEvents: boolean;
}

export const ALL_FIXES: Fixes = { loanPayoffStop: true, savingsCents: true, consistentEvents: true };
export const NO_FIXES: Fixes = { loanPayoffStop: false, savingsCents: false, consistentEvents: false };

export interface EngineOptions {
  today: IsoDate;
  fixes: Fixes;
}
