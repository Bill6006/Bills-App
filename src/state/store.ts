import { create } from 'zustand';
import { msUntilNextMidnight, todayIso, type IsoDate } from '../engine/dates';
import { catchUpAutoPay } from '../engine/loans';
import type { AppData } from '../engine/types';
import { makeDefaultData } from '../data/defaults';
import { loadAll, saveData, saveWhatIf } from '../data/storage';
import { requestPersistentStorage } from '../app/pwa';
import { toast } from './toast';

interface State {
  hydrated: boolean;
  data: AppData;
  /** Sandbox copy while What-if mode is on; edits go here and are thrown away unless kept. */
  whatIf: AppData | null;
  today: IsoDate;
  undoSnap: { label: string; data: AppData; whatIf: AppData | null } | null;
}

const initialToday = todayIso();
export const useStore = create<State>(() => ({
  hydrated: false,
  data: makeDefaultData(initialToday),
  whatIf: null,
  today: initialToday,
  undoSnap: null,
}));

export const useActive = () => useStore((s) => s.whatIf ?? s.data);
export const activeData = () => { const s = useStore.getState(); return s.whatIf ?? s.data; };

// ---------- persistence ----------
let persistTimer: number | undefined;
let askedPersist = false;
function flush() {
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  const s = useStore.getState();
  void saveData(s.data);
  void saveWhatIf(s.whatIf);
  if (!askedPersist && (s.data.bills.length || s.data.debts.length || s.data.spendEntries.length)) {
    askedPersist = true;
    void requestPersistentStorage();
  }
}
function schedulePersist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(flush, 250);
}

// ---------- edits ----------
export interface UpdateOpts {
  /** Shows a toast with Undo, e.g. "Bill deleted". */
  undo?: string;
  /** Apply to the real data even while What-if mode is on. */
  real?: boolean;
}

export function update(recipe: (d: AppData) => void, opts: UpdateOpts = {}) {
  const s = useStore.getState();
  const target: 'data' | 'whatIf' = s.whatIf && !opts.real ? 'whatIf' : 'data';
  const next = structuredClone(s[target] as AppData);
  recipe(next);
  next.meta.updatedAt = new Date().toISOString();
  const patch: Partial<State> = { [target]: next } as Partial<State>;
  if (opts.undo) patch.undoSnap = { label: opts.undo, data: s.data, whatIf: s.whatIf };
  useStore.setState(patch);
  schedulePersist();
  if (opts.undo) toast(opts.undo, { action: { label: 'Undo', run: undo } });
}

export function undo() {
  const s = useStore.getState();
  if (!s.undoSnap) return;
  useStore.setState({ data: s.undoSnap.data, whatIf: s.undoSnap.whatIf, undoSnap: null });
  schedulePersist();
  toast('Undone.');
}

/** Replace everything (import, reset). Undo restores what was there before. */
export function replaceAll(next: AppData, label: string) {
  const s = useStore.getState();
  useStore.setState({ data: next, whatIf: null, undoSnap: { label, data: s.data, whatIf: s.whatIf } });
  flush();
  runDailyChores();
  toast(label, { action: { label: 'Undo', run: undo }, duration: 10000 });
}

// ---------- What-if ----------
export function startWhatIf() {
  const s = useStore.getState();
  if (s.whatIf) return;
  useStore.setState({ whatIf: structuredClone(s.data) });
  schedulePersist();
}
export function keepWhatIf() {
  const s = useStore.getState();
  if (!s.whatIf) return;
  useStore.setState({ data: s.whatIf, whatIf: null, undoSnap: { label: 'What-if changes kept', data: s.data, whatIf: s.whatIf } });
  schedulePersist();
  toast('Your What-if changes are saved.', { action: { label: 'Undo', run: undo } });
}
export function discardWhatIf() {
  const s = useStore.getState();
  if (!s.whatIf) return;
  useStore.setState({ whatIf: null });
  schedulePersist();
  toast('What-if changes discarded.');
}

// ---------- today, midnight, automatic loan payments ----------
function applyAutoPay(d: AppData, today: IsoDate): { data: AppData; count: number } {
  let count = 0;
  const debts = d.debts.map((debt) => {
    const r = catchUpAutoPay(debt, today);
    count += r.applied.length;
    return r.debt;
  });
  const changed = debts.some((x, i) => x !== d.debts[i]);
  return { data: changed ? { ...d, debts } : d, count };
}

export function runDailyChores() {
  const s = useStore.getState();
  const tz = s.data.prefs.timeZone || 'America/New_York';
  const today = todayIso(tz);
  const real = applyAutoPay(s.data, today);
  const sandbox = s.whatIf ? applyAutoPay(s.whatIf, today) : null;
  const patch: Partial<State> = {};
  if (today !== s.today) patch.today = today;
  if (real.data !== s.data) patch.data = real.data;
  if (sandbox && sandbox.data !== s.whatIf) patch.whatIf = sandbox.data;
  if (Object.keys(patch).length) {
    useStore.setState(patch);
    schedulePersist();
  }
  if (real.count) toast(`Applied ${real.count} scheduled loan payment${real.count === 1 ? '' : 's'}.`);
}

let midnightTimer: number | undefined;
function armMidnight() {
  window.clearTimeout(midnightTimer);
  const tz = useStore.getState().data.prefs.timeZone || 'America/New_York';
  midnightTimer = window.setTimeout(() => { runDailyChores(); armMidnight(); }, msUntilNextMidnight(tz));
}

export async function hydrate() {
  const today = todayIso(useStore.getState().data.prefs.timeZone);
  const { data, whatIf } = await loadAll(today);
  useStore.setState({ hydrated: true, data: data ?? useStore.getState().data, whatIf, today: todayIso(data?.prefs.timeZone || 'America/New_York') });
  runDailyChores();
  armMidnight();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else { runDailyChores(); armMidnight(); }
  });
  window.addEventListener('pagehide', flush);
}

/** Time-zone changes must re-check "today". */
export function setTimeZone(tz: string) {
  update((d) => { d.prefs.timeZone = tz; }, { real: true });
  runDailyChores();
  armMidnight();
}
