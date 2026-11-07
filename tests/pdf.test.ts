import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { makeDefaultData } from '../src/data/defaults';
import { applyImport, planImport } from '../src/engine/bank/importer';
import { extractItems, isPdfBytes } from '../src/engine/bank/pdfItems';
import { dateValue, moneyValue, parsePdfStatement, type PdfItem } from '../src/engine/bank/pdfStatement';
import type { AppData, SpendEntry } from '../src/engine/types';

// Made-up statements laid out like real ones. [x, y, font size, text]; y counts up from the bottom of the page.
type T = [number, number, number, string];

const head = (y: number, xs: number[], size = 7.2): T[] => ['TRANSACTION DATE', 'DESCRIPTION', 'TYPE', 'AMOUNT', 'SETTLEMENT DATE'].map((t, i) => [xs[i], y, size, t]);
/** A row like Chime prints it: date, store name with the bank's own text under it, type, amount, settlement date. */
const row = (y: number, xs: number[], date: string, name: string, type: string, amount: string, raw?: string): T[] => [
  [xs[0], y, 7.2, date], [xs[1], y, 7.2, name], ...(raw ? [[xs[1], y - 10.2, 6, raw] as T] : []),
  [xs[2], y, 7.2, type], [xs[3] + 28 - amount.length * 3.1, y, 7.2, amount], [xs[4] + 6, y, 7.2, date],
];
const PAY = [31.5, 161.2, 359.8, 432.8, 466.9];
const TXN = [31.5, 148.1, 354.4, 443.0, 477.1];
const FEE = [31.5, 155.3, 390.3, 438.2, 472.3];
const SEC = [31.5, 173.8, 343.1, 423.2, 457.3];

