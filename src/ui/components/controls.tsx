import { useEffect, useId, useState, type ReactNode } from 'react';
import { parseMoneyInput, round2 } from '../../engine/money';

export function Segmented<T extends string>({ value, options, onChange, size, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; size?: 'sm'; label: string }) {
  return (
    <div className={`seg ${size || ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span className="lbl">{label}</span>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Money input that accepts "$1,234.50"; reports NaN while empty or invalid. */
export function MoneyInput({ id, value, onChange, placeholder = '0.00', autoFocus, allowNegative }: { id?: string; value: number | null; onChange: (v: number) => void; placeholder?: string; autoFocus?: boolean; allowNegative?: boolean }) {
  const [text, setText] = useState(value == null || !Number.isFinite(value) ? '' : String(round2(value)));
  useEffect(() => {
    const parsed = parseMoneyInput(text);
    if (value != null && Number.isFinite(value) && (!Number.isFinite(parsed) || Math.abs(parsed - value) > 0.001)) setText(String(round2(value)));
    // Only react to outside changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="money-input">
      <span aria-hidden="true">$</span>
      <input id={id} className="input" inputMode="decimal" autoComplete="off" placeholder={placeholder} value={text} data-autofocus={autoFocus ? '' : undefined}
        onChange={(e) => {
          const t = allowNegative ? e.target.value.replace(/[^0-9.,$\-]/g, '') : e.target.value.replace(/[^0-9.,$]/g, '');
          setText(t);
          onChange(parseMoneyInput(t));
        }}
        onBlur={() => { const v = parseMoneyInput(text); if (Number.isFinite(v)) setText(v.toFixed(2)); }} />
    </div>
  );
}

export function TextInput({ id, value, onChange, placeholder, autoFocus, maxLength = 80 }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; maxLength?: number }) {
  return <input id={id} className="input" value={value} placeholder={placeholder} maxLength={maxLength} data-autofocus={autoFocus ? '' : undefined} onChange={(e) => onChange(e.target.value)} />;
}

export function NumberInput({ id, value, onChange, min, max }: { id?: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (Number(text) !== value) setText(String(value)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value]);
  return (
    <input id={id} className="input" inputMode="numeric" value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9]/g, '');
        setText(t);
        const n = Number(t);
        if (t && Number.isFinite(n)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
      }}
      onBlur={() => setText(String(value))} />
  );
}

export function DateInput({ id, value, onChange, min, max }: { id?: string; value: string; onChange: (v: string) => void; min?: string; max?: string }) {
  return <input id={id} className="input" type="date" value={value} min={min} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} />;
}

export function Select<T extends string | number>({ id, value, options, onChange }: { id?: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <select id={id} className="select" value={String(value)} onChange={(e) => {
      const o = options.find((x) => String(x.value) === e.target.value);
      if (o) onChange(o.value);
    }}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}
