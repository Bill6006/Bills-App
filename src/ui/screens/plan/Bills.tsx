import { useMemo } from 'react';
import { fmtShort } from '../../../engine/dates';
import { fmtMoney, round2 } from '../../../engine/money';
import { loanOutlook } from '../../../engine/loans';
import { describeRule } from '../../../engine/schedule';
import type { AppData, BillsSort, RecurringItem } from '../../../engine/types';
import { navigate } from '../../../app/router';
import { currentPeriod } from '../../../state/models';
import { update, useActive } from '../../../state/store';
import { useEngine } from '../../../state/useEngine';
import { Amount, Chip, Note } from '../../components/bits';
import { Select } from '../../components/controls';
import { IconChevronRight, IconEnvelope, IconPlus, IconReceipt } from '../../icons';
import { nextOccurrences, openItemEditor } from './ItemEditor';
import { moveInOrder, nextLabel, PlanHeader, ReorderList, useOpenOnRoute } from './common';

const SORTS: Array<{ value: BillsSort; label: string }> = [
  { value: 'custom', label: 'My order' },
  { value: 'date', label: 'By date' },
  { value: 'alpha', label: 'A to Z' },
  { value: 'amountDesc', label: 'Largest first' },
  { value: 'amountAsc', label: 'Smallest first' },
];

const byName = (a: RecurringItem, b: RecurringItem) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });

function inOrder(items: RecurringItem[], order: string[]): RecurringItem[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
}

/** v117 sorting: by date uses each bill's first date this month (bills with none go last). */
function sortBills(items: RecurringItem[], data: AppData, mode: BillsSort, firstDate: Map<string, number>): RecurringItem[] {
  if (mode === 'alpha') return [...items].sort(byName);
  if (mode === 'amountAsc' || mode === 'amountDesc') {
    const dir = mode === 'amountDesc' ? -1 : 1;
    return [...items].sort((a, b) => (a.amount !== b.amount ? (a.amount - b.amount) * dir : byName(a, b)));
  }
  if (mode === 'date') {
    return [...items].sort((a, b) => {
      const am = firstDate.get(a.id), bm = firstDate.get(b.id);
      if (am == null && bm != null) return 1;
      if (am != null && bm == null) return -1;
      if (am != null && bm != null && am !== bm) return am - bm;
      return byName(a, b);
    });
  }
  return inOrder(items, data.order.bills);
}

function upsert(list: RecurringItem[], item: RecurringItem): RecurringItem[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}

function ItemRow({ item, next, handle, onOpen, count, today }: { item: RecurringItem; next?: number; handle: React.ReactNode; onOpen: () => void; count?: number; today: string }) {
  return (
    <div className={`row ${handle ? 'with-handle' : 'no-lead'}`}>
      {handle}
      <button type="button" className="row-tap" onClick={onOpen}>
        <span className="main-col">
          <span className="title">{item.name || 'Untitled'}</span>
          <span className="sub">{describeRule(item.rule)} · {nextLabel(next, today)}</span>
        </span>
        <span className="trail">
          <Amount value={item.amount} />
          {count != null && count > 1 && <span className="sub">×{count} this month</span>}
        </span>
      </button>
    </div>
  );
}

