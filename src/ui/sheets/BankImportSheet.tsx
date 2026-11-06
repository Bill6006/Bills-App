import { useMemo, useRef, useState } from 'react';
import { fmtRange, fmtShort, parseISOToMs } from '../../engine/dates';
import { fmtMoney, round2 } from '../../engine/money';
import { applyImport, planImport, type ImportPlan, type PlanItem } from '../../engine/bank/importer';
import { parseStatement, readCsvRows, type ParsedStatement } from '../../engine/bank/statement';
import { describeMerchant } from '../../engine/bank/merchant';
import type { CsvProfile } from '../../engine/types';
import { openSheet } from '../../state/sheets';
import { update, useActive, useStore } from '../../state/store';
import { displayName } from '../../state/spendingModels';
import { Sheet } from '../components/Sheet';
import { Amount, Chip, Note } from '../components/bits';
import { Segmented, Select } from '../components/controls';
import { IconChevronDown, IconFile, IconPaste } from '../icons';
import { openReview } from './ReviewSheet';
import { skipReason } from './bankText';
import { quickActions } from './quickActions';

export function openBankImport() {
  openSheet((close) => <BankImportSheet onClose={close} />);
}

type Step = { kind: 'choose' } | { kind: 'check'; parsed: ParsedStatement; fileName?: string } | { kind: 'preview'; parsed: ParsedStatement; plan: ImportPlan; profileToSave?: CsvProfile };


function BankImportSheet({ onClose }: { onClose: () => void }) {
  const data = useActive();
  const today = useStore((s) => s.today);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [error, setError] = useState('');
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const toPreview = (parsed: ParsedStatement, profileToSave?: CsvProfile) => {
    setStep({ kind: 'preview', parsed, plan: planImport(data, parsed, today), profileToSave });
  };
  const read = (t: string, fileName?: string) => {
    setError('');
    try {
      const parsed = parseStatement(t, data.bank.profiles);
      if (parsed.format === 'csv' && parsed.needsCheck) setStep({ kind: 'check', parsed, fileName });
      else toPreview(parsed);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (step.kind === 'check') {
    return <ColumnCheck parsed={step.parsed} onBack={() => setStep({ kind: 'choose' })} onClose={onClose}
      onOk={(profile) => {
        const { txns, skipped } = readCsvRows(step.parsed.rows || [], profile);
        if (!txns.length) { setError('With those columns no transactions could be read.'); setStep({ kind: 'choose' }); return; }
        toPreview({ ...step.parsed, txns, skippedRows: skipped, profile, needsCheck: false }, profile);
      }} />;
  }

  if (step.kind === 'preview') {
    return <Preview plan={step.plan} onBack={() => setStep({ kind: 'choose' })} onClose={onClose}
      onImport={() => {
        const n = (a: string) => step.plan.items.filter((i) => i.action === a).length;
        const review = n('review');
        const parts = [n('log') ? `${n('log')} filed` : '', n('match') ? `${n('match')} already logged` : '', review ? `${review} to review` : ''].filter(Boolean).join(', ');
        update((d) => {
          if (step.profileToSave) d.bank.profiles = [...d.bank.profiles.filter((p) => p.signature !== step.profileToSave!.signature), step.profileToSave];
          applyImport(d, step.plan, new Date().toISOString());
        }, { undo: `Imported: ${parts || 'nothing to file'}.` });
        onClose();
        if (review) window.setTimeout(() => openReview(), 260);
      }} />;
  }

  return (
    <Sheet title="Import from your bank" onClose={onClose}>
      <p className="sub body">On your bank's website or app, find <b>Download transactions</b> (sometimes under Statements or Export) and choose <b>CSV</b>, <b>QFX</b> or <b>OFX</b>. Then pick that file here. A PDF statement won't work.</p>
      <input ref={fileRef} type="file" accept=".csv,.qfx,.ofx,.txt,text/csv,text/plain,application/x-ofx,application/vnd.intu.qfx,application/octet-stream" hidden
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) read(await f.text(), f.name); }} />
      <button type="button" className="btn block" onClick={() => fileRef.current?.click()}><IconFile />Choose file</button>
      {!paste
        ? <button type="button" className="btn ghost block" onClick={() => setPaste(true)}><IconPaste />Paste text instead</button>
        : (
          <div className="stack">
            <textarea className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the file's text" aria-label="Statement text" />
            <button type="button" className="btn ghost" disabled={!text.trim()} onClick={() => read(text)}>Read pasted text</button>
          </div>
        )}
      {error && <Note tone="bad">{error}</Note>}
      <Note tone="info">Nothing is added twice: transactions from earlier imports are skipped, and purchases you already logged by hand are matched instead of added.</Note>
      {data.bank.lastImportAt && <p className="sub">Last import {fmtShort(Date.parse(data.bank.lastImportAt))}{data.bank.lastTxnDate ? `, with transactions through ${fmtShort(parseISOToMs(data.bank.lastTxnDate))}` : ''}.</p>}
    </Sheet>
  );
}

