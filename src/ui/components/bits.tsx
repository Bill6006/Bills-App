import type { ReactNode } from 'react';
import { fmtMoney, fmtSigned, moneyParts } from '../../engine/money';
import { toDateObj } from '../../engine/dates';
import { IconAlert, IconCheckCircle, IconInfo } from '../icons';

/** Display money: engraved-style digits with the $ and cents set small in the UI face. */
export function Money({ value, size = 'md', cents = true, className = '', signed = false }: { value: number; size?: 'sm' | 'md' | 'lg' | 'hero'; cents?: boolean; className?: string; signed?: boolean }) {
  const { whole, cents: c, negative } = moneyParts(value);
  return (
    <span className={`money ${size === 'hero' ? '' : `m-${size}`} ${negative ? 'neg' : ''} ${className}`} aria-label={signed ? fmtSigned(value) : fmtMoney(value)}>
      <span aria-hidden="true">
        {negative ? <span className="sign">{'−'}</span> : signed && value > 0 ? <span className="sign">+</span> : null}
        <span className="cur">$</span>{whole}{cents && <span className="cents">.{c}</span>}
      </span>
    </span>
  );
}

/** Inline amount in the UI face: "−$1,450.00" / "+$1,158.74". */
export function Amount({ value, signed = false, tone, className = '' }: { value: number; signed?: boolean; tone?: 'pos' | 'bad' | 'warn' | 'auto'; className?: string }) {
  const t = tone === 'auto' ? (value > 0 ? 'pos' : '') : tone || '';
  return <span className={`amt ${t} ${className}`}>{signed ? fmtSigned(value) : fmtMoney(value)}</span>;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function DateBadge({ ms }: { ms: number }) {
  const d = toDateObj(ms);
  return <span className="datebadge" aria-hidden="true"><span className="dow">{DOW[d.dow]}</span><span className="dom">{d.d}</span></span>;
}

export function Chip({ tone, children }: { tone?: 'warn' | 'bad' | 'good' | 'brass' | 'bills'; children: ReactNode }) {
  return <span className={`chip ${tone || ''}`}>{children}</span>;
}

export function Meter({ pct, tone, label }: { pct: number; tone?: 'warn' | 'bad' | 'good' | 'bills'; label?: string }) {
  const w = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)} aria-label={label}>
      <i className={tone || ''} style={{ width: `${w}%` }} />
    </div>
  );
}

export function SplitBar({ parts }: { parts: Array<{ value: number; cls: string; label: string }> }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className="splitbar" role="img" aria-label={parts.map((p) => `${p.label} ${fmtMoney(p.value)}`).join(', ')}>
      {parts.filter((p) => p.value > 0).map((p) => <i key={p.label} className={p.cls} style={{ flex: total > 0 ? p.value / total : 1 }} />)}
    </div>
  );
}

export function Note({ tone = 'warn', children, action }: { tone?: 'warn' | 'ok' | 'bad' | 'info'; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'ok' ? IconCheckCircle : tone === 'info' ? IconInfo : IconAlert;
  return (
    <div className={`note ${tone === 'warn' ? '' : tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon />
      <div>{children}{action && <div className="note-action">{action}</div>}</div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<div className="t">{title}</div>{children && <div className="t-sm">{children}</div>}</div>;
}

export function SectionHead({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return <div className="section-head"><h2>{title}</h2>{action}</div>;
}
