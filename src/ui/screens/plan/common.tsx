import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../../../app/router';
import { fmtShort, parseISOToMs, type IsoDate } from '../../../engine/dates';
import { IconChevronLeft, IconGrip } from '../../icons';

/** Header for a Plan sub-page: "‹ Plan" back link above the title. */
export function PlanHeader({ title, action, back = '/plan', backLabel = 'Plan' }: { title: string; action?: ReactNode; back?: string; backLabel?: string }) {
  return (
    <header className="page-head">
      <div className="titles">
        <button type="button" className="link-btn back" onClick={() => navigate(back)}><IconChevronLeft />{backLabel}</button>
        <h1 className="page-title">{title}</h1>
      </div>
      {action && <div className="page-actions">{action}</div>}
    </header>
  );
}

/**
 * Opens a sheet once when the page is reached through a deep link such as /plan/bills/new,
 * after swapping the address back to the list so the back button closes the sheet and stays on the page.
 */
export function useOpenOnRoute(when: boolean, listPath: string, open: () => void) {
  const done = useRef(false);
  useEffect(() => {
    if (!when || done.current) return;
    done.current = true;
    navigate(listPath, { replace: true });
    // Not cancelled on re-render: swapping the address re-renders this page without the deep link.
    window.setTimeout(open, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [when]);
}

interface DragState { id: string; from: number; to: number; dy: number; heights: number[] }

/**
 * A list you can reorder by dragging the grip on each row (touch or mouse). Rows render through `row`;
 * `onMove(from, to)` gets the final positions.
 */
export function ReorderList<T>({ items, idOf, row, onMove, enabled = true, label }: {
  items: T[]; idOf: (t: T) => string; row: (t: T, handle: ReactNode) => ReactNode; onMove: (from: number, to: number) => void; enabled?: boolean; label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  const begin = (e: React.PointerEvent, id: string) => {
    if (!enabled || !listRef.current) return;
    e.preventDefault();
    const rows = Array.from(listRef.current.children) as HTMLElement[];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const from = items.findIndex((x) => idOf(x) === id);
    if (from < 0) return;
    const y0 = e.clientY;
    const centers = rects.map((r) => r.top + r.height / 2);
    const st: DragState = { id, from, to: from, dy: 0, heights: rects.map((r) => r.height) };
    dragRef.current = st;
    setDrag(st);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      const c = centers[from] + dy;
      let to = from;
      for (let i = 0; i < from; i++) if (c < centers[i]) { to = i; break; }
      for (let i = centers.length - 1; i > from; i--) if (c > centers[i]) { to = i; break; }
      const next = { ...st, dy, to };
      dragRef.current = next;
      setDrag(next);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d && d.to !== d.from) moveRef.current(d.from, d.to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const shiftFor = (i: number): number => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dy;
    const h = drag.heights[drag.from];
    if (drag.to > drag.from && i > drag.from && i <= drag.to) return -h;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return h;
    return 0;
  };

  return (
    <div className="list" ref={listRef} aria-label={label}>
      {items.map((t, i) => {
        const id = idOf(t);
        const handle = enabled ? (
          <span className="drag-handle" role="button" tabIndex={-1} aria-label="Drag to reorder" onPointerDown={(e) => begin(e, id)} onClick={(e) => e.stopPropagation()}>
            <IconGrip />
          </span>
        ) : null;
        const dy = shiftFor(i);
        return (
          <div key={id} className={`reorder-item${drag?.id === id ? ' dragging' : ''}`}
            style={dy ? { transform: `translateY(${dy}px)`, transition: drag?.id === id ? 'none' : undefined } : undefined}>
            {row(t, handle)}
          </div>
        );
      })}
    </div>
  );
}

/** Move an id within an order list (keeps ids that aren't shown where they are). */
export function moveInOrder(order: string[], visibleIds: string[], from: number, to: number): string[] {
  const ids = visibleIds.slice();
  const [m] = ids.splice(from, 1);
  ids.splice(to, 0, m);
  const rest = order.filter((id) => !visibleIds.includes(id));
  return [...ids, ...rest];
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** "today", "tomorrow" or "next Nov 13" for an item's next date. */
export function nextLabel(ms: number | undefined, today: IsoDate): string {
  if (ms == null) return 'no upcoming date';
  const days = Math.round((ms - parseISOToMs(today)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `next ${fmtShort(ms)}`;
}