const CARD_STATEMENT: T[][] = [
  [
    [28.5, 800, 7.8, 'Member Services'],
    [28.5, 657, 16.7, 'Credit Builder Card Account Billing Statement'],
    [28.5, 633.7, 9, 'Account number'], [107.4, 633.7, 9, 'Routing number (for payments)'],
    [28.5, 622.3, 9, '000011112222'], [107.4, 622.3, 9, '123456789'],
    [28.5, 602, 9, 'Statement period'],
    [28.5, 590.6, 9, 'October 2026'], [80.5, 590.6, 7.8, '(September 29th, 2026 - October 28th, 2026)'],
    [28.5, 529, 9, 'Summary'], [350.9, 529, 9, 'Your Payment'],
    [28.5, 511.7, 7.8, 'Previous Balance'], [200.7, 511.7, 7.8, '$512.00'], [350.9, 511.7, 7.8, 'Payment Due Date'], [529.1, 511.7, 7.8, '11/24/2026'],
    [28.5, 496.7, 7.8, 'New spending'], [206.7, 496.7, 7.8, '$115.09'],
    [350.9, 453.7, 7.8, 'Your October balance is scheduled to be paid on 10/31/2026 using'],
    [350.9, 441.7, 7.8, 'the money in your secured account.'],
    [28.5, 397.4, 9, 'Payments'],
    ...head(379.5, PAY),
    ...row(362.7, PAY, '9/30/2026', 'Card Payment from Secured Account', 'Payment', '-$500.00'),
    ...row(346.6, PAY, '9/29/2026', 'Store Refund Co', 'Refund', '-$12.00', 'STORE REFUND CO #12 SOMEWHERE TNUS'),
    [31.5, 319.7, 7.2, 'TOTAL FOR THIS PERIOD:'], [161.2, 319.7, 7.2, '-$512.00'],
    [28.5, 291, 9, 'Transactions'],
    ...head(273, TXN),
    ...row(256.3, TXN, '10/25/2026', 'Kroger', 'Purchase', '$40.00', 'KROGER #123 ANYTOWN TNUS'),
    ...row(230, TXN, '10/24/2026', 'Shell Oil', 'Purchase', '$35.10', 'SHELL OIL 57444 ANYTOWN TNUS'),
    ...row(203.6, TXN, '10/20/2026', 'Taco Bell', 'Purchase', '$9.99', 'TACO BELL #999 ANYTOWN TNUS'),
    [269.2, 10.2, 10, 'Page 1 of 3'],
  ],
  [
    ...row(802.4, TXN, '10/18/2026', 'Cash Advance - Out Of Network Atm Withdrawal', 'ATM Withdrawal', '$20.00', 'SOME ATM 1 MAIN ST ANYTOWN TNUS'),
    ...row(776, TXN, '10/02/2026', "Abc*Gold's Gym Anytown", 'Purchase', '$7.00', "ABC*GOLD'S GYM ANYTOWN 555-5555555 TNUS"),
    [31.5, 749.7, 7.2, 'TOTAL FOR THIS PERIOD:'], [148.1, 749.7, 7.2, '$112.09'],
    [28.5, 720, 9, 'Fees'],
    ...head(702, FEE),
    ...row(685, FEE, '10/18/2026', 'Cash Advance - Out Of Network Atm Withdrawal Fee', 'Fee', '$3.00', 'SOME ATM 1 MAIN ST ANYTOWN TNUS'),
    [31.5, 655, 7.2, 'TOTAL FOR THIS PERIOD:'], [155.3, 655, 7.2, '$3.00'],
    [28.5, 620, 9, 'Disputed transactions'],
    ...head(602, [31.5, 209.1, 312.6, 395.7, 429.8]),
    [31.5, 585, 7.2, 'TOTAL FOR THIS PERIOD:'], [209.1, 585, 7.2, '$0.00'],
    [28.5, 560, 9, '2026 Fees Totals Year to Date'],
    [31.5, 540, 9.6, 'Total fees in 2026'], [188.2, 540, 9.6, '$6.00'],
    [28.5, 500, 7.8, 'Questions? Contact Chime Member Services.'],
    [269.2, 10.2, 10, 'Page 2 of 3'],
  ],
  [
    [28.5, 793.4, 16.7, 'Credit Builder Secured Account Billing Statement'],
    [28.5, 770.1, 9, 'Account number'],
    [28.5, 758.7, 9, '000033334444'],
    [28.5, 648.1, 7.8, 'Beginning balance on September 29, 2026'], [200.7, 648.1, 7.8, '$2,000.00'],
    [28.5, 534.4, 9, 'Transactions'],
    ...head(516.5, SEC),
    ...row(499.7, SEC, '9/29/2026', 'Transfer from Checking Account', 'Transfer', '$1,000.00'),
    ...row(483.6, SEC, '9/30/2026', 'Credit Builder Payment', 'Transfer', '-$500.00'),
    ...row(467.4, SEC, '10/01/2026', 'Transfer to Checking Account', 'Transfer', '-$100.00'),
    [31.5, 440, 7.2, 'TOTAL FOR THIS PERIOD:'], [173.8, 440, 7.2, '$400.00'],
    [269.2, 10.2, 10, 'Page 3 of 3'],
  ],
];

/** Positioned text as pdf.js would give it (widths estimated). */
const toItems = (pages: T[][]): PdfItem[][] => pages.map((p) => p.map(([x, y, size, str]) => ({ str, x, y, size, w: str.length * size * 0.5 })));

