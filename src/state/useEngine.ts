import { useMemo } from 'react';
import { PlanEngine } from '../engine/plan';
import { ALL_FIXES } from '../engine/types';
import { useActive, useStore } from './store';

/** A cached engine for the data on screen (the What-if copy when that mode is on). */
export function useEngine(): PlanEngine {
  const data = useActive();
  const today = useStore((s) => s.today);
  return useMemo(() => new PlanEngine(data, { today, fixes: ALL_FIXES }), [data, today]);
}

/** The engine for your real data while What-if mode is on (null otherwise), for side-by-side numbers. */
export function useRealEngine(): PlanEngine | null {
  const on = useStore((s) => !!s.whatIf);
  const data = useStore((s) => s.data);
  const today = useStore((s) => s.today);
  return useMemo(() => (on ? new PlanEngine(data, { today, fixes: ALL_FIXES }) : null), [on, data, today]);
}
