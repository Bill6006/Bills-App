import { useRef, useState } from 'react';
import { fmtMonthLong } from '../../engine/dates';
import { fmtMoney } from '../../engine/money';
import { parseImportText } from '../../data/backup';
import type { ImportResult } from '../../data/importV117';
import { isEmptyData } from '../../data/defaults';
import { openSheet } from '../../state/sheets';
import { replaceAll, useStore } from '../../state/store';
import { navigate } from '../../app/router';
import { Sheet } from '../components/Sheet';
import { Note } from '../components/bits';
import { IconFile, IconPaste } from '../icons';

export function openImport() {
  openSheet((close) => <ImportSheet onClose={close} />);
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const today = useStore((s) => s.today);
  const current = useStore((s) => s.data);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const read = (t: string, name?: string) => {
    setError('');
    try {
      setResult(parseImportText(t, today, name));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    read(await f.text(), f.name);
  };

  const apply = () => {
    if (!result) return;
    replaceAll(result.data, result.report.source === 'v117' ? 'Imported from Bills Account Planner.' : 'Backup restored.');
    onClose();
    navigate('/');
  };

  if (result) {
    const r = result.report;
    const c = r.counts;
    const items: Array<[string, number]> = [
      ['Bills', c.bills], ['Spending budgets', c.budgets], ['Spending logs', c.spendLogs], ['Budget moves', c.budgetMoves],
      ['Loans', c.loans], ['Loan payments', c.loanPayments], ['Planned withdrawals', c.withdrawals], ['Extra incomes', c.extraIncomes],
    ];
    return (
      <Sheet title="Check before importing" eyebrow={r.source === 'v117' ? 'From Bills Account Planner' : 'From a backup'} onClose={onClose}
        footer={<><button type="button" className="btn ghost" onClick={() => setResult(null)}>Back</button><button type="button" className="btn" onClick={apply}>Import</button></>}>
        <div className="card">
          <dl className="kv">
            <dt>Paycheck</dt><dd>{r.paycheck}</dd>
            <dt>Savings balance</dt><dd>{fmtMoney(r.balances.savings)} <span className="sub">at {fmtMonthLong(r.balances.savingsMonth)}</span></dd>
          </dl>
        </div>
        <div className="card">
          <dl className="kv">{items.filter(([, n]) => n > 0).map(([k, n]) => (<FragmentRow key={k} k={k} n={n} />))}</dl>
        </div>
        {r.notes.map((n) => <Note key={n} tone="info">{n}</Note>)}
        {!isEmptyData(current) && <Note tone="warn">This replaces what's in the app now. You can undo it right after.</Note>}
      </Sheet>
    );
  }

  return (
    <Sheet title="Import your data" onClose={onClose}>
      <p className="sub" style={{ fontSize: 14 }}>In Bills Account Planner, tap <b>Export JSON</b>. Then pick that file here, or paste its text. Backups made by this app work too.</p>
      <input ref={fileRef} type="file" accept="application/json,.json,text/plain" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      <button type="button" className="btn block" onClick={() => fileRef.current?.click()}><IconFile />Choose file</button>
      {!paste
        ? <button type="button" className="btn ghost block" onClick={() => setPaste(true)}><IconPaste />Paste text instead</button>
        : (
          <>
            <textarea className="textarea" rows={6} placeholder='Paste the file contents, starting with {' value={text} onChange={(e) => setText(e.target.value)} aria-label="Exported data" />
            <button type="button" className="btn ghost block" disabled={!text.trim()} onClick={() => read(text)}>Read pasted text</button>
          </>
        )}
      {error && <Note tone="bad">{error}</Note>}
      <p className="sub">Your data stays on this device. Nothing is uploaded.</p>
    </Sheet>
  );
}

function FragmentRow({ k, n }: { k: string; n: number }) {
  return <><dt>{k}</dt><dd>{n.toLocaleString('en-US')}</dd></>;
}