/** A real (tiny) PDF file with this text, in Helvetica. */
function makePdf(pages: T[][]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((items, i) => {
    const content = items.map(([x, y, size, text]) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(text)}) Tj ET`).join('\n');
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 841] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objs[pageIds[i] + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) { offsets[id] = out.length; out += `${id} 0 obj\n${objs[id]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const brief = (p: ReturnType<typeof parsePdfStatement>) => p.txns.map((t) => [t.date, t.flow, t.description, t.memo ?? '', t.account ?? '', t.kindHint ?? '']);

const EXPECTED_CARD = [
  ['2026-09-30', 500, 'Card Payment from Secured Account', '', '2222', 'cardPayment'],
  ['2026-09-29', 12, 'Store Refund Co', 'STORE REFUND CO #12 SOMEWHERE TNUS', '2222', ''],
  ['2026-10-25', -40, 'Kroger', 'KROGER #123 ANYTOWN TNUS', '2222', ''],
  ['2026-10-24', -35.1, 'Shell Oil', 'SHELL OIL 57444 ANYTOWN TNUS', '2222', ''],
  ['2026-10-20', -9.99, 'Taco Bell', 'TACO BELL #999 ANYTOWN TNUS', '2222', ''],
  ['2026-10-18', -20, 'Cash Advance - Out Of Network Atm Withdrawal', 'SOME ATM 1 MAIN ST ANYTOWN TNUS', '2222', 'atm'],
  ['2026-10-02', -7, "Abc*Gold's Gym Anytown", "ABC*GOLD'S GYM ANYTOWN 555-5555555 TNUS", '2222', ''],
  ['2026-10-18', -3, 'Cash Advance - Out Of Network Atm Withdrawal Fee', 'SOME ATM 1 MAIN ST ANYTOWN TNUS', '2222', 'fee'],
  ['2026-09-29', 1000, 'Transfer from Checking Account', '', '4444', 'transfer'],
  ['2026-09-30', -500, 'Credit Builder Payment', '', '4444', 'transfer'],
  ['2026-10-01', -100, 'Transfer to Checking Account', '', '4444', 'transfer'],
];

describe('PDF statements', () => {
  it('reads a Chime-style card and secured account statement', () => {
    const p = parsePdfStatement(toItems(CARD_STATEMENT));
    expect(p.format).toBe('pdf');
    expect(brief(p)).toEqual(EXPECTED_CARD);
    expect(p.pdf).toEqual({ bank: 'Chime', accounts: ['2222', '4444'], tables: 4, checked: 4, matched: 4, from: '2026-09-29', to: '2026-10-25' });
    expect(p.txns.every((t) => t.source === 'pdf')).toBe(true);
  });

  it('reads the same statement from a real PDF file', async () => {
    const bytes = makePdf(CARD_STATEMENT);
    expect(isPdfBytes(bytes)).toBe(true);
    const p = parsePdfStatement(await extractItems(pdfjs, bytes));
    expect(brief(p)).toEqual(EXPECTED_CARD);
    expect(p.pdf?.matched).toBe(4);
  });

  it('notices when a table does not add up to its total', () => {
    const pages = CARD_STATEMENT.map((p) => p.map((t) => (t[3] === '$112.09' ? [t[0], t[1], t[2], '$150.00'] as T : t)));
    const p = parsePdfStatement(toItems(pages));
    expect(p.pdf).toMatchObject({ checked: 4, matched: 3 });
  });

  it('reads bank statements with sections, dates without a year and unsigned amounts', () => {
    const xs = [40, 110, 520];
    const hdr = (y: number): T[] => [[xs[0], y, 8, 'DATE'], [xs[1], y, 8, 'DESCRIPTION'], [xs[2], y, 8, 'AMOUNT']];
    const r = (y: number, d: string, desc: string, amt: string): T[] => [[xs[0], y, 8, d], [xs[1], y, 8, desc], [xs[2] + 4, y, 8, amt]];
    const pages: T[][] = [[
      [40, 780, 14, 'Everyday Checking Statement'],
      [40, 760, 8, 'Account number: ****9876'],
      [40, 748, 8, 'December 15, 2026 through January 14, 2027'],
      [40, 700, 10, 'DEPOSITS AND ADDITIONS'],
      ...hdr(686),
      ...r(672, '12/26', 'ACME CORP PAYROLL PPD ID 123', '1,500.00'),
      ...r(660, '01/09', 'ACME CORP PAYROLL PPD ID 123', '1,500.00'),
      [40, 646, 8, 'Total Deposits and Additions'], [520, 646, 8, '$3,000.00'],
      [40, 620, 10, 'ELECTRONIC WITHDRAWALS'],
      ...hdr(606),
      ...r(592, '12/20', 'ONLINE PAYMENT TO CREDIT CARD 1234', '200.00'),
      ...r(580, '01/05', 'WALMART #1234 ANYTOWN TN', '45.10'),
      [110, 570, 7, 'Card purchase 01/04'],
      ...r(556, 'Jan 6', 'COFFEE HOUSE', '4.25'),
      [40, 542, 8, 'Total Electronic Withdrawals'], [520, 542, 8, '$249.35'],
    ]];
    const p = parsePdfStatement(toItems(pages));
    expect(brief(p)).toEqual([
      ['2026-12-26', 1500, 'ACME CORP PAYROLL PPD ID 123', '', '9876', ''],
      ['2027-01-09', 1500, 'ACME CORP PAYROLL PPD ID 123', '', '9876', ''],
      ['2026-12-20', -200, 'ONLINE PAYMENT TO CREDIT CARD 1234', '', '9876', ''],
      ['2027-01-05', -45.1, 'WALMART #1234 ANYTOWN TN', 'Card purchase 01/04', '9876', ''],
      ['2027-01-06', -4.25, 'COFFEE HOUSE', '', '9876', ''],
    ]);
    expect(p.pdf).toMatchObject({ checked: 2, matched: 2 });
  });

  it('reads money out / money in columns and skips balance lines', () => {
    const xs = { date: 40, desc: 100, out: 400, in: 460, bal: 520 };
    const pages: T[][] = [[
      [40, 780, 14, 'Savings Account Statement'],
      [xs.date, 700, 8, 'Date'], [xs.desc, 700, 8, 'Description'], [xs.out, 700, 8, 'Withdrawals'], [xs.in, 700, 8, 'Deposits'], [xs.bal, 700, 8, 'Balance'],
      [xs.date, 686, 8, '10/01/2026'], [xs.desc, 686, 8, 'Beginning balance'], [xs.bal, 686, 8, '1,000.00'],
      [xs.date, 674, 8, '10/03/2026'], [xs.desc, 674, 8, 'COFFEE SHOP'], [xs.out + 10, 674, 8, '4.50'], [xs.bal, 674, 8, '995.50'],
      [xs.date, 662, 8, '10/04/2026'], [xs.desc, 662, 8, 'REFUND FROM STORE'], [xs.in + 6, 662, 8, '10.00'], [xs.bal, 662, 8, '1,005.50'],
      [xs.date, 650, 8, '10/05/2026'], [xs.desc, 650, 8, 'SERVICE FEE'], [xs.out + 10, 650, 8, '5.00 DR'], [xs.bal, 650, 8, '1,000.50'],
    ]];
    expect(brief(parsePdfStatement(toItems(pages)))).toEqual([
      ['2026-10-03', -4.5, 'COFFEE SHOP', '', '', ''],
      ['2026-10-04', 10, 'REFUND FROM STORE', '', '', ''],
      ['2026-10-05', -5, 'SERVICE FEE', '', '', ''],
    ]);
  });

  it('explains PDFs it cannot read', () => {
    expect(() => parsePdfStatement([[]])).toThrow(/no text/);
    expect(() => parsePdfStatement(toItems([[[40, 700, 10, 'Thanks for banking with us']]]))).toThrow(/Couldn't find a list of transactions/);
  });

  it('reads dates and money the way statements print them', () => {
    expect(dateValue('10/25/2026')).toBe('2026-10-25');
    expect(dateValue('9/30/26')).toBe('2026-09-30');
    expect(dateValue('Oct 25, 2026')).toBe('2026-10-25');
    expect(dateValue('12/20', { y: 2027, m: 1 })).toBe('2026-12-20');
    expect(dateValue('25 Oct', { y: 2026, m: 10 })).toBe('2026-10-25');
    expect(dateValue('TRANSACTION DATE')).toBeNull();
    expect(dateValue('Purchase 25')).toBeNull();
    expect(moneyValue('-$2,345.67')).toEqual({ v: -2345.67 });
    expect(moneyValue('(45.10)')).toEqual({ v: -45.1 });
    expect(moneyValue('45.10 CR')).toEqual({ v: 45.1, marker: 'cr' });
    expect(moneyValue('$22.49 10/25/2026')).toEqual({ v: 22.49 });
    expect(moneyValue('(844) 244-6363')).toBeNull();
    expect(moneyValue('29.99%')).toBeNull();
    expect(moneyValue('1234')).toBeNull();
  });
});

describe('importing a PDF statement', () => {
  function data(): AppData {
    const d = makeDefaultData('2026-11-06');
    d.extras = [
      { id: 'groc', name: 'Groceries', amount: 200, rule: { type: 'perpay' } },
      { id: 'ff', name: 'Fast Food', amount: 60, rule: { type: 'perpay' } },
    ];
    d.order.extras = d.extras.map((x) => x.id);
    d.bills = [{ id: 'gym', name: 'Golds', amount: 7, rule: { type: 'monthly_dom', dom: 2 } }];
    const log = (id: string, extraId: string, amount: number, note: string): SpendEntry => ({ id, extraId, extraName: extraId, amount, entryType: 'spend', date: '2026-08-01', note, createdAt: '' });
    d.spendEntries = [
      ...[11.2, 15.8, 9.9, 13.4, 12.5].map((a, i) => log(`t${i}`, 'ff', a, 'taco bell')),
      ...[40.5, 38.2, 44].map((a, i) => log(`k${i}`, 'groc', a, 'kroger')),
    ];
    return d;
  }

  it('skips transfers, card payments and bills, files known stores, and never adds the same file twice', () => {
    const d = data();
    const parsed = parsePdfStatement(toItems(CARD_STATEMENT));
    const plan = planImport(d, parsed, '2026-11-06');
    const by = (desc: string) => plan.items.find((i) => i.txn.description.includes(desc) || i.txn.merchant.includes(desc))!;
    expect(by('Card Payment').txn.how).toBe('card payment');
    expect(by('Credit Builder Payment').txn.how).toBe('transfer');
    expect(plan.items.filter((i) => i.txn.how === 'transfer')).toHaveLength(3);
    expect(by('GOLD').txn.how).toBe('bill:Golds');
    expect(by('KROGER')).toMatchObject({ action: 'log', extraId: 'groc' });
    expect(by('TACO BELL')).toMatchObject({ action: 'log', extraId: 'ff' });
    expect(by('KROGER').txn.description).toBe('KROGER #123 ANYTOWN TNUS');
    expect(by('ATM fee').txn).toMatchObject({ merchant: 'ATM fee', kind: 'fee', status: 'review' });
    applyImport(d, plan, '2026-11-06T12:00:00Z');
    const again = planImport(d, parsePdfStatement(toItems(CARD_STATEMENT)), '2026-11-06');
    expect(again.items).toHaveLength(0);
    expect(again.alreadyImported).toBe(parsed.txns.length);
  });

  it('treats a new restaurant like the others you go to', () => {
    const d = data();
    const sub: T[][] = [[
      [28.5, 657, 16.7, 'Credit Builder Card Account Billing Statement'],
      ...head(273, TXN),
      ...row(256.3, TXN, '10/16/2026', 'Subway', 'Purchase', '$11.50', 'SUBWAY 12345 ANYTOWN FLUS'),
    ]];
    const plan = planImport(d, parsePdfStatement(toItems(sub)), '2026-11-06');
    expect(plan.items[0]).toMatchObject({ action: 'log', extraId: 'ff' });
    expect(plan.items[0].txn.kind).toBe('restaurant');
  });
});
