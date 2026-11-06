/** Fills in anything missing from saved or backed-up data so older saves keep working as the app grows. */
import { isMonthKey, type IsoDate } from '../engine/dates';
import type { AppData, DebtPayment } from '../engine/types';
import { DEFAULT_PAY, DEFAULT_PREFS, makeDefaultData } from './defaults';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function upgradeData(raw: unknown, today: IsoDate): AppData {
  const base = makeDefaultData(today);
  if (!isObj(raw)) return base;
  const r = raw as Partial<AppData> & Obj;
  const s = (isObj(r.settings) ? r.settings : {}) as Partial<AppData['settings']>;
  const settings: AppData['settings'] = {
    ...base.settings,
    ...s,
    baseMonth: isMonthKey(s.baseMonth) ? s.baseMonth : base.settings.baseMonth,
    trueSavingsMonth: isMonthKey(s.trueSavingsMonth) ? s.trueSavingsMonth : (isMonthKey(s.baseMonth) ? s.baseMonth : base.settings.trueSavingsMonth),
    pocket: { ...base.settings.pocket, ...(isObj(s.pocket) ? s.pocket : {}) },
    pay: { ...DEFAULT_PAY(today), ...(isObj(s.pay) ? s.pay : {}) },
    pay2: isObj(s.pay2) ? { ...DEFAULT_PAY(today), ...s.pay2 } : null,
    otherIncomes: arr(s.otherIncomes),
    transferSplit: { ...base.settings.transferSplit, ...(isObj(s.transferSplit) ? s.transferSplit : {}) },
    savings: { ...base.settings.savings, ...(isObj(s.savings) ? s.savings : {}) },
  };
  const prefs = { ...DEFAULT_PREFS, ...(isObj(r.prefs) ? r.prefs : {}) } as AppData['prefs'];
  prefs.paydayChecks = isObj(prefs.paydayChecks) ? prefs.paydayChecks : {};
  prefs.graphHiddenIds = arr<string>(prefs.graphHiddenIds);
  const debts = arr<AppData['debts'][number]>(r.debts).map((d) => ({
    ...d,
    payments: arr<DebtPayment>(d.payments),
    autoPay: typeof d.autoPay === 'boolean' ? d.autoPay : true,
    autoPaidThrough: typeof d.autoPaidThrough === 'string' && d.autoPaidThrough ? d.autoPaidThrough : today,
    interestStartDate: d.interestStartDate || '',
  }));
  const bills = arr<AppData['bills'][number]>(r.bills);
  const extras = arr<AppData['extras'][number]>(r.extras);
  const order = isObj(r.order) ? (r.order as AppData['order']) : { bills: [], extras: [] };
  const fixOrder = (saved: unknown, ids: string[]) => {
    const list = arr<string>(saved).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i);
    for (const id of ids) if (!list.includes(id)) list.push(id);
    return list;
  };
  return {
    version: 1,
    settings,
    bills,
    extras,
    debts,
    spendEntries: arr(r.spendEntries),
    spendTransfers: arr(r.spendTransfers),
    events: arr(r.events),
    bank: (() => {
      const b = isObj(r.bank) ? (r.bank as Partial<AppData['bank']>) : {};
      return { ...b, txns: arr(b.txns), rules: arr(b.rules), profiles: arr(b.profiles) } as AppData['bank'];
    })(),
    order: { bills: fixOrder(order.bills, bills.map((b) => b.id)), extras: fixOrder(order.extras, extras.map((x) => x.id)) },
    prefs,
    meta: { ...base.meta, ...(isObj(r.meta) ? r.meta : {}) },
  };
}
