import { describe, expect, it } from 'vitest';
import { makeDefaultData } from '../src/data/defaults';
import { applyImport, billChoices, fileTxn, linkTxn, markAsBill, namedBill, planImport, reviewTxns, skipTxn, txnIds } from '../src/engine/bank/importer';
import { buildModel, predict } from '../src/engine/bank/learn';
import { describeMerchant } from '../src/engine/bank/merchant';
import { parseAmountCell, parseDateCell, parseStatement } from '../src/engine/bank/statement';
import type { AppData, SpendEntry } from '../src/engine/types';

const TODAY = '2026-11-06';

// ---------- synthetic data shaped like a real history: fill-ups vs gas-station snacks ----------
function sampleData(): AppData {
  const d = makeDefaultData(TODAY);
  d.settings.pay.paycheckCap = 2000;
  d.extras = [
    { id: 'gas', name: 'Gas', amount: 80, rule: { type: 'perpay' } },
    { id: 'groc', name: 'Groceries', amount: 200, rule: { type: 'perpay' } },
    { id: 'ff', name: 'Fast Food', amount: 60, rule: { type: 'perpay' } },
    { id: 'tithe', name: 'Tithe', amount: 60, rule: { type: 'perpay' } },
  ];
  d.order.extras = d.extras.map((x) => x.id);
  d.bills = [
    { id: 'b1', name: 'Netflix', amount: 9.84, rule: { type: 'monthly_dom', dom: 6 } },
    { id: 'b2', name: 'Rent', amount: 795, rule: { type: 'monthly_dom', dom: 1 } },
  ];
  let n = 0;
  const log = (extraId: string, amount: number, note: string, date = '2026-10-01'): SpendEntry => ({
    id: `s${n++}`, extraId, extraName: extraId, amount, entryType: 'spend', date, note, createdAt: '',
  });
  const fills = [7.5, 9.2, 33.6, 36.4, 38.1, 39.7, 40.5, 42.2, 44, 46.3, 49.8, 51.5];
  const snacks = [2.6, 3.1, 3.5, 3.9, 4.2, 5.1, 6.3, 7.6, 8.4, 10.5, 12.9, 15.7];
  d.spendEntries = [
    ...fills.map((a) => log('gas', a, '')),
    ...snacks.map((a) => log('groc', a, 'gas station food')),
    ...[24.1, 61.3, 18.75, 92.4, 33.3, 45.1].map((a) => log('groc', a, 'walmart food')),
    log('groc', 12.5, 'walmart'),
    ...[11.2, 15.8, 9.9, 13.4].map((a) => log('ff', a, 'taco bell')),
    ...[14.1, 16.6, 12.2].map((a) => log('groc', a, 'kroger')),
  ];
  return d;
}

