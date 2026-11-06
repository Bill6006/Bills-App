import type { ReactNode } from 'react';
import { create } from 'zustand';

/**
 * Global sheet stack. Each open sheet pushes a history entry so the phone's back button
 * (or a back swipe) closes the sheet instead of leaving the screen.
 */
export interface SheetEntry { id: number; render: (close: () => void) => ReactNode; closing: boolean }

export const useSheets = create<{ stack: SheetEntry[] }>(() => ({ stack: [] }));

let seq = 0;
let ignorePops = 0;

function removeNow(id: number) {
  useSheets.setState((s) => ({ stack: s.stack.map((e) => (e.id === id ? { ...e, closing: true } : e)) }));
  window.setTimeout(() => useSheets.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) })), 230);
}

export function openSheet(render: (close: () => void) => ReactNode): () => void {
  const id = ++seq;
  try { window.history.pushState({ ...(window.history.state || {}), bpSheet: id }, ''); } catch { /* ignore */ }
  useSheets.setState((s) => ({ stack: [...s.stack, { id, render, closing: false }] }));
  return () => closeSheet(id);
}

export function closeSheet(id?: number) {
  const stack = useSheets.getState().stack.filter((e) => !e.closing);
  const target = id ?? stack[stack.length - 1]?.id;
  if (target == null || !stack.some((e) => e.id === target)) return;
  if (window.history.state?.bpSheet === target) {
    ignorePops++;
    window.history.back();
  }
  removeNow(target);
}

/** Close every sheet (e.g. before navigating to another screen). */
export function closeAllSheets() {
  const open = useSheets.getState().stack.filter((e) => !e.closing);
  for (let i = open.length - 1; i >= 0; i--) closeSheet(open[i].id);
}

window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  const stack = useSheets.getState().stack.filter((e) => !e.closing);
  const top = stack[stack.length - 1];
  if (top) removeNow(top.id);
});
