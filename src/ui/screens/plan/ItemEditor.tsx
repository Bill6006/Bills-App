import { useMemo, useState } from 'react';
import { addMonthsKey, fmtDow, isValidIso, parseISOToMs, toDateObj, type IsoDate } from '../../../engine/dates';
import { fmtMoney, round2 } from '../../../engine/money';
import { newId } from '../../../engine/loans';
import { describeRule, occurrencesForMonth } from '../../../engine/schedule';
import type { RecurringItem, Rule, RuleType, Settings } from '../../../engine/types';
import { openSheet } from '../../../state/sheets';
import { useActive, useStore } from '../../../state/store';
import { Sheet } from '../../components/Sheet';
import { Note } from '../../components/bits';
import { DateInput, Field, MoneyInput, NumberInput, TextInput } from '../../components/controls';
import { IconArrowDown, IconArrowUp, IconTrash } from '../../icons';

const TYPES: Array<{ value: RuleType; label: string }> = [
  { value: 'monthly_dom', label: 'Monthly' },
  { value: 'perpay', label: 'Every payday' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'weekly_dow', label: 'Weekly' },
  { value: 'annual_md', label: 'Yearly' },
  { value: 'one_time', label: 'Once' },
];
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Next few dates an item lands on. */
export function nextOccurrences(item: RecurringItem, settings: Settings, fromIso: IsoDate, count = 3): number[] {
  const out: number[] = [];
  const from = parseISOToMs(fromIso);
  let mk = fromIso.slice(0, 7);
  for (let g = 0; g < 26 && out.length < count; g++) {
    const occ = occurrencesForMonth(mk, [item], settings);
    for (const ms of [...occ.keys()].sort((a, b) => a - b)) if (ms >= from && out.length < count) out.push(ms);
    mk = addMonthsKey(mk, 1);
  }
  return out;
}