const CHASE_CHECKING = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,11/04/2026,"SHELL OIL 57444 ATLANTA GA",-45.10,DEBIT_CARD,1200.00,,
DEBIT,11/04/2026,"SQ *SHELL OIL 57444 ATLANTA GA",-3.79,DEBIT_CARD,1245.10,,
DEBIT,11/03/2026,"WAL-MART SUPERCENTER #1234 ATLANTA GA",-52.37,DEBIT_CARD,1248.89,,
DEBIT,11/03/2026,"TACO BELL #031234",-12.48,DEBIT_CARD,1301.26,,
DEBIT,11/02/2026,"RACETRAC 2210 DECATUR GA",-11.50,DEBIT_CARD,1313.74,,
CREDIT,11/01/2026,"ACME CORP PAYROLL PPD ID: 123",2000.00,ACH_CREDIT,1325.24,,
DEBIT,11/01/2026,"ONLINE TRANSFER TO SAV XXXX9911",-225.00,ACCT_XFER,-674.76,,
DEBIT,11/06/2026,"NETFLIX.COM",-9.84,DEBIT_CARD,-449.76,,
DEBIT,11/05/2026,"CAPITAL ONE AUTOPAY PYMT",-150.00,ACH_DEBIT,-439.92,,
DEBIT,11/02/2026,"STARBUCKS STORE 0412",-3.83,DEBIT_CARD,-289.92,,
DEBIT,11/02/2026,"STARBUCKS STORE 0412",-3.83,DEBIT_CARD,-286.09,,
`;

const CAPITAL_ONE = `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-11-03,2026-11-04,1234,KROGER #415,Grocery,14.20,
2026-11-02,2026-11-03,1234,TACO BELL #3321,Dining,10.05,
2026-11-01,2026-11-02,1234,CAPITAL ONE MOBILE PYMT,Payment/Credit,,150.00
2026-10-30,2026-10-31,1234,EXXONMOBIL 4411,Gas/Automotive,38.40,
`;

const DISCOVER = `Trans. Date,Post Date,Description,Amount,Category
11/02/2026,11/03/2026,"TARGET 00012345 ATLANTA GA",23.15,"Merchandise"
11/01/2026,11/01/2026,"INTERNET PAYMENT - THANK YOU",-150.00,"Payments and Credits"
10/31/2026,11/01/2026,"PANERA BREAD #601234",14.40,"Restaurants"
`;

const BOFA = `Description,,Summary Amt.
Beginning balance as of 10/01/2026,,"1,234.56"
Total credits,,"2,000.00"

