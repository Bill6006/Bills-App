import { useMemo } from 'react';
import type { IsoDate } from '../engine/dates';
import { PlanEngine } from '../engine/plan';
import { ALL_FIXES, type AppData } from '../engine/types';
import { useActive, useStore } from './store';

/** The one place the app's engine options live (all fixes on). */
export const makeEngine = (data: AppData, today: IsoDate) => new PlanEngine(data, { today, fixes: ALL_FIXES });

/** A cached engine for the data on screen (the What-if copy when that mode is on). */
export function useEngine(): PlanEngine {
  const data = useActive();
  const today = useStore((s) => s.today);
  return useMemo(() => makeEngine(data, today), [data, today]);
}

/** The engine for your real data while What-if mode is on (null otherwise), for side-by-side numbers. */
export function useRealEngine(): PlanEngine | null {
  const on = useStore((s) => !!s.whatIf);
  const data = useStore((s) => s.data);
  const today = useStore((s) => s.today);
  return useMemo(() => (on ? makeEngine(data, today) : null), [on, data, today]);
}
