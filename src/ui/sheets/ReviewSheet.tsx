import { useMemo, useState } from 'react';
import { fmtDow, fmtShort, parseISOToMs } from '../../engine/dates';
import { fmtMoney, round2 } from '../../engine/money';
import { billChoices, fileTxn, linkedBill, linkTxn, markAsBill, reviewAgain, reviewTxns, skipTxn } from '../../engine/bank/importer';
import { buildModel, predict, type Model } from '../../engine/bank/learn';
import { describeMerchant } from '../../engine/bank/merchant';
import { MISC_ID, type BankTxn, type RecurringItem } from '../../engine/types';
import { openSheet } from '../../state/sheets';
import { update, useActive, useStore } from '../../state/store';
import { budgetOptions, displayName, type BudgetOption } from '../../state/spendingModels';
import { Sheet } from '../components/Sheet';
import { Amount, Note } from '../components/bits';
import { MoneyInput, Select } from '../components/controls';
import { IconCheckCircle, IconChevronDown, IconClose, IconPlus, IconReceipt } from '../icons';
import { openItemEditor } from '../screens/plan/ItemEditor';
import { skipReason } from './bankText';
import { quickActions } from './quickActions';

export function openReview() {
  openSheet((close) => <ReviewSheet onClose={close} />);
}

function ReviewSheet({ onClose }: { onClose: () => void }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const items = reviewTxns(data);
  // Rebuilt as you file, so after one purchase from a store the others from it suggest the same budget first.
  const model = useMemo(() => buildModel(data, today), [data, today]);
  const last = data.bank.lastImportAt;
  const skipped = data.bank.txns.filter((t) => t.status === 'skipped' && t.importedAt === last).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Sheet title="To review" eyebrow={items.length ? `${items.length} purchase${items.length === 1 ? '' : 's'} need a budget` : 'Bank import'} onClose={onClose}>
      {items.length ? (
        <>
          <p className="sub">Pick a budget for each one. The app remembers your choice for that store and the amount, so it asks less over time.</p>
          {items.map((t) => <ReviewItem key={t.id} t={t} model={model} />)}
        </>
      ) : (
        <div className="empty"><IconCheckCircle /><div className="t">All caught up</div><div className="t-sm">Every imported purchase has a budget. You can still change one from Spending › History.</div></div>
      )}
      {skipped.length > 0 && (
        <details className="disclosure card flush">
          <summary className="pad"><span className="lbl">Not spending in your last import ({skipped.length})</span><IconChevronDown /></summary>
          <div className="list">
            {skipped.map((t) => (
              <div key={t.id} className="row no-lead">
                <span className="main-col"><span className="title">{t.merchant}</span><span className="sub">{fmtShort(parseISOToMs(t.date))} · {fmtMoney(Math.abs(t.amount))}{t.amount > 0 ? ' in' : ''} · {skipReason(t.how)}</span></span>
                <span className="trail"><button type="button" className="btn ghost sm" onClick={() => update((d) => reviewAgain(d, t.id), { undo: `${t.merchant} moved to review` })}>It's spending</button></span>
              </div>
            ))}
          </div>
        </details>
      )}
    </Sheet>
  );
}

const kindOfTxn = (t: BankTxn) => t.kind ?? describeMerchant(t.merchant).kind;

function whyText(t: BankTxn, s: Array<{ extraId: string; p: number }>, names: (id: string) => string): string {
  const kind = kindOfTxn(t);
  if (kind === 'fee') return 'A fee from your bank, so the app always asks.';
  if (!s.length) return kind === 'atm' ? 'Cash from an ATM: where does it usually go?' : kind === 'p2p' ? 'A payment to a person, so the app always asks.' : 'First time at this store.';
  if (kind === 'gas' && s.length > 1 && s[1].p >= 0.2) return `At gas stations you've filed amounts like this under ${names(s[0].extraId)} and ${names(s[1].extraId)}.`;
  if (s.length > 1 && s[1].p >= 0.2) return `Usually ${names(s[0].extraId)}, sometimes ${names(s[1].extraId)}.`;
  return `Probably ${names(s[0].extraId)}.`;
}