Date,Description,Amount,Running Bal.
10/01/2026,Beginning balance as of 10/01/2026,,"1,234.56"
10/03/2026,"KROGER #123 ATLANTA GA","-21.50","1,213.06"
10/04/2026,"PAYROLL DIRECT DEP","2,000.00","3,213.06"
`;

const WELLS_HEADERLESS = `"11/03/2026","-40.00","*","","PURCHASE AUTHORIZED ON 11/02 SHELL OIL 57444 ATLANTA GA S586306123 CARD 1234"
"11/02/2026","-9.10","*","","PURCHASE AUTHORIZED ON 11/01 TACO BELL 1234 ATLANTA GA S386306123 CARD 1234"
"11/01/2026","2000.00","*","","ACME PAYROLL"
`;

const NAVY_INDICATOR = `Posting Date,Transaction Date,Amount,Credit Debit Indicator,type,Description,Category
11/04/2026,11/03/2026,45.10,Debit,Point of Sale,SHELL OIL 57444,Gas
11/02/2026,11/02/2026,2000.00,Credit,Deposit,ACME PAYROLL,Income
`;

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>00012345678</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261104120000<TRNAMT>-45.10<FITID>A1<NAME>SHELL OIL 57444<MEMO>ATLANTA GA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-52.37<FITID>A2<NAME>WAL-MART #1234</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261101<TRNAMT>2000.00<FITID>A3<NAME>ACME PAYROLL</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

function doImport(d: AppData, text: string) {
  const parsed = parseStatement(text, d.bank.profiles);
  const plan = planImport(d, parsed, TODAY);
  const counts = applyImport(d, plan, '2026-11-06T12:00:00Z');
  return { parsed, plan, counts };
}

describe('reading statement files', () => {
  it('parses money and dates the way banks write them', () => {
    expect(parseAmountCell('$1,234.56')).toBe(1234.56);
    expect(parseAmountCell('(12.34)')).toBe(-12.34);
    expect(parseAmountCell('12.34-')).toBe(-12.34);
    expect(parseAmountCell('12,34')).toBe(12.34);
    expect(parseAmountCell('*')).toBeNull();
    expect(parseDateCell('11/03/2026')).toBe('2026-11-03');
    expect(parseDateCell('2026-11-03')).toBe('2026-11-03');
    expect(parseDateCell('Nov 3, 2026')).toBe('2026-11-03');
    expect(parseDateCell('03/11/2026', 'dmy')).toBe('2026-11-03');
  });

  it('reads a checking account where money out is negative', () => {
    const p = parseStatement(CHASE_CHECKING);
    expect(p.format).toBe('csv');
    expect(p.needsCheck).toBe(true);
    expect(p.txns).toHaveLength(11);
    const shell = p.txns[0];
    expect(shell).toMatchObject({ date: '2026-11-04', flow: -45.1, description: 'SHELL OIL 57444 ATLANTA GA' });
    expect(p.txns.find((t) => /PAYROLL/.test(t.description))!.flow).toBe(2000);
  });

  it('reads separate money-out and money-in columns', () => {
    const p = parseStatement(CAPITAL_ONE);
    expect(p.txns.map((t) => t.flow)).toEqual([-14.2, -10.05, 150, -38.4]);
    expect(p.txns[0]).toMatchObject({ date: '2026-11-03', bankCategory: 'Grocery' });
  });

  it('reads a card file where purchases are positive', () => {
    const p = parseStatement(DISCOVER);
    expect(p.profile!.outNegative).toBe(false);
    expect(p.txns.map((t) => t.flow)).toEqual([-23.15, 150, -14.4]);
  });

  it('skips summary lines above the real header', () => {
    const p = parseStatement(BOFA);
    expect(p.txns.map((t) => [t.date, t.flow])).toEqual([['2026-10-03', -21.5], ['2026-10-04', 2000]]);
  });

  it('reads a file without a header row', () => {
    const p = parseStatement(WELLS_HEADERLESS);
    expect(p.txns.map((t) => t.flow)).toEqual([-40, -9.1, 2000]);
    expect(describeMerchant(p.txns[0].description).name).toBe('Shell');
  });

  it('uses a Debit/Credit column when every amount is positive', () => {
    const p = parseStatement(NAVY_INDICATOR);
    expect(p.txns.map((t) => [t.date, t.flow])).toEqual([['2026-11-03', -45.1], ['2026-11-02', 2000]]);
  });

  it('reads QFX/OFX downloads', () => {
    const p = parseStatement(OFX);
    expect(p.format).toBe('ofx');
    expect(p.account).toBe('5678');
    expect(p.txns.map((t) => [t.date, t.flow, t.fitid])).toEqual([['2026-11-04', -45.1, 'A1'], ['2026-11-03', -52.37, 'A2'], ['2026-11-01', 2000, 'A3']]);
  });

  it('remembers a layout once you confirm it', () => {
    const p = parseStatement(CHASE_CHECKING);
    const again = parseStatement(CHASE_CHECKING, [p.profile!]);
    expect(again.needsCheck).toBe(false);
  });
});

describe('store names', () => {
  it('cleans bank text into store names and kinds', () => {
    expect(describeMerchant('SQ *SHELL OIL 57444 ATLANTA GA')).toMatchObject({ name: 'Shell', key: 'shell', kind: 'gas' });
    expect(describeMerchant('WAL-MART SUPERCENTER #1234')).toMatchObject({ name: 'Walmart', key: 'walmart' });
    expect(describeMerchant('walmart food')).toMatchObject({ key: 'walmart' });
    expect(describeMerchant('TST* JOES COFFEE 0423 ATLANTA GA')).toMatchObject({ name: 'Joes Coffee', key: 'joes' });
    expect(describeMerchant('KROGER FUEL CTR #415')).toMatchObject({ key: 'krogerfuel', kind: 'gas' });
    expect(describeMerchant('gas station food')).toMatchObject({ key: '', kind: 'gas' });
    expect(describeMerchant('panarabread').key).toBe('panerabread');
    expect(describeMerchant('ONLINE TRANSFER TO SAV XXXX9911').kind).toBe('transfer');
    expect(describeMerchant('ZELLE PAYMENT TO JOHN').kind).toBe('p2p');
    expect(describeMerchant('ATM WITHDRAWAL 1234 MAIN ST').kind).toBe('atm');
  });
});

describe('learning budgets from your logs', () => {
  const d = sampleData();
  const model = buildModel(d, TODAY);
  const gas = describeMerchant('RACETRAC 2210');

  it('files a gas station fill-up as Gas and a snack as Groceries, and asks in between', () => {
    expect(predict(model, gas, 45)).toMatchObject({ auto: true, basis: 'kind', suggestions: [{ extraId: 'gas' }, expect.anything()] });
    expect(predict(model, gas, 4)).toMatchObject({ auto: true, suggestions: [{ extraId: 'groc' }, expect.anything()] });
    expect(predict(model, gas, 10).auto).toBe(false);
  });

  it('files a store you always file the same way at any amount', () => {
    const p = predict(model, describeMerchant('TACO BELL #031234'), 40);
    expect(p).toMatchObject({ auto: true, basis: 'store' });
    expect(p.suggestions[0].extraId).toBe('ff');
  });

  it('asks about a store it has never seen', () => {
    const p = predict(model, describeMerchant('JOES BARBER 1123'), 25);
    expect(p.auto).toBe(false);
    expect(p.basis).toBe('none');
  });

  it('learns from your corrections', () => {
    const d2 = sampleData();
    for (let i = 0; i < 6; i++) d2.spendEntries.push({ id: `t${i}`, extraId: 'ff', extraName: 'ff', amount: 12, entryType: 'spend', date: '2026-11-0' + (i + 1), note: 'Kroger', createdAt: '', merchant: 'Kroger', merchantKey: 'kroger' });
    expect(predict(buildModel(d2, TODAY), describeMerchant('KROGER #1'), 12).suggestions[0].extraId).toBe('ff');
  });
});

describe('importing', () => {
  it('files what it is sure of, skips money that is not spending, and leaves the rest for review', () => {
    const d = sampleData();
    const { plan, counts } = doImport(d, CHASE_CHECKING);
    const by = (re: RegExp) => plan.items.find((i) => re.test(i.txn.description))!;
    expect(by(/^SHELL OIL/)).toMatchObject({ action: 'log', extraId: 'gas' });
    expect(by(/SQ \*SHELL/)).toMatchObject({ action: 'log', extraId: 'groc' });
    expect(by(/WAL-MART/)).toMatchObject({ action: 'log', extraId: 'groc' });
    expect(by(/TACO BELL/)).toMatchObject({ action: 'log', extraId: 'ff' });
    expect(by(/RACETRAC/).action).toBe('review');
    expect(by(/PAYROLL/).txn.how).toBe('paycheck');
    expect(by(/TRANSFER/).txn.how).toBe('transfer');
    expect(by(/AUTOPAY/).txn.how).toBe('card payment');
    expect(by(/NETFLIX/).txn.how).toBe('bill:Netflix');
    expect(counts.logged).toBe(4);
    expect(reviewTxns(d).length).toBe(counts.review);
    const shellLog = d.spendEntries.find((e) => e.bankTxnId && /Shell/.test(e.note) && e.amount === 45.1)!;
    expect(shellLog).toMatchObject({ extraId: 'gas', date: '2026-11-04', merchantKey: 'shell' });
  });

  it('never adds the same file twice, even with overlapping dates', () => {
    const d = sampleData();
    const first = doImport(d, CHASE_CHECKING);
    const before = d.spendEntries.length;
    const again = doImport(d, CHASE_CHECKING);
    expect(again.plan.items).toHaveLength(0);
    expect(again.plan.alreadyImported).toBe(first.parsed.txns.length);
    expect(d.spendEntries.length).toBe(before);
    // A later download that overlaps the first one only adds what's new.
    const later = CHASE_CHECKING + 'DEBIT,11/07/2026,"KROGER #123 ATLANTA GA",-14.00,DEBIT_CARD,100.00,,\n';
    const third = doImport(d, later);
    expect(third.plan.items.map((i) => i.txn.description)).toEqual(['KROGER #123 ATLANTA GA']);
  });

  it('keeps two identical purchases on the same day as two', () => {
    const d = sampleData();
    const { plan } = doImport(d, CHASE_CHECKING);
    expect(plan.items.filter((i) => /STARBUCKS/.test(i.txn.description))).toHaveLength(2);
    const p = parseStatement(CHASE_CHECKING);
    const ids = txnIds(p.txns);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('links a purchase you already logged instead of adding it again', () => {
    const d = sampleData();
    d.spendEntries.push({ id: 'mine', extraId: 'gas', extraName: 'Gas', amount: 45.1, entryType: 'spend', date: '2026-11-03', note: '', createdAt: '' });
    const { plan } = doImport(d, CHASE_CHECKING);
    const shell = plan.items.find((i) => /^SHELL OIL/.test(i.txn.description))!;
    expect(shell).toMatchObject({ action: 'match', matchEntryId: 'mine' });
    expect(d.spendEntries.filter((e) => e.amount === 45.1 && e.date.startsWith('2026-11'))).toHaveLength(1);
    expect(d.spendEntries.find((e) => e.id === 'mine')!.merchantKey).toBe('shell');
  });

  it('asks when a log of yours is close but not exact (like a tip)', () => {
    const d = sampleData();
    d.spendEntries.push({ id: 'mine', extraId: 'ff', extraName: 'Fast Food', amount: 10.5, entryType: 'spend', date: '2026-11-03', note: 'Taco Bell', createdAt: '' });
    const { plan } = doImport(d, CHASE_CHECKING);
    const tb = plan.items.find((i) => /TACO BELL/.test(i.txn.description))!;
    expect(tb.action).toBe('review');
    expect(tb.txn.maybeSameAs).toBe('mine');
  });

  it('asks about a log of yours dated days away from the purchase, and leaves older ones alone', () => {
    const d = sampleData();
    d.spendEntries.push({ id: 'late', extraId: 'groc', extraName: 'Groceries', amount: 52.37, entryType: 'spend', date: '2026-11-12', note: 'walmart', createdAt: '' });
    d.spendEntries.push({ id: 'old', extraId: 'ff', extraName: 'Fast Food', amount: 12.48, entryType: 'spend', date: '2026-10-15', note: 'taco bell', createdAt: '' });
    const { plan } = doImport(d, CHASE_CHECKING);
    const wm = plan.items.find((i) => /WAL-MART/.test(i.txn.description))!;
    expect(wm).toMatchObject({ action: 'review' });
    expect(wm.txn.maybeSameAs).toBe('late');
    const tb = plan.items.find((i) => /TACO BELL/.test(i.txn.description))!;
    expect(tb.txn.maybeSameAs).toBeUndefined();
  });

  it('recognizes the same purchases downloaded once as CSV and once as QFX', () => {
    const d = sampleData();
    doImport(d, CHASE_CHECKING);
    const n = d.spendEntries.length;
    const { plan } = doImport(d, OFX);
    expect(plan.items).toHaveLength(0);
    expect(plan.alreadyImported).toBe(3);
    expect(d.spendEntries.length).toBe(n);
  });

  it('leaves pending transactions out', () => {
    const d = sampleData();
    const csv = 'Date,Description,Amount,Status\n11/04/2026,SHELL OIL 57444,-99.00,Pending\n11/05/2026,SHELL OIL 57444,-43.12,Posted\n';
    const { plan } = doImport(d, csv);
    expect(plan.pending).toBe(1);
    expect(plan.items.map((i) => i.txn.amount)).toEqual([-43.12]);
  });

  it('files, splits, skips and links from the review list', () => {
    const d = sampleData();
    doImport(d, CHASE_CHECKING);
    const race = reviewTxns(d).find((t) => /RACETRAC/.test(t.description))!;
    expect(fileTxn(d, race.id, [{ extraId: 'gas', amount: 8 }, { extraId: 'groc', amount: 3.5 }], 'now')).toBe(true);
    const parts = d.spendEntries.filter((e) => e.bankTxnId === race.id);
    expect(parts.map((e) => [e.extraId, e.amount])).toEqual([['gas', 8], ['groc', 3.5]]);
    expect(fileTxn(d, race.id, [{ extraId: 'gas', amount: 5 }], 'now')).toBe(false); // must add up
    // Re-filing replaces the split.
    fileTxn(d, race.id, [{ extraId: 'gas', amount: 11.5 }], 'now');
    expect(d.spendEntries.filter((e) => e.bankTxnId === race.id).map((e) => e.amount)).toEqual([11.5]);
    // Not spending, and always skip this store.
    skipTxn(d, race.id, true);
    expect(d.spendEntries.some((e) => e.bankTxnId === race.id)).toBe(false);
    expect(d.bank.rules).toEqual([{ key: 'racetrac', name: 'RaceTrac', action: 'skip' }]);
    const csv = 'Date,Description,Amount\n11/09/2026,RACETRAC 2210 DECATUR GA,-20.00\n';
    expect(planImport(d, parseStatement(csv), TODAY).items[0].txn.how).toBe('rule');
  });

  it('linking to your own log never deletes it', () => {
    const d = sampleData();
    d.spendEntries.push({ id: 'mine', extraId: 'ff', extraName: 'Fast Food', amount: 10.5, entryType: 'spend', date: '2026-11-03', note: 'Taco Bell', createdAt: '' });
    doImport(d, CHASE_CHECKING);
    const tb = reviewTxns(d).find((t) => /TACO BELL/.test(t.description))!;
    linkTxn(d, tb.id, 'mine');
    skipTxn(d, tb.id);
    expect(d.spendEntries.find((e) => e.id === 'mine')).toBeTruthy();
    expect(d.spendEntries.find((e) => e.id === 'mine')!.bankTxnId).toBeUndefined();
  });

  it('turns a store refund into a refund in the budget you use there', () => {
    const d = sampleData();
    const csv = 'Date,Description,Amount\n11/04/2026,TACO BELL #031234 REFUND,12.48\n';
    const { plan } = doImport(d, csv);
    expect(plan.items[0]).toMatchObject({ action: 'log', extraId: 'ff', refund: true });
    expect(d.spendEntries.at(-1)).toMatchObject({ amount: -12.48, entryType: 'refund' });
  });
});

describe('bills in an import', () => {
  const csv = (rows: string[]) => `Date,Description,Amount\n${rows.join('\n')}\n`;

  it('asks about a charge that names a bill but not its amount, and knows it next time', () => {
    const d = sampleData();
    d.bills.push({ id: 'host', name: 'Hostly', amount: 2.75, rule: { type: 'monthly_dom', dom: 20 } });
    const first = doImport(d, csv(['10/06/2026,HOSTLY SERVERS 800-555-0100 PAUS,-14.20'])).plan.items[0];
    expect(first.action).toBe('review');
    expect(first.txn.billGuess).toEqual({ id: 'host', name: 'Hostly', amount: 2.75 });
    const t = d.bank.txns.find((x) => x.id === first.txn.id)!;
    expect(billChoices(d, t)[0]).toMatchObject({ bill: { id: 'host' }, likely: true });
    expect(namedBill(d, { ...t, billGuess: undefined })?.id).toBe('host');
    expect(markAsBill(d, t.id, 'host')).toBe(true);
    expect(d.bank.txns.find((x) => x.id === t.id)).toMatchObject({ status: 'skipped', how: 'bill:Hostly', billId: 'host' });
    expect(d.bank.billLinks).toEqual([{ billId: 'host', text: 'hostly servers', amount: 14.2 }]);
    expect(d.bills.find((b) => b.id === 'host')!.amount).toBe(2.75);
    const next = doImport(d, csv(['11/06/2026,HOSTLY SERVERS 800-555-0100 PAUS,-14.20'])).plan.items[0];
    expect(next).toMatchObject({ action: 'skip', txn: { how: 'bill:Hostly', billId: 'host' } });
  });

  it('can change the bill to the charged amount, or add a new bill made from the charge', () => {
    const d = sampleData();
    d.bills.push({ id: 'host', name: 'Hostly', amount: 2.75, rule: { type: 'monthly_dom', dom: 20 } });
    const [a, b] = doImport(d, csv(['10/06/2026,HOSTLY SERVERS 800-555-0100 PAUS,-14.20', '10/24/2026,STREAMBOX* PLUS SUB STREAMBOX.COM CAUS,-19.50'])).plan.items;
    markAsBill(d, a.txn.id, 'host', { updateAmount: true });
    expect(d.bills.find((x) => x.id === 'host')!.amount).toBe(14.2);
    expect(b.action).toBe('review');
    markAsBill(d, b.txn.id, { id: 'new1', name: 'Streambox', amount: 19.5, rule: { type: 'monthly_dom', dom: 24 } });
    expect(d.bills.find((x) => x.id === 'new1')).toMatchObject({ name: 'Streambox', amount: 19.5 });
    expect(d.order.bills).toContain('new1');
    expect(d.bank.txns.find((x) => x.id === b.txn.id)).toMatchObject({ status: 'skipped', how: 'bill:Streambox' });
    const next = doImport(d, csv(['11/24/2026,STREAMBOX* PLUS SUB STREAMBOX.COM CAUS,-19.50'])).plan.items[0];
    expect(next.txn.how).toBe('bill:Streambox');
  });

  it('keeps two bills that share bank text apart by amount', () => {
    const d = sampleData();
    const [a, b] = doImport(d, csv(['10/24/2026,STREAMBOX* PLUS SUB STREAMBOX.COM CAUS,-79.00', '10/24/2026,STREAMBOX* PLUS SUB STREAMBOX.COM CAUS,-19.50'])).plan.items;
    markAsBill(d, a.txn.id, { id: 'big', name: 'Streambox Max', amount: 79, rule: { type: 'monthly_dom', dom: 24 } });
    markAsBill(d, b.txn.id, { id: 'small', name: 'Streambox Extra', amount: 19.5, rule: { type: 'monthly_dom', dom: 24 } });
    expect(d.bank.billLinks).toHaveLength(2);
    const items = doImport(d, csv(['11/24/2026,STREAMBOX* PLUS SUB STREAMBOX.COM CAUS,-79.00', '11/24/2026,STREAMBOX* PLUS SUB STREAMBOX.COM CAUS,-19.50'])).plan.items;
    expect(items.map((i) => i.txn.how).sort()).toEqual(['bill:Streambox Extra', 'bill:Streambox Max']);
  });

  it("remembers a bill by its own words, so other purchases at the same store aren't hidden", () => {
    const d = sampleData();
    d.bills.push({ id: 'club', name: 'Membership', amount: 15.49, rule: { type: 'monthly_dom', dom: 13 } });
    const [m] = doImport(d, csv(['10/13/2026,AMAZON PRIME*AB12CD34E AMZN.COM/BILL WAUS,-15.49'])).plan.items;
    markAsBill(d, m.txn.id, 'club');
    expect(d.bank.billLinks?.[0].text).toBe('amazon prime');
    const items = doImport(d, csv(['11/13/2026,AMAZON PRIME*X1Y2Z3 AMZN.COM/BILL WAUS,-15.49', '11/02/2026,AMAZON.COM*ZZ98YY76X AMZN.COM/BILL WAUS,-15.99'])).plan.items;
    expect(items.find((i) => /PRIME/.test(i.txn.description))!.txn.how).toBe('bill:Membership');
    expect(items.find((i) => /ZZ98YY76X/.test(i.txn.description))!.txn.how).not.toMatch(/^bill/);
  });
});
