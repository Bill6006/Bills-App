import { useState } from 'react';
import { addDaysMs, addMonthsKey, fmtDow, fmtShort, isoDate, isValidIso, parseISOToMs, type IsoDate } from '../../engine/dates';
import { getPaydaysForMonth, movePayday, paydayMoveTo } from '../../engine/schedule';
import { openSheet } from '../../state/sheets';
import { update, useActive, useStore } from '../../state/store';
import { Sheet } from '../components/Sheet';
import { Note } from '../components/bits';
import { DateInput, Field } from '../components/controls';

/** Move the payday shown on `ms` (its usual day is looked up) to `toIso`, with Undo. */
export function movePaydayTo(ms: number, toIso: IsoDate) {
  const s = useStore.getState();
  const data = s.whatIf ?? s.data;
  const iso = isoDate(ms);
  const usual = paydayMoveTo(iso, data.settings)?.from ?? iso;
  const back = toIso === usual;
  update((d) => { movePayday(d.settings, usual, toIso); }, {
    undo: back ? `Payday back on its usual day, ${fmtDow(parseISOToMs(usual))}` : `This payday now counts on ${fmtDow(parseISOToMs(toIso))}`,
  });
}

export function openMovePayday(ms: number) {
  openSheet((close) => <MovePaydaySheet ms={ms} onClose={close} />);
}

/** Why a date can't take this payday, or '' when it can: it must stay between the paydays around it. */
function problem(data: ReturnType<typeof useActive>, ms: number, usual: string, to: string): string {
  if (!isValidIso(to)) return 'Pick a date.';
  const toMs = parseISOToMs(to);
  if (Math.abs(toMs - parseISOToMs(usual)) > 10 * 86400000) return 'Pick a day within 10 days of the usual payday.';
  const mk = usual.slice(0, 7);
  const others: number[] = [];
  for (let i = -1; i <= 1; i++) others.push(...getPaydaysForMonth(addMonthsKey(mk, i), data.settings).filter((p) => p !== ms));
  const prev = others.filter((p) => p < ms).pop();
  const next = others.find((p) => p > ms);
  if (prev != null && toMs <= prev) return `That's on or before your ${fmtShort(prev)} payday.`;
  if (next != null && toMs >= next) return `That's on or after your ${fmtShort(next)} payday.`;
  return '';
}

/** The controls for one payday: pick the day the money came, or put it back on its usual day. */
export function MovePaydayForm({ ms, onDone }: { ms: number; onDone?: () => void }) {
  const data = useActive();
  const iso = isoDate(ms);
  const move = paydayMoveTo(iso, data.settings);
  const usual = move?.from ?? iso;
  const [to, setTo] = useState<IsoDate>(move ? move.to : isoDate(addDaysMs(parseISOToMs(usual), -1)));
  const err = problem(data, ms, usual, to);
  const go = (target: IsoDate) => { movePaydayTo(ms, target); onDone?.(); };
  return (
    <div className="stack">
      {move
        ? <Note tone="info">This paycheck came on {fmtDow(ms)} instead of its usual {fmtDow(parseISOToMs(usual))}, so its pay period, budgets and moves start that day.</Note>
        : <p className="sub body">Got paid early or late this time? Pick the day the money came. Its pay period, per-paycheck budgets and the Bills and Savings moves start that day. Only this paycheck changes; your usual schedule stays.</p>}
      <Field label="The money came on">{(id) => <DateInput id={id} value={to} onChange={setTo} />}</Field>
      {err && to !== usual && <p className="sub danger-t">{err}</p>}
      <div className="btn-row wrap">
        <button type="button" className="btn sm" disabled={!!err || to === (move ? move.to : usual)} onClick={() => go(to)}>
          {to === usual ? `Back to ${fmtShort(parseISOToMs(usual))}` : `Count it on ${fmtShort(parseISOToMs(to))}`}
        </button>
        {move && to !== usual && <button type="button" className="btn sm ghost" onClick={() => go(usual)}>Back to usual ({fmtShort(parseISOToMs(usual))})</button>}
      </div>
    </div>
  );
}

function MovePaydaySheet({ ms, onClose }: { ms: number; onClose: () => void }) {
  return (
    <Sheet title="Paid on a different day?" eyebrow={`Payday · ${fmtDow(ms)}`} onClose={onClose}>
      <MovePaydayForm ms={ms} onDone={onClose} />
    </Sheet>
  );
}