export function RulePicker({ rule, onChange, today }: { rule: Rule; onChange: (r: Rule) => void; today: IsoDate }) {
  const setType = (type: RuleType) => {
    if (type === rule.type) return;
    if (type === 'monthly_dom') onChange({ type, dom: rule.dom ?? (rule.anchor ? Number(rule.anchor.slice(8, 10)) : 1) });
    else if (type === 'weekly_dow') onChange({ type, dow: rule.dow ?? (rule.anchor ? toDateObj(parseISOToMs(rule.anchor)).dow : 5) });
    else if (type === 'perpay') onChange({ type });
    else onChange({ type, anchor: rule.anchor && isValidIso(rule.anchor) ? rule.anchor : today });
  };
  return (
    <div className="stack">
      <div className="chips" role="radiogroup" aria-label="Repeats">
        {TYPES.map((t) => <button key={t.value} type="button" role="radio" aria-checked={rule.type === t.value} className={`cp ${rule.type === t.value ? 'on' : ''}`} onClick={() => setType(t.value)}>{t.label}</button>)}
      </div>
      {rule.type === 'monthly_dom' && (
        <Field label="Day of the month" hint={(rule.dom ?? 1) >= 29 ? 'Short months use their last day.' : undefined}>
          {(id) => <NumberInput id={id} value={rule.dom ?? 1} min={1} max={31} onChange={(v) => onChange({ type: 'monthly_dom', dom: v })} />}
        </Field>
      )}
      {rule.type === 'weekly_dow' && (
        <div className="chips" role="radiogroup" aria-label="Day of the week">
          {DOWS.map((d, i) => <button key={d} type="button" role="radio" aria-checked={rule.dow === i} className={`cp ${rule.dow === i ? 'on' : ''}`} onClick={() => onChange({ type: 'weekly_dow', dow: i })}>{d}</button>)}
        </div>
      )}
      {(rule.type === 'biweekly' || rule.type === 'annual_md' || rule.type === 'one_time') && (
        <Field label={rule.type === 'biweekly' ? 'One of the dates' : rule.type === 'annual_md' ? 'Date (the year is ignored)' : 'Date'}
          hint={rule.type === 'biweekly' ? 'Repeats every 14 days from here, both ways.' : undefined}>
          {(id) => <DateInput id={id} value={rule.anchor || today} onChange={(v) => onChange({ type: rule.type, anchor: v })} />}
        </Field>
      )}
      {rule.type === 'perpay' && <p className="sub">Lands on every payday, so it repeats as often as you're paid.</p>}
    </div>
  );
}

export interface ItemEditorOpts {
  kind: 'bill' | 'budget' | 'income';
  item?: RecurringItem;
  /** Starting values for a new item (e.g. a bill made from a bank charge). */
  initial?: { name?: string; amount?: number; rule?: Rule };
  onSave: (item: RecurringItem) => void;
  onDelete?: (item: RecurringItem) => void;
  onMove?: (item: RecurringItem, dir: -1 | 1) => void;
}

const COPY = {
  bill: { new: 'New bill', edit: 'Edit bill', name: 'Bill name', placeholder: 'Rent, phone, insurance…', note: 'Paid from the Bills account.' },
  budget: { new: 'New spending budget', edit: 'Edit budget', name: 'Budget name', placeholder: 'Groceries, gas, eating out…', note: 'Comes out of your spending money, never the Bills account.' },
  income: { new: 'New extra income', edit: 'Edit extra income', name: 'Name', placeholder: 'Bonus, side gig, refund…', note: "Added to the paycheck of the pay period it lands in." },
} as const;

export function openItemEditor(opts: ItemEditorOpts) {
  openSheet((close) => <ItemEditor {...opts} onClose={close} />);
}

function ItemEditor({ kind, item, initial, onSave, onDelete, onMove, onClose }: ItemEditorOpts & { onClose: () => void }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const c = COPY[kind];
  const [name, setName] = useState(item?.name ?? initial?.name ?? '');
  const [amount, setAmount] = useState<number>(item ? item.amount : initial?.amount ?? NaN);
  const defaultRule: Rule = kind === 'budget' ? { type: 'perpay' } : kind === 'income' ? { type: 'one_time', anchor: today } : { type: 'monthly_dom', dom: Number(today.slice(8, 10)) };
  const [rule, setRule] = useState<Rule>(item?.rule ?? initial?.rule ?? defaultRule);
  const draft: RecurringItem = { id: item?.id ?? newId(kind === 'bill' ? 'b' : kind === 'budget' ? 'x' : 'oi'), name: name.trim() || (kind === 'bill' ? 'Bill' : kind === 'budget' ? 'Budget' : 'Extra income'), amount: round2(amount), rule, ...(item?._extraMonth ? { _extraMonth: item._extraMonth } : {}) };
  const next = useMemo(() => (Number.isFinite(amount) ? nextOccurrences(draft, data.settings, today, 3) : []), [rule, data.settings, today, amount]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = name.trim().length > 0 && Number.isFinite(amount) && amount >= 0 && (rule.type === 'perpay' || rule.type === 'monthly_dom' || rule.type === 'weekly_dow' || isValidIso(rule.anchor || ''));
  return (
    <Sheet title={item ? c.edit : c.new} onClose={onClose}
      footer={<>
        {item && onDelete && <button type="button" className="btn danger" style={{ flex: '0 0 auto' }} aria-label="Delete" onClick={() => { onDelete(item); onClose(); }}><IconTrash /></button>}
        <button type="button" className="btn" disabled={!valid} onClick={() => { onSave(draft); onClose(); }}>{item ? 'Save' : 'Add'}</button>
      </>}>
      <div className="fields">
        <Field label={c.name}>{(id) => <TextInput id={id} value={name} onChange={setName} placeholder={c.placeholder} autoFocus={!item} />}</Field>
        <Field label="Amount">{(id) => <MoneyInput id={id} value={Number.isFinite(amount) ? amount : null} onChange={setAmount} />}</Field>
      </div>
      <div className="field"><span className="lbl">Repeats</span><RulePicker rule={rule} onChange={setRule} today={today} /></div>
      <Note tone="info">
        {describeRule(rule)}. {c.note}
        {next.length > 0 && <><br />Next: {next.map((ms) => fmtDow(ms)).join(' · ')}</>}
        {next.length === 0 && Number.isFinite(amount) && <><br />No upcoming dates.</>}
      </Note>
      {item && onMove && (
        <div className="btn-row">
          <button type="button" className="btn ghost sm" onClick={() => onMove(item, -1)}><IconArrowUp />Move up</button>
          <button type="button" className="btn ghost sm" onClick={() => onMove(item, 1)}><IconArrowDown />Move down</button>
        </div>
      )}
      {kind === 'budget' && Number.isFinite(amount) && rule.type === 'perpay' && <p className="sub">{fmtMoney(amount)} from every paycheck.</p>}
    </Sheet>
  );
}
