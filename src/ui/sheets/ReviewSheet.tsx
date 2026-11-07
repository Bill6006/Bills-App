import { useMemo, useState } from 'react';
import { fmtDow, fmtShort, parseISOToMs } from '../../engine/dates';
import { fmtMoney, round2 } from '../../engine/money';
import { fileTxn, linkTxn, reviewAgain, reviewTxns, skipTxn } from '../../engine/bank/importer';
import { buildModel, predict, type Model } from '../../engine/bank/learn';
import { describeMerchant } from '../../engine/bank/merchant';
import { MISC_ID, type BankTxn } from '../../engine/types';
import { openSheet } from '../../state/sheets';
import { update, useActive, useStore } from '../../state/store';
import { budgetOptions, displayName, type BudgetOption } from '../../state/spendingModels';
import { Sheet } from '../components/Sheet';
import { Amount, Note } from '../components/bits';
import { MoneyInput, Select } from '../components/controls';
import { IconCheckCircle, IconChevronDown, IconClose, IconPlus } from '../icons';
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
  const [mode, setMode] = useState<'pick' | 'more' | 'split' | 'skip'>('pick');
  const opts = budgetOptions(data).filter((o) => !o.archived);
  const names = (id: string) => displayName(data, id);
  const amount = round2(Math.abs(t.amount));
  const live = predict(model, { key: t.merchantKey, kind: kindOfTxn(t) }, amount, t.bankCategory).suggestions;
  const guesses = live.length ? live : t.suggest || [];
  const suggested = guesses.map((s) => s.extraId).filter((id) => opts.some((o) => o.id === id)).slice(0, 2);
  const refund = t.amount > 0;
  const maybe = t.maybeSameAs ? data.spendEntries.find((e) => e.id === t.maybeSameAs) : undefined;
  const now = () => new Date().toISOString();
  const file = (extraId: string) => update((d) => { fileTxn(d, t.id, [{ extraId, amount }], now()); }, { undo: `${t.merchant} filed in ${names(extraId)}` });

  return (
    <section className="card review-item">
      <div className="review-head">
        <span className="main-col"><span className="strong">{t.merchant}</span><span className="sub">{fmtDow(parseISOToMs(t.date))} · <span className="mono-ish">{t.description.slice(0, 60)}</span></span></span>
        <span className="trail"><Amount value={refund ? amount : -amount} signed tone={refund ? 'pos' : undefined} />{refund && <span className="sub">Refund</span>}</span>
      </div>
      <p className="sub">{whyText(t, guesses, names)}</p>
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
          <button type="button" className="cp ghost-cp" onClick={() => setMode('pick')}>Back</button>
        </div>
      )}
      {mode === 'skip' && (
        <div className="btn-row wrap">
          <button type="button" className="btn sm ghost" onClick={() => update((d) => skipTxn(d, t.id), { undo: `${t.merchant} skipped` })}>Not spending</button>
          {t.merchantKey && <button type="button" className="btn sm ghost" onClick={() => update((d) => skipTxn(d, t.id, true), { undo: `${t.merchant} will be skipped from now on` })}>Always skip {t.merchant}</button>}
          <button type="button" className="btn sm quiet" onClick={() => setMode('pick')}>Back</button>
        </div>
      )}
      {mode === 'split' && <SplitEditor total={amount} options={opts} initial={suggested} onCancel={() => setMode('pick')}
        onSave={(parts) => update((d) => { fileTxn(d, t.id, parts, now()); }, { undo: `${t.merchant} split across ${parts.length} budgets` })} />}
    </section>
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
