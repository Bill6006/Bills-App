/**
 * Learns which budget a purchase belongs to from the logs you already have. Nothing is trained ahead of time:
 * every guess comes straight from your history, so when you change a log's budget the next guess changes too.
 *
 * For each store it looks at past purchases there, weighting ones with a similar amount and recent ones more.
 * A store you always file the same way is filed automatically at any amount; at a mixed store (a gas station:
 * fuel or snacks) the amount decides, and when amounts overlap it asks. A store it hasn't seen falls back to
 * the kind of store (all gas stations together), and then to the bank's own category, which only suggests.
 */
import { parseISOToMs, type IsoDate } from '../dates';
import { MISC_ID, type AppData } from '../types';
import { describeMerchant, sameStore, type MerchantInfo, type MerchantKind } from './merchant';

export interface Example { key: string; kind?: MerchantKind; extraId: string; amount: number; date: IsoDate }

export interface Model {
  byKey: Map<string, Example[]>;
  byKind: Map<MerchantKind, Example[]>;
  byCategory: Map<string, Example[]>;
  budgets: Map<string, string>;
  todayMs: number;
}

export interface Suggestion { extraId: string; p: number }
export type Basis = 'store' | 'kind' | 'category' | 'none';
export interface Prediction {
  suggestions: Suggestion[];
  /** Sure enough to file without asking. */
  auto: boolean;
  basis: Basis;
  /** Past purchases the guess is based on. */
  count: number;
  /** How many of those went to the top budget. */
  topCount: number;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export function buildModel(data: AppData, today: IsoDate): Model {
  const budgets = new Map<string, string>([...data.extras.map((x) => [x.id, x.name] as [string, string]), [MISC_ID, 'Unassigned']]);
  const txnCategory = new Map(data.bank.txns.filter((t) => t.bankCategory).map((t) => [t.id, (t.bankCategory || '').toLowerCase()]));
  const byKey = new Map<string, Example[]>(), byKind = new Map<MerchantKind, Example[]>(), byCategory = new Map<string, Example[]>();
  for (const e of data.spendEntries) {
    if (!(e.amount > 0) || !budgets.has(e.extraId)) continue;
    let key = '', kind: MerchantKind | undefined;
    if (e.merchantKey != null || e.merchant) {
      key = e.merchantKey || '';
      kind = describeMerchant(e.merchant || '').kind;
    } else {
      const m = describeMerchant(e.note || '');
      key = m.key;
      kind = m.kind;
      // A log with no note in a budget like "Gas" was bought at a gas station.
      if (!String(e.note || '').trim() && /\b(gas|fuel)\b/i.test(budgets.get(e.extraId) || '')) kind = 'gas';
    }
    const ex: Example = { key, kind, extraId: e.extraId, amount: e.amount, date: e.date };
    if (key) push(byKey, key, ex);
    if (kind) push(byKind, kind, ex);
    const cat = e.bankTxnId ? txnCategory.get(e.bankTxnId) : undefined;
    if (cat) push(byCategory, cat, ex);
  }
  return { byKey, byKind, byCategory, budgets, todayMs: parseISOToMs(today) };
}

/** Purchases within about ±35% of the amount count most. */
const kernel = (a: number, b: number) => { const d = Math.log(Math.max(a, 0.01) / Math.max(b, 0.01)) / 0.35; return Math.exp(-d * d); };
/** Half the weight after six months, so new habits win. */
const recency = (todayMs: number, iso: IsoDate) => Math.pow(0.5, Math.max(0, (todayMs - parseISOToMs(iso)) / 86400000) / 180);

export function examplesFor(model: Model, m: Pick<MerchantInfo, 'key' | 'kind'>, bankCategory?: string): { ex: Example[]; basis: Basis } {
  if (m.key) {
    const exact = model.byKey.get(m.key);
    if (exact?.length) return { ex: exact, basis: 'store' };
    for (const [k, list] of model.byKey) if (sameStore(k, m.key)) return { ex: list, basis: 'store' };
  }
  if (m.kind) {
    const list = model.byKind.get(m.kind);
    if (list?.length) return { ex: list, basis: 'kind' };
  }
  const cat = (bankCategory || '').toLowerCase();
  if (cat && model.byCategory.get(cat)?.length) return { ex: model.byCategory.get(cat)!, basis: 'category' };
  return { ex: [], basis: 'none' };
}

/** How sure it must be to file without asking (store history, kind-of-store history). */
export const SURE = { store: 0.8, kind: 0.85 };

export function predict(model: Model, m: Pick<MerchantInfo, 'key' | 'kind'>, amount: number, bankCategory?: string, sure = SURE): Prediction {
  const { ex, basis } = examplesFor(model, m, bankCategory);
  if (!ex.length) {
    const s = guessFromBankCategory(model, bankCategory);
    return { suggestions: s ? [s] : [], auto: false, basis: 'none', count: 0, topCount: 0 };
  }
  const near = new Map<string, number>(), freq = new Map<string, number>(), counts = new Map<string, number>();
  let nearTotal = 0, freqTotal = 0;
  for (const e of ex) {
    if (!model.budgets.has(e.extraId)) continue;
    const r = recency(model.todayMs, e.date), w = r * kernel(amount, e.amount);
    near.set(e.extraId, (near.get(e.extraId) || 0) + w); nearTotal += w;
    freq.set(e.extraId, (freq.get(e.extraId) || 0) + r); freqTotal += r;
    counts.set(e.extraId, (counts.get(e.extraId) || 0) + 1);
  }
  if (!freqTotal) return { suggestions: [], auto: false, basis: 'none', count: 0, topCount: 0 };
  // Mostly the similar-amount purchases; when none are close, the store's overall habit.
  const C = 0.3;
  const suggestions = [...freq.keys()]
    .map((id) => ({ extraId: id, p: ((near.get(id) || 0) + C * ((freq.get(id) || 0) / freqTotal)) / (nearTotal + C) }))
    .sort((a, b) => b.p - a.p);
  const top = suggestions[0];
  const habit = (freq.get(top.extraId) || 0) / freqTotal;
  const auto = basis === 'store' ? top.p >= sure.store && (nearTotal >= 0.5 || habit >= 0.95)
    : basis === 'kind' ? top.p >= sure.kind && nearTotal >= 1.5
    : false;
  return { suggestions: suggestions.slice(0, 3), auto, basis, count: ex.length, topCount: counts.get(top.extraId) || 0 };
}

const CATEGORY_HINTS: Array<[RegExp, RegExp]> = [
  [/gas|fuel|automotive|auto & transport/, /\b(gas|fuel|car)\b/i],
  [/grocer|supermarket/, /grocer|food/i],
  [/restaurant|dining|fast food|food & drink|coffee/, /fast food|dining|eat|restaurant|food/i],
  [/church|charit|donation|gift/, /tithe|giving|charity|church|gift/i],
];

/** A weak first guess from the bank's own category for a store you've never logged. */
function guessFromBankCategory(model: Model, bankCategory?: string): Suggestion | null {
  const c = (bankCategory || '').toLowerCase();
  if (!c) return null;
  for (const [cat, budget] of CATEGORY_HINTS) {
    if (!cat.test(c)) continue;
    for (const [id, name] of model.budgets) if (id !== MISC_ID && budget.test(name)) return { extraId: id, p: 0.5 };
  }
  for (const [id, name] of model.budgets) if (id !== MISC_ID && name && c.includes(name.toLowerCase())) return { extraId: id, p: 0.5 };
  return null;
}

/** Stores the app has learned, for the Plan › Bank import page. */
export function learnedStores(model: Model): Array<{ key: string; count: number; top: string; topShare: number }> {
  const out: Array<{ key: string; count: number; top: string; topShare: number }> = [];
  for (const [key, list] of model.byKey) {
    const counts = new Map<string, number>();
    for (const e of list) if (model.budgets.has(e.extraId)) counts.set(e.extraId, (counts.get(e.extraId) || 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out.push({ key, count: list.length, top: best[0], topShare: best[1] / list.length });
  }
  return out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
