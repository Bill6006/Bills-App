import { create } from 'zustand';

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; text: string; action?: ToastAction; duration: number }

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

let seq = 0;

/** Show a short message; pass duration 0 to keep it until dismissed or its action runs. */
export function toast(text: string, opts: { action?: ToastAction; duration?: number } = {}): number {
  const id = ++seq;
  const t: Toast = { id, text, action: opts.action, duration: opts.duration ?? (opts.action ? 6000 : 3200) };
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), t] }));
  if (t.duration > 0) window.setTimeout(() => dismissToast(id), t.duration);
  return id;
}

export function dismissToast(id: number) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
