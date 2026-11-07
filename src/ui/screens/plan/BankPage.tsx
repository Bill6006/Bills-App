import { useMemo, useState } from 'react';
import { fmtMedium, fmtShort, parseISOToMs } from '../../../engine/dates';
import { fmtMoney } from '../../../engine/money';
import { removeImport, reviewTxns, setRule } from '../../../engine/bank/importer';
import { buildModel, learnedStores } from '../../../engine/bank/learn';
import { describeMerchant } from '../../../engine/bank/merchant';
import type { MerchantRule } from '../../../engine/types';
import { openSheet } from '../../../state/sheets';
import { update, useActive, useStore } from '../../../state/store';
import { budgetOptions, displayName } from '../../../state/spendingModels';
import { Sheet } from '../../components/Sheet';
import { Chip, Note } from '../../components/bits';
import { openBankImport } from '../../sheets/BankImportSheet';
import { openReview } from '../../sheets/ReviewSheet';
import { IconFile } from '../../icons';
import { PlanHeader } from './common';

interface Store { key: string; name: string; count: number; top: string; topShare: number; rule?: MerchantRule }

export function BankPage() {
  const data = useActive();
  const today = useStore((s) => s.today);
  const toReview = reviewTxns(data).length;
  const stores = useMemo<Store[]>(() => {
    const names = new Map<string, string>();
    for (const e of data.spendEntries) {
      const key = e.merchantKey ?? describeMerchant(e.note || '').key;
      if (key && !names.has(key)) names.set(key, e.merchant || describeMerchant(e.note || '').name || key);
    }
    for (const t of data.bank.txns) if (t.merchantKey && !names.has(t.merchantKey)) names.set(t.merchantKey, t.merchant);
    const list: Store[] = learnedStores(buildModel(data, today)).map((s) => ({ ...s, name: names.get(s.key) || s.key, rule: data.bank.rules.find((r) => r.key === s.key) }));
    for (const r of data.bank.rules) if (!list.some((s) => s.key === r.key)) list.push({ key: r.key, name: r.name, count: 0, top: r.extraId || '', topShare: 0, rule: r });
    return list;
  }, [data, today]);
  const [showAll, setShowAll] = useState(false);
  const last = data.bank.lastImportAt;
  const lastCount = last ? data.bank.txns.filter((t) => t.importedAt === last).length : 0;

  return (
    <div className="page page-narrow">
      <PlanHeader title="Bank import" />
      <section className="card">
        <p className="sub body">Import your bank's monthly PDF statement, or a CSV, QFX or OFX download if your bank offers one. Purchases are filed into budgets when the app is sure, and the rest wait in To review.</p>
        <div className="btn-row wrap">
          <button type="button" className="btn" onClick={openBankImport}><IconFile />Import a file</button>
          {toReview > 0 && <button type="button" className="btn ghost" onClick={openReview}>Review {toReview}</button>}
        </div>
        {last
          ? <p className="sub">Last import {fmtMedium(Date.parse(last))}: {lastCount} transaction{lastCount === 1 ? '' : 's'}{data.bank.lastTxnDate ? `, through ${fmtShort(parseISOToMs(data.bank.lastTxnDate))}` : ''}.</p>
          : <p className="sub">No imports yet.</p>}
      </section>

      <Note tone="info">Nothing gets counted twice. Earlier imports are recognized, the same purchase in a CSV and a QFX is matched, purchases you logged by hand are linked instead of added, and pending charges wait until they post.</Note>

      <section className="card flush">
        <div className="card-head pad"><span className="lbl">Stores it knows</span><span className="sub">{stores.length}</span></div>
        {stores.length ? (
          <div className="list">
            {(showAll ? stores : stores.slice(0, 20)).map((s) => (
              <button key={s.key} type="button" className="row no-lead" onClick={() => openStore(s)}>
                <span className="main-col"><span className="title">{s.name}</span><span className="sub">{s.count ? `${displayName(data, s.top)} · ${Math.round(s.topShare * s.count)} of ${s.count} time${s.count === 1 ? '' : 's'}` : 'No purchases yet'}</span></span>
                <span className="trail">{s.rule ? <Chip tone="brass">{s.rule.action === 'skip' ? 'Always skip' : s.rule.action === 'ask' ? 'Always ask' : `Always ${displayName(data, s.rule.extraId || '')}`}</Chip> : <span className="sub">Learning</span>}</span>
              </button>
            ))}
          </div>
        ) : <p className="sub pad">Stores appear here once you've logged or imported purchases with a store name.</p>}
        {stores.length > 20 && <button type="button" className="link-btn pad" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${stores.length}`}</button>}
      </section>

      {(data.bank.billLinks || []).length > 0 && (
        <section className="card flush">
          <div className="pad"><span className="lbl">Bank text it knows as your bills</span></div>
          <div className="list">
            {(data.bank.billLinks || []).map((l) => {
              const bill = data.bills.find((b) => b.id === l.billId);
              return (
                <div key={`${l.text}|${l.billId}`} className="row no-lead">
                  <span className="main-col"><span className="title">{bill ? bill.name : 'A bill you deleted'}</span><span className="sub mono-ish">{l.text.toUpperCase()} · last {fmtMoney(l.amount)}</span></span>
                  <span className="trail"><button type="button" className="btn ghost sm" onClick={() => update((d) => { d.bank.billLinks = (d.bank.billLinks || []).filter((x) => !(x.text === l.text && x.billId === l.billId)); }, { real: true, undo: 'Forgotten' })}>Forget</button></span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {data.bank.profiles.length > 0 && (
        <section className="card flush">
          <div className="pad"><span className="lbl">Bank file layouts it remembers</span></div>
          <div className="list">
            {data.bank.profiles.map((p) => (
              <div key={p.signature} className="row no-lead">
                <span className="main-col"><span className="title">{p.signature.startsWith('h:') ? p.signature.slice(2).split('|').slice(0, 4).join(', ') : 'File without headers'}</span><span className="sub">{p.amount != null ? (p.outNegative ? 'Purchases shown with a minus' : 'Purchases shown as plus') : 'Money out and money in columns'}</span></span>
                <span className="trail"><button type="button" className="btn ghost sm" onClick={() => update((d) => { d.bank.profiles = d.bank.profiles.filter((x) => x.signature !== p.signature); }, { real: true, undo: 'Layout forgotten' })}>Forget</button></span>
              </div>
            ))}
          </div>
        </section>
      )}

      {last && (
        <button type="button" className="btn ghost danger-t" onClick={() => update((d) => { removeImport(d, last); }, { undo: `Removed the last import (${lastCount} transactions)` })}>
          Remove the last import
        </button>
      )}
    </div>
  );
}

function openStore(s: Store) {
  openSheet((close) => <StoreSheet s={s} onClose={close} />);
}

function StoreSheet({ s, onClose }: { s: Store; onClose: () => void }) {
  const data = useActive();
  const rule = data.bank.rules.find((r) => r.key === s.key);
  const opts = budgetOptions(data).filter((o) => !o.archived);
  const set = (action: 'budget' | 'ask' | 'skip' | 'learn', extraId?: string) => {
    update((d) => setRule(d, s.key, s.name, action, extraId), { real: true });
    onClose();
  };
  const current = rule ? (rule.action === 'budget' ? `budget:${rule.extraId}` : rule.action) : 'learn';
  return (
    <Sheet title={s.name} eyebrow="Store" onClose={onClose}>
      {s.count > 0 && <p className="sub body">You've filed it under {displayName(data, s.top)} {Math.round(s.topShare * s.count)} of {s.count} times.</p>}
      <div className="field"><span className="lbl">When this store shows up in an import</span>
        <div className="chips" role="radiogroup" aria-label="Rule for this store">
          <button type="button" role="radio" aria-checked={current === 'learn'} className={`cp ${current === 'learn' ? 'on' : ''}`} onClick={() => set('learn')}>Learn from my choices</button>
          <button type="button" role="radio" aria-checked={current === 'ask'} className={`cp ${current === 'ask' ? 'on' : ''}`} onClick={() => set('ask')}>Always ask</button>
          <button type="button" role="radio" aria-checked={current === 'skip'} className={`cp ${current === 'skip' ? 'on' : ''}`} onClick={() => set('skip')}>Not spending, skip it</button>
        </div>
      </div>
      <div className="field"><span className="lbl">Always file it in</span>
        <div className="chips" role="radiogroup" aria-label="Always file in">
          {opts.map((o) => <button key={o.id} type="button" role="radio" aria-checked={current === `budget:${o.id}`} className={`cp ${current === `budget:${o.id}` ? 'on' : ''}`} onClick={() => set('budget', o.id)}>{o.name}</button>)}
        </div>
      </div>
      <p className="sub">"Learn" is best for stores where you buy different things, like gas stations. It uses the amount to tell a fill-up from a snack.</p>
    </Sheet>
  );
}
