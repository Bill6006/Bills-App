import { useMemo, useState } from 'react';
import { fmtDow, fmtRange, fmtShort, parseISOToMs, type IsoDate } from '../../engine/dates';
import { fmtMoney, round2 } from '../../engine/money';
import { newId } from '../../engine/loans';
import { periodForDate, snapshotForRange } from '../../engine/spending';
import { MISC_ID, type SpendEntry, type SpendTransfer } from '../../engine/types';
import { openSheet } from '../../state/sheets';
import { update, useActive, useStore } from '../../state/store';
import { useEngine } from '../../state/useEngine';
import { availableOn, budgetOptions, displayName, isArchived, meterTone, rangeEntries, rangeTransfers } from '../../state/spendingModels';
import { Sheet } from '../components/Sheet';
import { Amount, Meter, Money, Note } from '../components/bits';
import { DateInput, Field, MoneyInput, Segmented, TextInput } from '../components/controls';
import { IconMove, IconPlus, IconTrash } from '../icons';
import { quickActions } from './quickActions';

// ---------- Log / edit spending ----------
export function openLogSpend(opts: { entryId?: string; categoryId?: string; date?: IsoDate } = {}) {
  openSheet((close) => <LogSpendSheet {...opts} onClose={close} />);
}

function LogSpendSheet({ entryId, categoryId, date, onClose }: { entryId?: string; categoryId?: string; date?: IsoDate; onClose: () => void }) {
  const data = useActive();
  const engine = useEngine();
  const today = useStore((s) => s.today);
  const existing = entryId ? data.spendEntries.find((e) => e.id === entryId) : undefined;
  const options = budgetOptions(data, existing?.extraId);
  const initialCat = existing?.extraId ?? categoryId ?? options.find((o) => o.id === data.prefs.lastSpendCategory)?.id ?? options[0]?.id ?? MISC_ID;
  const [amount, setAmount] = useState<number>(existing ? Math.abs(existing.amount) : NaN);
  const [type, setType] = useState<'spend' | 'refund'>(existing?.entryType ?? 'spend');
  const [cat, setCat] = useState(initialCat);
  const [day, setDay] = useState<IsoDate>(existing?.date ?? date ?? today);
  const [note, setNote] = useState(existing?.note ?? '');

  const preview = useMemo(() => {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const p = periodForDate(engine, day);
    const snap = snapshotForRange(engine, p.startMs, p.endMs);
    const row = snap.items.find((r) => r.id === cat);
    let left = row ? row.remaining : 0;
    if (existing && existing.extraId === cat && existing.date >= p.startIso && existing.date <= p.endIso) left = round2(left + existing.amount);
    const signed = type === 'refund' ? -amount : amount;
    return { left: round2(left - signed), until: fmtShort(p.endMs + 86400000) };
  }, [engine, amount, type, cat, day, existing]);

  const name = options.find((o) => o.id === cat)?.name || 'Budget';
  const valid = Number.isFinite(amount) && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const save = () => {
    if (!valid) return;
    const signed = type === 'refund' ? -round2(amount) : round2(amount);
    const entry: SpendEntry = {
      ...(existing ?? {}),
      id: existing?.id ?? newId('xs'), extraId: cat, extraName: cat === MISC_ID ? 'Misc' : name, amount: signed, entryType: type,
      date: day, note: note.trim(), createdAt: existing?.createdAt || new Date().toISOString(),
    };
    update((d) => {
      if (existing) d.spendEntries = d.spendEntries.map((e) => (e.id === existing.id ? entry : e));
      else d.spendEntries.push(entry);
      d.prefs.lastSpendCategory = cat;
    }, { undo: existing ? 'Spending updated.' : `Logged ${fmtMoney(amount)}${type === 'refund' ? ' refund' : ''} in ${cat === MISC_ID ? 'Unassigned' : name}.` });
    onClose();
  };
  const remove = () => {
    if (!existing) return;
    update((d) => {
      d.spendEntries = d.spendEntries.filter((e) => e.id !== existing.id);
      // An imported purchase you delete stays out of future imports.
      const t = existing.bankTxnId ? d.bank.txns.find((x) => x.id === existing.bankTxnId) : undefined;
      if (t) {
        t.entryIds = t.entryIds.filter((id) => id !== existing.id);
        if (!t.entryIds.length) { t.status = 'skipped'; t.how = 'you'; }
      }
    }, { undo: 'Spending log deleted.' });
    onClose();
  };

  return (
    <Sheet title={existing ? 'Edit spending' : 'Log spending'} onClose={onClose}
      headerAction={<Segmented size="sm" label="Spend or refund" value={type} onChange={setType} options={[{ value: 'spend', label: 'Spend' }, { value: 'refund', label: 'Refund' }]} />}
      footer={<>
        {existing && <button type="button" className="btn danger" style={{ flex: '0 0 auto' }} onClick={remove} aria-label="Delete this log"><IconTrash /></button>}
        <button type="button" className="btn" disabled={!valid} onClick={save}>{existing ? 'Save' : `Log ${Number.isFinite(amount) && amount > 0 ? fmtMoney(amount) : ''}`.trim()}</button>
      </>}>
      <div className="big-amount">
        <MoneyInput value={Number.isFinite(amount) ? amount : null} onChange={setAmount} autoFocus={!existing} />
      </div>
      <div className="chips" role="radiogroup" aria-label="Budget">
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={cat === o.id} className={`cp ${cat === o.id ? 'on' : ''}`} onClick={() => setCat(o.id)}>{o.name}{o.archived ? ' (archived)' : ''}</button>
        ))}
      </div>
      <div className="fields two">
        <Field label="Date">{(id) => <DateInput id={id} value={day} onChange={setDay} />}</Field>
        <Field label="Note">{(id) => <TextInput id={id} value={note} onChange={setNote} placeholder="Store or note" />}</Field>
      </div>
      {existing?.bankTxnId && (() => {
        const t = data.bank.txns.find((x) => x.id === existing.bankTxnId);
        return t ? <p className="sub">From your bank: {t.description}{t.entryIds.length > 1 ? ` (split, ${fmtMoney(Math.abs(t.amount))} total)` : ''}. Changing the budget teaches the app for next time.</p> : null;
      })()}
      {preview && (
        <Note tone={preview.left < 0 ? 'bad' : 'ok'}>
          {cat === MISC_ID ? 'Unassigned' : name} will have {preview.left < 0 ? `${fmtMoney(-preview.left)} over budget` : `${fmtMoney(preview.left)} left`} until {preview.until}.
        </Note>
      )}
    </Sheet>
  );
}

