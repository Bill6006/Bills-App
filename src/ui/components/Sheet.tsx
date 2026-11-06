import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { closeSheet, useSheets } from '../../state/sheets';
import { IconClose } from '../icons';

const SheetCtx = createContext<{ id: number; closing: boolean }>({ id: 0, closing: false });

/** Renders every open sheet; place once at the app root. */
export function SheetHost() {
  const stack = useSheets((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <SheetCtx.Provider key={e.id} value={{ id: e.id, closing: e.closing }}>
          <div className={`scrim${e.closing ? ' closing' : ''}`} onClick={() => closeSheet(e.id)} />
          {e.render(() => closeSheet(e.id))}
        </SheetCtx.Provider>
      ))}
    </>
  );
}

export interface SheetProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  eyebrow?: ReactNode;
  headerAction?: ReactNode;
  label?: string;
}

/** A bottom sheet on phones and a centered dialog on wider screens. Swipe down on the header to close. */
export function Sheet({ title, onClose, children, footer, eyebrow, headerAction, label }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { closing } = useContext(SheetCtx);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const auto = el.querySelector<HTMLElement>('[data-autofocus]');
      (auto || el).focus({ preventScroll: true });
    }, 80);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
      if (e.key === 'Tab') {
        const items = Array.from(el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const a = items[0], b = items[items.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    el.addEventListener('keydown', onKey);
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(t);
      el.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  // Swipe down on the header to dismiss (phones only).
  useEffect(() => {
    const el = ref.current;
    const grab = el?.querySelector<HTMLElement>('.sheet-drag');
    if (!el || !grab) return;
    let startY = 0, dy = 0, active = false;
    const down = (e: PointerEvent) => {
      if (window.matchMedia('(min-width: 760px)').matches) return;
      if ((e.target as HTMLElement).closest('button')) return;
      active = true; startY = e.clientY; dy = 0;
      el.style.transition = 'none';
      grab.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!active) return;
      dy = Math.max(0, e.clientY - startY);
      el.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      if (!active) return;
      active = false;
      el.style.transition = 'transform 220ms cubic-bezier(.22,1,.36,1)';
      if (dy > 110) closeRef.current();
      else el.style.transform = '';
    };
    grab.addEventListener('pointerdown', down);
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', up);
    grab.addEventListener('pointercancel', up);
    return () => {
      grab.removeEventListener('pointerdown', down);
      grab.removeEventListener('pointermove', move);
      grab.removeEventListener('pointerup', up);
      grab.removeEventListener('pointercancel', up);
    };
  }, []);

  return (
    <div ref={ref} className={`sheet${closing ? ' closing' : ''}`} role="dialog" aria-modal="true"
      aria-label={label || (typeof title === 'string' ? title : undefined)} tabIndex={-1}>
      <div className="sheet-drag">
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <div className="grow">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2>{title}</h2>
          </div>
          {headerAction}
          <button type="button" className="icon-btn plain" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
      </div>
      <div className="sheet-body">{children}</div>
      {footer && <div className="sheet-foot">{footer}</div>}
    </div>
  );
}
