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