export function BillsPage({ sub }: { sub?: string }) {
  const data = useActive();
  const engine = useEngine();
  const today = engine.today();
  const mk = today.slice(0, 7);
  const mode = data.prefs.billsSort;

  const core = engine.core(mk);
  const { firstDate, counts, billsTotal, loansTotal } = useMemo(() => {
    const first = new Map<string, number>();
    const cnt = new Map<string, number>();
    let bills = 0, loans = 0;
    for (const [ms, list] of core.occ) {
      for (const it of list) {
        if (it.debtId) { loans += it.amount; continue; }
        bills += it.amount;
        cnt.set(it.id, (cnt.get(it.id) || 0) + 1);
        const prev = first.get(it.id);
        if (prev == null || ms < prev) first.set(it.id, ms);
      }
    }
    return { firstDate: first, counts: cnt, billsTotal: round2(bills), loansTotal: round2(loans) };
  }, [core]);

  const list = sortBills(data.bills, data, mode, firstDate);
  const nextOf = (it: RecurringItem) => nextOccurrences(it, data.settings, today, 1)[0];

  const save = (item: RecurringItem) => update((d) => {
    const isNew = !d.bills.some((b) => b.id === item.id);
    d.bills = upsert(d.bills, item);
    if (isNew) d.order.bills = [...d.order.bills.filter((id) => id !== item.id), item.id];
  }, { undo: data.bills.some((b) => b.id === item.id) ? 'Bill saved' : 'Bill added' });
  const remove = (item: RecurringItem) => update((d) => {
    d.bills = d.bills.filter((b) => b.id !== item.id);
    d.order.bills = d.order.bills.filter((id) => id !== item.id);
  }, { undo: `${item.name || 'Bill'} deleted` });
  const move = (from: number, to: number) => update((d) => {
    d.order.bills = moveInOrder(inOrder(d.bills, d.order.bills).map((b) => b.id), list.map((b) => b.id), from, to);
  });
  const moveBy = (item: RecurringItem, dir: -1 | 1) => {
    const i = list.findIndex((b) => b.id === item.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    move(i, j);
  };
  const open = (item?: RecurringItem) => openItemEditor({ kind: 'bill', item, onSave: save, onDelete: remove, onMove: mode === 'custom' ? moveBy : undefined });

  const target = sub && sub !== 'new' ? data.bills.find((b) => b.id === sub) : undefined;
  useOpenOnRoute(!!sub, '/plan/bills', () => open(target));

  const loans = data.debts.filter((d) => d.balance > 0);

  return (
    <div className="page page-narrow">
      <PlanHeader title="Bills" action={<button type="button" className="btn sm" onClick={() => open()}><IconPlus />Add</button>} />

      <section className="card">
        <div className="kv">
          <dt>Bills this month</dt><dd>{fmtMoney(billsTotal)}</dd>
          {loansTotal > 0 && <><dt>Loan payments</dt><dd>{fmtMoney(loansTotal)}</dd></>}
          <dt className="strong">Paid from the Bills account</dt><dd>{fmtMoney(round2(billsTotal + loansTotal))}</dd>
        </div>
        <p className="sub">Bills are paid from the Bills account. Your paychecks move enough over to cover them, with your cushion on top.</p>
      </section>

      {data.bills.length === 0 ? (
        <section className="card">
          <div className="empty"><IconReceipt /><div className="t">No bills yet</div><div className="t-sm">Add rent, utilities, phone, insurance and anything else you pay on a schedule. Use a slightly high number for bills that vary.</div></div>
          <button type="button" className="btn" onClick={() => open()}><IconPlus />Add a bill</button>
        </section>
      ) : (
        <section className="card flush">
          <div className="card-head pad">
            <span className="lbl">{data.bills.length} bill{data.bills.length === 1 ? '' : 's'}</span>
            <span className="sort-pick"><span className="sub">Sort</span>
              <Select value={mode} options={SORTS} onChange={(v) => update((d) => { d.prefs.billsSort = v; }, { real: true })} />
            </span>
          </div>
          <ReorderList items={list} idOf={(b) => b.id} enabled={mode === 'custom'} label="Bills" onMove={move}
            row={(b, handle) => <ItemRow item={b} next={nextOf(b)} handle={handle} count={counts.get(b.id)} today={today} onOpen={() => open(b)} />} />
          {mode === 'custom' && list.length > 1 && <p className="sub pad">Drag the dots to reorder.</p>}
        </section>
      )}

      {loans.length > 0 && (
        <section className="card flush">
          <div className="card-head pad"><span className="lbl">Loan payments</span><span className="sub">Set up in Loans</span></div>
          <div className="list">
            {loans.map((d) => {
              const o = loanOutlook(d, today);
              return (
                <button key={d.id} type="button" className="row no-lead" onClick={() => navigate(`/plan/loans/${d.id}`)}>
                  <span className="main-col"><span className="title">{d.name}</span><span className="sub">Monthly on the {d.dueDay >= 31 ? 'last day' : ordinalDay(d.dueDay)}{o.nextDue ? ` · next ${fmtShort(Date.parse(o.nextDue))}` : ''}</span></span>
                  <span className="trail"><Amount value={o.nextAmount || round2(d.minPayment + d.extraPayment)} /><span className="sub">{d.autoPay ? 'Automatic' : 'You log it'}</span></span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function ordinalDay(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function BudgetsPage({ sub }: { sub?: string }) {
  const data = useActive();
  const engine = useEngine();
  const today = engine.today();
  const list = inOrder(data.extras, data.order.extras);
  const cur = currentPeriod(engine, today);
  const pay = cur.startPayday;

  const save = (item: RecurringItem) => update((d) => {
    const isNew = !d.extras.some((b) => b.id === item.id);
    // A new every-payday budget starts with the current pay period, so past periods keep the budgets they had.
    if (isNew && !item._extraMonth && item.rule.type === 'perpay') item = { ...item, _extraMonth: cur.period.startIso.slice(0, 7) };
    d.extras = upsert(d.extras, item);
    if (isNew) d.order.extras = [...d.order.extras.filter((id) => id !== item.id), item.id];
  }, { undo: data.extras.some((b) => b.id === item.id) ? 'Budget saved' : 'Budget added' });
  const remove = (item: RecurringItem) => update((d) => {
    d.extras = d.extras.filter((b) => b.id !== item.id);
    d.order.extras = d.order.extras.filter((id) => id !== item.id);
  }, { undo: `${item.name || 'Budget'} deleted. Its logs stay in History.` });
  const move = (from: number, to: number) => update((d) => {
    d.order.extras = moveInOrder(d.order.extras, list.map((b) => b.id), from, to);
  });
  const moveBy = (item: RecurringItem, dir: -1 | 1) => {
    const i = list.findIndex((b) => b.id === item.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    move(i, j);
  };
  const open = (item?: RecurringItem) => openItemEditor({ kind: 'budget', item, onSave: save, onDelete: remove, onMove: moveBy });
  useOpenOnRoute(sub === 'new', '/plan/budgets', () => open());

  return (
    <div className="page page-narrow">
      <PlanHeader title="Spending budgets" action={<button type="button" className="btn sm" onClick={() => open()}><IconPlus />Add</button>} />
      <section className="card">
        {pay ? (
          <div className="kv">
            <dt>Spending money this pay period</dt><dd>{fmtMoney(pay.spending)}</dd>
            <dt>Budgeted</dt><dd>{fmtMoney(pay.planned)}</dd>
            <dt className="strong">Unassigned</dt><dd className={pay.free < 0 ? 'bad-t' : ''}>{fmtMoney(pay.free)}</dd>
          </div>
        ) : null}
        <p className="sub">Budgets are planned costs like groceries and gas. They come out of your spending money, never the Bills account. Whatever isn't budgeted shows as Unassigned.</p>
      </section>
      {list.length === 0 ? (
        <section className="card">
          <div className="empty"><IconEnvelope /><div className="t">No budgets yet</div><div className="t-sm">Most budgets repeat every payday, like $80 for gas.</div></div>
          <button type="button" className="btn" onClick={() => open()}><IconPlus />Add a budget</button>
        </section>
      ) : (
        <section className="card flush">
          <div className="card-head pad"><span className="lbl">{list.length} budget{list.length === 1 ? '' : 's'}</span></div>
          <ReorderList items={list} idOf={(b) => b.id} label="Budgets" onMove={move}
            row={(b, handle) => <ItemRow item={b} next={nextOccurrences(b, data.settings, today, 1)[0]} handle={handle} today={today} onOpen={() => open(b)} />} />
          {list.length > 1 && <p className="sub pad">Drag the dots to reorder. The order is used on the Spending screen.</p>}
        </section>
      )}
      {pay && pay.free < 0 && <Note tone="warn">Your budgets add up to more than this pay period's spending money by {fmtMoney(-pay.free)}.</Note>}
      <button type="button" className="row no-lead card tap" onClick={() => navigate('/spending')}>
        <span className="main-col"><span className="title">See spending</span><span className="sub">What's left in each budget</span></span>
        <span className="trail"><Chip>Spending</Chip></span>
        <IconChevronRight />
      </button>
    </div>
  );
}