// ---------- first time with a CSV layout: confirm the columns ----------

function ColumnCheck({ parsed, onOk, onBack, onClose }: { parsed: ParsedStatement; onOk: (p: CsvProfile) => void; onBack: () => void; onClose: () => void }) {
  const [p, setP] = useState<CsvProfile>(parsed.profile!);
  const headers = parsed.headers?.length ? parsed.headers : (parsed.rows?.[0] || []).map((_, i) => `Column ${i + 1}`);
  const cols = headers.map((h, i) => ({ value: String(i), label: `${h || `Column ${i + 1}`}${parsed.rows?.[0]?.[i] ? ` (e.g. ${String(parsed.rows[0][i]).slice(0, 18)})` : ''}` }));
  const none = { value: '-1', label: 'None' };
  const sample = useMemo(() => readCsvRows((parsed.rows || []).slice(0, 6), p).txns, [parsed.rows, p]);
  const split = p.amount == null;
  const set = (patch: Partial<CsvProfile>) => setP((x) => ({ ...x, ...patch }));
  const num = (v: string) => (Number(v) >= 0 ? Number(v) : null);
  return (
    <Sheet title="Check your file" eyebrow="First import from this bank" onClose={onClose}
      footer={<><button type="button" className="btn ghost" onClick={onBack}>Back</button><button type="button" className="btn" disabled={!sample.length} onClick={() => onOk(p)}>Looks right</button></>}>
      <p className="sub body">Here's how the first few lines read. If something's off, fix it below. This bank's layout is remembered after this.</p>
      <div className="card flush"><div className="list">
        {sample.length ? sample.slice(0, 4).map((t, i) => (
          <div key={i} className="row no-lead">
            <span className="main-col"><span className="title">{describeMerchant(t.description).name || t.description}</span><span className="sub">{fmtShort(parseISOToMs(t.date))} · {t.description.slice(0, 42)}</span></span>
            <span className="trail"><Amount value={t.flow} signed tone={t.flow > 0 ? 'pos' : undefined} /><span className="sub">{t.flow < 0 ? 'money out' : 'money in'}</span></span>
          </div>
        )) : <p className="sub pad">No lines could be read with these settings.</p>}
      </div></div>
      {!split && p.indicator == null && (
        <div className="field"><span className="lbl">Purchases in this file show as</span>
          <Segmented label="How purchases show" value={p.outNegative ? 'neg' : 'pos'} onChange={(v) => set({ outNegative: v === 'neg' })}
            options={[{ value: 'neg', label: 'Minus (−45.10)' }, { value: 'pos', label: 'Plus (45.10)' }]} />
        </div>
      )}
      <details className="disclosure">
        <summary><span>Columns</span><IconChevronDown /></summary>
        <div className="fields">
          <label className="field"><span className="lbl">Date</span><Select value={String(p.date)} options={cols} onChange={(v) => set({ date: Number(v) })} /></label>
          <label className="field"><span className="lbl">Description</span><Select value={String(p.description)} options={cols} onChange={(v) => set({ description: Number(v) })} /></label>
          <Segmented size="sm" label="Amount columns" value={split ? 'two' : 'one'} onChange={(v) => set(v === 'one' ? { amount: p.debit ?? p.credit ?? 0, debit: null, credit: null } : { amount: null, debit: p.amount ?? 0, credit: (p.amount ?? 0) + 1 })}
            options={[{ value: 'one', label: 'One amount column' }, { value: 'two', label: 'Money out + money in' }]} />
          {!split
            ? <label className="field"><span className="lbl">Amount</span><Select value={String(p.amount)} options={cols} onChange={(v) => set({ amount: Number(v) })} /></label>
            : <>
              <label className="field"><span className="lbl">Money out</span><Select value={String(p.debit ?? -1)} options={[none, ...cols]} onChange={(v) => set({ debit: num(v) })} /></label>
              <label className="field"><span className="lbl">Money in</span><Select value={String(p.credit ?? -1)} options={[none, ...cols]} onChange={(v) => set({ credit: num(v) })} /></label>
            </>}
          <Segmented size="sm" label="Date order" value={p.dateOrder} onChange={(v) => set({ dateOrder: v })}
            options={[{ value: 'mdy', label: 'Month/Day' }, { value: 'dmy', label: 'Day/Month' }, { value: 'ymd', label: 'Year-Month-Day' }]} />
        </div>
      </details>
    </Sheet>
  );
}