function ReviewItem({ t, model }: { t: BankTxn; model: Model }) {
  const data = useActive();
  const [mode, setMode] = useState<'pick' | 'more' | 'split' | 'skip' | 'bill' | 'billAmount'>('pick');
  const [pending, setPending] = useState<RecurringItem | null>(null);
  const opts = budgetOptions(data).filter((o) => !o.archived);
  const names = (id: string) => displayName(data, id);
  const amount = round2(Math.abs(t.amount));
  const live = predict(model, { key: t.merchantKey, kind: kindOfTxn(t) }, amount, t.bankCategory).suggestions;
  const guesses = live.length ? live : t.suggest || [];
  const suggested = guesses.map((s) => s.extraId).filter((id) => opts.some((o) => o.id === id)).slice(0, 2);
  const refund = t.amount > 0;
  const maybe = t.maybeSameAs ? data.spendEntries.find((e) => e.id === t.maybeSameAs) : undefined;
  const now = () => new Date().toISOString();
  const when = fmtShort(parseISOToMs(t.date));
  const file = (extraId: string) => update((d) => { fileTxn(d, t.id, [{ extraId, amount }], now()); }, { undo: `${t.merchant} (${when}) filed in ${names(extraId)}` });
  const guessBill = (t.billGuess ? data.bills.find((b) => b.id === t.billGuess!.id) : undefined) ?? (refund ? undefined : linkedBill(data, t));
  const sameAsPlan = !!guessBill && Math.abs(Number(guessBill.amount) - amount) <= Math.max(0.5, amount * 0.02);
  const linkBill = (b: RecurringItem, updateAmount: boolean) => {
    const what = t.merchant.toLowerCase() === b.name.toLowerCase() ? `${b.name} (${when})` : `${t.merchant} (${when})`;
    update((d) => { markAsBill(d, t.id, b.id, { updateAmount }); },
      { undo: updateAmount ? `${what} marked as your ${b.name} bill, now ${fmtMoney(amount)}` : `${what} marked as your ${b.name} bill` });
  };
  const chooseBill = (b: RecurringItem) => {
    if (Math.abs(Number(b.amount) - amount) > Math.max(0.5, amount * 0.02)) { setPending(b); setMode('billAmount'); } else linkBill(b, false);
  };
  const newBill = () => openItemEditor({
    kind: 'bill', initial: { name: t.merchant, amount, rule: { type: 'monthly_dom', dom: Number(t.date.slice(8, 10)) } },
    onSave: (item) => update((d) => { markAsBill(d, t.id, item); }, { undo: `${item.name} added to your bills` }),
  });

  return (
    <section className="card review-item">
      <div className="review-head">
        <span className="main-col"><span className="strong">{t.merchant}</span><span className="sub">{fmtDow(parseISOToMs(t.date))} · <span className="mono-ish">{t.description.slice(0, 60)}</span></span></span>
        <span className="trail"><Amount value={refund ? amount : -amount} signed tone={refund ? 'pos' : undefined} />{refund && <span className="sub">Refund</span>}</span>
      </div>
      {guessBill && mode === 'pick' && (
        <Note tone="info" action={<button type="button" className="btn sm ghost" onClick={() => chooseBill(guessBill)}>Yes, it's my {guessBill.name} bill</button>}>
          {sameAsPlan ? `Looks like your ${guessBill.name} bill.` : `Looks like your ${guessBill.name} bill, but your plan has it at ${fmtMoney(Number(guessBill.amount) || 0)}.`}
        </Note>
      )}
      {!guessBill && mode !== 'bill' && mode !== 'billAmount' && <p className="sub">{whyText(t, guesses, names)}</p>}
      {maybe && (
        <Note tone="info" action={<button type="button" className="btn sm ghost" onClick={() => update((d) => linkTxn(d, t.id, maybe.id), { undo: 'Matched to your log' })}>Yes, same purchase</button>}>
          Maybe the same as your {fmtShort(parseISOToMs(maybe.date))} log: {maybe.note || names(maybe.extraId)}, {fmtMoney(Math.abs(maybe.amount))} in {names(maybe.extraId)}.
        </Note>
      )}
      {mode === 'pick' && (
        <div className="chips">
          {suggested.map((id) => <button key={id} type="button" className="cp on-soft" onClick={() => file(id)}>{names(id)}</button>)}
          <button type="button" className="cp" onClick={() => setMode('more')}>{suggested.length ? 'Other' : 'Pick a budget'}</button>
          <button type="button" className="cp" onClick={() => setMode('split')}>Split</button>
          <button type="button" className="cp" onClick={() => setMode('skip')}>Not spending</button>
        </div>
      )}
      {mode === 'more' && (
        <div className="chips">
          {opts.map((o) => <button key={o.id} type="button" className="cp" onClick={() => file(o.id)}>{o.name}</button>)}
          {!refund && <button type="button" className="cp with-icon" onClick={() => setMode('bill')}><IconReceipt />It's a bill</button>}
          <button type="button" className="cp ghost-cp" onClick={() => setMode('pick')}>Back</button>
        </div>
      )}
      {mode === 'bill' && <BillPicker t={t} onPick={chooseBill} onNew={newBill} onBack={() => setMode('pick')} />}
      {mode === 'billAmount' && pending && (
        <div className="stack">
          <p className="sub body">Your plan has {pending.name} at {fmtMoney(Number(pending.amount) || 0)}. This charge was {fmtMoney(amount)}.</p>
          <div className="btn-row wrap">
            <button type="button" className="btn sm" onClick={() => linkBill(pending, true)}>Make it {fmtMoney(amount)}</button>
            <button type="button" className="btn sm ghost" onClick={() => linkBill(pending, false)}>Keep {fmtMoney(Number(pending.amount) || 0)}</button>
            <button type="button" className="btn sm quiet" onClick={() => setMode('bill')}>Back</button>
          </div>
        </div>
      )}
      {mode === 'skip' && (
        <div className="btn-row wrap">
          <button type="button" className="btn sm ghost" onClick={() => update((d) => skipTxn(d, t.id), { undo: `${t.merchant} skipped` })}>Not spending</button>
          {t.merchantKey && <button type="button" className="btn sm ghost" onClick={() => update((d) => skipTxn(d, t.id, true), { undo: `${t.merchant} will be skipped from now on` })}>Always skip {t.merchant}</button>}
          {!refund && <button type="button" className="btn sm ghost" onClick={() => setMode('bill')}><IconReceipt />It's one of my bills</button>}
          <button type="button" className="btn sm quiet" onClick={() => setMode('pick')}>Back</button>
        </div>
      )}
      {mode === 'split' && <SplitEditor total={amount} options={opts} initial={suggested} onCancel={() => setMode('pick')}
        onSave={(parts) => update((d) => { fileTxn(d, t.id, parts, now()); }, { undo: `${t.merchant} split across ${parts.length} budgets` })} />}
    </section>
  );
}

/** "Which bill is it?": the likeliest bills as chips, every bill in a list, or a new bill made from this charge. */
function BillPicker({ t, onPick, onNew, onBack }: { t: BankTxn; onPick: (b: RecurringItem) => void; onNew: () => void; onBack: () => void }) {
  const data = useActive();
  const choices = billChoices(data, t);
  const likely = choices.filter((c) => c.likely).slice(0, 3).map((c) => c.bill);
  const rest = choices.map((c) => c.bill).filter((b) => !likely.includes(b));
  const label = (b: RecurringItem) => `${b.name} · ${fmtMoney(Number(b.amount) || 0)}`;
  return (
    <div className="stack">
      <p className="sub">Which bill is it? It won't count as spending, and the app will know this charge next time.</p>
      {likely.length > 0 && <div className="chips">{likely.map((b) => <button key={b.id} type="button" className="cp on-soft" onClick={() => onPick(b)}>{label(b)}</button>)}</div>}
      {rest.length > 0 && (
        <Select value="" onChange={(id) => { const b = rest.find((x) => x.id === id); if (b) onPick(b); }}
          options={[{ value: '', label: likely.length ? 'Another bill…' : 'Pick the bill…' }, ...rest.map((b) => ({ value: b.id, label: label(b) }))]} />
      )}
      <div className="btn-row wrap">
        <button type="button" className="btn sm ghost" onClick={onNew}><IconPlus />Add it as a new bill</button>
        <button type="button" className="btn sm quiet" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}

function SplitEditor({ total, options, initial, onSave, onCancel }: {
  total: number; options: BudgetOption[]; initial: string[]; onSave: (parts: Array<{ extraId: string; amount: number }>) => void; onCancel: () => void;
}) {
  const first = initial[0] ?? options[0]?.id ?? MISC_ID;
  const second = initial[1] ?? options.find((o) => o.id !== first)?.id ?? MISC_ID;
  const [parts, setParts] = useState<Array<{ extraId: string; amount: number }>>([{ extraId: first, amount: NaN }, { extraId: second, amount: NaN }]);
  const head = parts.slice(0, -1);
  const used = round2(head.reduce((s, p) => s + (Number.isFinite(p.amount) ? p.amount : 0), 0));
  const rest = round2(total - used);
  const ok = head.every((p) => Number.isFinite(p.amount) && p.amount > 0) && rest > 0;
  const choices = options.map((o) => ({ value: o.id, label: o.name }));
  const set = (i: number, patch: Partial<{ extraId: string; amount: number }>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="split-editor">
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <div key={i} className="split-row">
            <Select value={p.extraId} options={choices} onChange={(v) => set(i, { extraId: v })} />
            {last ? <span className={`split-rest ${rest <= 0 ? 'bad-t' : ''}`} aria-label="The rest">{fmtMoney(rest)}</span>
              : <MoneyInput value={Number.isFinite(p.amount) ? p.amount : null} onChange={(v) => set(i, { amount: v })} />}
            {parts.length > 2 && !last
              ? <button type="button" className="icon-btn plain" aria-label="Remove this part" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}><IconClose /></button>
              : <span className="split-gap" />}
          </div>
        );
      })}
      <p className="sub">The last line gets whatever is left of {fmtMoney(total)}.</p>
      <div className="btn-row wrap">
        <button type="button" className="btn sm ghost" onClick={() => setParts((ps) => [...ps.slice(0, -1), { extraId: options.find((o) => !ps.some((p) => p.extraId === o.id))?.id ?? MISC_ID, amount: NaN }, ps[ps.length - 1]])}><IconPlus />Add a part</button>
        <button type="button" className="btn sm quiet" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn sm" disabled={!ok} onClick={() => onSave(parts.map((p, i) => (i === parts.length - 1 ? { ...p, amount: rest } : p)))}>Save split</button>
      </div>
    </div>
  );
}

quickActions.review = openReview;