// ---------- Move money between budgets ----------
export function openMoveMoney(opts: { fromId?: string; toId?: string; date?: IsoDate } = {}) {
  openSheet((close) => <MoveMoneySheet {...opts} onClose={close} />);
}

function MoveMoneySheet({ fromId, toId, date, onClose }: { fromId?: string; toId?: string; date?: IsoDate; onClose: () => void }) {
  const data = useActive();
  const engine = useEngine();
  const today = useStore((s) => s.today);
  const day = date ?? today;
  const avail = useMemo(() => availableOn(engine, day), [engine, day]);
  const p = useMemo(() => periodForDate(engine, day), [engine, day]);
  const options = budgetOptions(data).filter((o) => !o.archived);
  const fromChoices = options.filter((o) => (avail.get(o.id) ?? 0) > 0.004);
  const [from, setFrom] = useState(fromId && fromChoices.some((o) => o.id === fromId) ? fromId : (fromChoices.find((o) => o.id === MISC_ID)?.id ?? fromChoices[0]?.id ?? ''));
  const [to, setTo] = useState(toId ?? options.find((o) => o.id !== from && o.id !== MISC_ID)?.id ?? '');
  const [amount, setAmount] = useState<number>(NaN);
  const available = round2(avail.get(from) ?? 0);
  const valid = from && to && from !== to && Number.isFinite(amount) && amount > 0 && amount <= available + 0.0001;
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? 'Budget';

  const save = () => {
    if (!valid) return;
    const t: SpendTransfer = {
      id: newId('xst'), fromExtraId: from, fromExtraName: from === MISC_ID ? 'Misc' : nameOf(from), toExtraId: to, toExtraName: to === MISC_ID ? 'Misc' : nameOf(to),
      amount: round2(amount), date: day, note: '', createdAt: new Date().toISOString(),
    };
    update((d) => { d.spendTransfers.push(t); }, { undo: `Moved ${fmtMoney(amount)} to ${nameOf(to)}.` });
    onClose();
  };

  return (
    <Sheet title="Move money" eyebrow={fmtRange(p.startMs, p.endMs)} onClose={onClose}
      footer={<button type="button" className="btn" disabled={!valid} onClick={save}><IconMove />Move {Number.isFinite(amount) && amount > 0 ? fmtMoney(amount) : ''}</button>}>
      {!fromChoices.length ? <Note tone="info">No budget has money left to move in this pay period.</Note> : (
        <>
          <div className="field"><span className="lbl">From</span>
            <div className="chips" role="radiogroup" aria-label="Move from">
              {fromChoices.map((o) => (
                <button key={o.id} type="button" role="radio" aria-checked={from === o.id} className={`cp ${from === o.id ? 'on' : ''}`} onClick={() => { setFrom(o.id); if (to === o.id) setTo(''); }}>
                  {o.name} <span className="faint">{fmtMoney(avail.get(o.id) ?? 0)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field"><span className="lbl">To</span>
            <div className="chips" role="radiogroup" aria-label="Move to">
              {options.filter((o) => o.id !== from).map((o) => (
                <button key={o.id} type="button" role="radio" aria-checked={to === o.id} className={`cp ${to === o.id ? 'on' : ''}`} onClick={() => setTo(o.id)}>{o.name}</button>
              ))}
            </div>
          </div>
          <Field label="Amount" hint={`Up to ${fmtMoney(available)} available in ${nameOf(from)}`}>{(id) => <MoneyInput id={id} value={Number.isFinite(amount) ? amount : null} onChange={setAmount} />}</Field>
          {Number.isFinite(amount) && amount > available + 0.0001 && <Note tone="bad">Only {fmtMoney(available)} is available in {nameOf(from)}.</Note>}
          <p className="sub">Moves only apply to this pay period. Next pay period starts fresh from your budgets.</p>
        </>
      )}
    </Sheet>
  );
}

// ---------- One budget in a range ----------
export function openBudgetDetail(opts: { id: string; startMs: number; endMs: number; title: string }) {
  openSheet((close) => <BudgetDetailSheet {...opts} onClose={close} />);
}

function BudgetDetailSheet({ id, startMs, endMs, title, onClose }: { id: string; startMs: number; endMs: number; title: string; onClose: () => void }) {
  const data = useActive();
  const engine = useEngine();
  const today = useStore((s) => s.today);
  const snap = snapshotForRange(engine, startMs, endMs);
  const row = snap.items.find((r) => r.id === id);
  const logs = rangeEntries(data, startMs, endMs).filter((e) => e.extraId === id);
  const moves = rangeTransfers(data, startMs, endMs).filter((t) => t.fromExtraId === id || t.toExtraId === id);
  const name = displayName(data, id, logs[0]?.extraName);
  const inRange = parseISOToMs(today) >= startMs && parseISOToMs(today) <= endMs;
  const moveDate = inRange ? today : new Date(startMs).toISOString().slice(0, 10);
  const deleteMove = (t: SpendTransfer) => update((d) => { d.spendTransfers = d.spendTransfers.filter((x) => x.id !== t.id); }, { undo: 'Budget move deleted.' });
  return (
    <Sheet title={name} eyebrow={title} onClose={onClose}
      footer={isArchived(data, id) ? undefined : <>
        <button type="button" className="btn ghost" onClick={() => openMoveMoney({ toId: id, date: moveDate })}><IconMove />Move here</button>
        <button type="button" className="btn" onClick={() => openLogSpend({ categoryId: id, date: inRange ? today : moveDate })}><IconPlus />Log</button>
      </>}>
      {row && (
        <div className="card">
          <div className="card-head end"><Money value={row.remaining} size="md" /><span className="sub right">left of {fmtMoney(row.budget)}</span></div>
          <Meter pct={row.budget > 0 ? (Math.max(0, row.spent) / row.budget) * 100 : row.spent > 0 ? 100 : 0} tone={meterTone(row)} />
          <dl className="kv">
            <dt>Budgeted</dt><dd>{fmtMoney(row.budget)}</dd>
            <dt>Spent</dt><dd>{fmtMoney(row.spent)}</dd>
            {row.transferIn > 0 && <><dt>Moved in</dt><dd className="pos">+{fmtMoney(row.transferIn)}</dd></>}
            {row.transferOut > 0 && <><dt>Moved out</dt><dd>{'−'}{fmtMoney(row.transferOut)}</dd></>}
          </dl>
        </div>
      )}
      {id === MISC_ID && <p className="sub">Unassigned is the spending money left after your budgets. It changes when your paycheck or budgets do.</p>}
      {isArchived(data, id) && <p className="sub">This budget was deleted. Its old logs are kept so your history adds up.</p>}
      <div className="card flush">
        <div className="pad lbl">Logged</div>
        {logs.length ? <div className="list">{logs.map((e) => <LogRow key={e.id} e={e} showBudget={false} />)}</div> : <p className="sub pad">Nothing logged here.</p>}
      </div>
      {moves.length > 0 && (
        <div className="card flush">
          <div className="pad lbl">Budget moves</div>
          <div className="list">{moves.map((t) => (
            <div key={t.id} className="row no-lead">
              <span className="main-col"><span className="title">{displayName(data, t.fromExtraId, t.fromExtraName)} → {displayName(data, t.toExtraId, t.toExtraName)}</span><span className="sub">{fmtDow(parseISOToMs(t.date))}</span></span>
              <span className="trail" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Amount value={t.amount} /><button type="button" className="icon-btn plain" aria-label="Delete this move" onClick={() => deleteMove(t)}><IconTrash /></button></span>
            </div>
          ))}</div>
        </div>
      )}
    </Sheet>
  );
}

export function LogRow({ e, showBudget = true }: { e: SpendEntry; showBudget?: boolean }) {
  const data = useActive();
  const ms = parseISOToMs(e.date);
  return (
    <button type="button" className="row" onClick={() => openLogSpend({ entryId: e.id })}>
      <span className="datebadge" aria-hidden="true"><span className="dow">{fmtDow(ms).slice(0, 3)}</span><span className="dom">{new Date(ms).getUTCDate()}</span></span>
      <span className="main-col">
        <span className="title">{e.note || (showBudget ? displayName(data, e.extraId, e.extraName) : e.entryType === 'refund' ? 'Refund' : 'Spent')}</span>
        {showBudget && <span className="sub">{displayName(data, e.extraId, e.extraName)}{isArchived(data, e.extraId) ? ' · archived' : ''}</span>}
      </span>
      <span className="trail"><Amount value={-e.amount} signed tone={e.amount < 0 ? 'pos' : undefined} />{e.entryType === 'refund' && <span className="sub">Refund</span>}</span>
    </button>
  );
}

quickActions.logSpend = () => openLogSpend({});
quickActions.moveMoney = () => openMoveMoney({});