// ---------- preview ----------

function Preview({ plan, onImport, onBack, onClose }: { plan: ImportPlan; onImport: () => void; onBack: () => void; onClose: () => void }) {
  const data = useActive();
  const log = plan.items.filter((i) => i.action === 'log');
  const match = plan.items.filter((i) => i.action === 'match');
  const review = plan.items.filter((i) => i.action === 'review');
  const skip = plan.items.filter((i) => i.action === 'skip');
  const byBudget = new Map<string, { total: number; items: PlanItem[] }>();
  for (const i of log) {
    const g = byBudget.get(i.extraId!) || { total: 0, items: [] };
    g.total = round2(g.total + (i.refund ? -1 : 1) * Math.abs(i.txn.amount));
    g.items.push(i);
    byBudget.set(i.extraId!, g);
  }
  const nothing = !plan.items.length;
  return (
    <Sheet title="Ready to import" eyebrow={plan.from && plan.to ? fmtRange(parseISOToMs(plan.from), parseISOToMs(plan.to)) : 'Bank import'} onClose={onClose}
      footer={<><button type="button" className="btn ghost" onClick={onBack}>Back</button><button type="button" className="btn" disabled={nothing} onClick={onImport}>{nothing ? 'Nothing new' : `Import ${plan.items.length}`}</button></>}>
      <div className="card">
        <dl className="kv">
          <dt>Filed into budgets</dt><dd>{log.length}</dd>
          <dt>Already logged by you</dt><dd>{match.length}</dd>
          <dt>Need a quick look</dt><dd>{review.length}</dd>
          <dt>Not spending</dt><dd>{skip.length}</dd>
          {plan.alreadyImported > 0 && <><dt>Already imported before</dt><dd>{plan.alreadyImported}</dd></>}
          {plan.pending > 0 && <><dt>Pending, left out</dt><dd>{plan.pending}</dd></>}
        </dl>
      </div>
      {nothing && <Note tone="ok">Everything in this file is already in the app.</Note>}
      {plan.pending > 0 && <p className="sub">Pending transactions can still change (gas pump holds, tips), so they're left out. They'll come in with your next download once they post.</p>}
      {byBudget.size > 0 && (
        <details className="disclosure card flush" open={byBudget.size <= 3}>
          <summary className="pad"><span className="lbl">Filed into budgets</span><IconChevronDown /></summary>
          <div className="list">
            {[...byBudget.entries()].map(([id, g]) => (
              <div key={id} className="row no-lead">
                <span className="main-col"><span className="title">{displayName(data, id)}</span><span className="sub">{g.items.slice(0, 4).map((i) => i.txn.merchant).join(', ')}{g.items.length > 4 ? ` +${g.items.length - 4}` : ''}</span></span>
                <span className="trail"><Amount value={g.total} /><span className="sub">{g.items.length} purchase{g.items.length === 1 ? '' : 's'}</span></span>
              </div>
            ))}
          </div>
        </details>
      )}
      {match.length > 0 && (
        <details className="disclosure card flush">
          <summary className="pad"><span className="lbl">Already logged by you</span><IconChevronDown /></summary>
          <div className="list">{match.map((i) => <TxnLine key={i.txn.id} item={i} right={<Chip tone="good">Matched</Chip>} />)}</div>
        </details>
      )}
      {skip.length > 0 && (
        <details className="disclosure card flush">
          <summary className="pad"><span className="lbl">Not spending</span><IconChevronDown /></summary>
          <div className="list">{skip.map((i) => <TxnLine key={i.txn.id} item={i} right={<Chip>{skipReason(i.txn.how)}</Chip>} />)}</div>
        </details>
      )}
      {review.length > 0 && <p className="sub">You'll pick budgets for the {review.length} that need a look right after importing. You can change any of them later.</p>}
    </Sheet>
  );
}

function TxnLine({ item, right }: { item: PlanItem; right: React.ReactNode }) {
  return (
    <div className="row no-lead">
      <span className="main-col"><span className="title">{item.txn.merchant}</span><span className="sub">{fmtShort(parseISOToMs(item.txn.date))} · {fmtMoney(Math.abs(item.txn.amount))}{item.txn.amount > 0 ? ' in' : ''}</span></span>
      <span className="trail">{right}</span>
    </div>
  );
}

quickActions.bankImport = openBankImport;
