/**
 * Reads the transactions in a bank statement PDF (Chime, and other banks that print their transactions as a
 * table). It works on the text and positions pulled out of the file (see pdfItems.ts):
 *  - lines are rebuilt from positions, and each table's column headings ("Transaction date", "Description",
 *    "Type", "Amount", …) say which text is which; a table that runs onto the next page is followed;
 *  - a description that wraps onto more lines (Chime prints the bank text under the store's name) is kept;
 *  - money in or out comes from money in / money out columns, CR/DR marks, the transaction type ("Purchase",
 *    "Refund"), the section ("Deposits", "Fees") or whether it's a card or a bank account statement;
 *  - each table is checked against the statement's own total line when it prints one.
 */
import type { IsoDate } from '../dates';
import type { MerchantKind } from './merchant';
import { MONEY_IN_HINT, parseAmountCell, validDate, type ParsedStatement, type PdfSummary, type RawTxn } from './statement';

/** One piece of text on a page. x/y in PDF units from the bottom left (y grows upward); size is the font size. */
export interface PdfItem { str: string; x: number; y: number; w: number; size: number }

interface Cell { text: string; x0: number; x1: number; size: number }
interface Line { page: number; y: number; size: number; cells: Cell[]; text: string }

type Role = 'date' | 'date2' | 'desc' | 'type' | 'amount' | 'out' | 'in' | 'balance' | 'other';
interface Col { role: Role; x0: number; x1: number }
type Kind = 'card' | 'bank' | undefined;

interface Row {
  date: IsoDate;
  /** As printed, with its sign. */
  shown: number;
  marker?: 'cr' | 'dr';
  /** Set when the amount sat in a money in / money out column. */
  col?: 'out' | 'in';
  desc: string;
  more: string[];
  type: string;
  page: number;
  lastY: number;
  size: number;
}
interface Table { cols: Col[]; section: string; kind: Kind; account?: string; rows: Row[]; totals: number[]; skip: boolean; lastDate?: IsoDate }

const clean = (s: string) => s.replace(/[−‒–—]/g, '-').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- lines ----------

const MONEY_RE = /^[-+(]?\s*[$£€]?\s*[-+]?\d{1,3}(?:[,.]?\d{3})*[.,]\d{2}\)?(?:\s*(?:cr|dr|-))?$/i;
const DATE_RE = /^(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2}|[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,?(?: \d{4})?|\d{1,2} [A-Za-z]{3,9}\.?,?(?: \d{4})?)$/;
const wholeValue = (t: string) => MONEY_RE.test(t) || (DATE_RE.test(t) && !!dateValue(t));

/** Fewest column headings that make up the text ("AMOUNT SETTLEMENT DATE" → AMOUNT | SETTLEMENT DATE), or null. */
function headingParts(words: string[]): number[] | null {
  const n = words.length;
  const best: Array<{ count: number; cut: number } | null> = [{ count: 0, cut: 0 }, ...Array(n).fill(null)];
  for (let j = 1; j <= n; j++) {
    for (let i = Math.max(0, j - 4); i < j; i++) {
      if (!best[i] || !roleOf(words.slice(i, j).join(' '))) continue;
      const c = best[i]!.count + 1;
      if (!best[j] || c < best[j]!.count) best[j] = { count: c, cut: i };
    }
  }
  if (!best[n] || best[n]!.count < 2) return null;
  const cuts: number[] = [];
  for (let j = n; j > 0; j = best[j]!.cut) cuts.unshift(best[j]!.cut);
  return cuts;
}

/**
 * pdf.js joins text that sits close on a line into one piece, so two columns can arrive together
 * ("$22.49 10/25/2026", "AMOUNT SETTLEMENT DATE"). Splits values and headings back apart, placing each part
 * by its share of the text's width.
 */
function splitItem(it: PdfItem): PdfItem[] {
  const toks = [...it.str.matchAll(/\S+/g)].map((m) => ({ t: m[0], s: m.index!, e: m.index! + m[0].length }));
  if (toks.length < 2) return [it];
  const segs: Array<{ s: number; e: number; value: boolean; from: number; to: number }> = [];
  for (let i = 0; i < toks.length;) {
    let k = 0;
    for (const n of [3, 2, 1]) if (!k && i + n <= toks.length && wholeValue(toks.slice(i, i + n).map((x) => x.t).join(' '))) k = n;
    const last = segs[segs.length - 1];
    if (k) { segs.push({ s: toks[i].s, e: toks[i + k - 1].e, value: true, from: i, to: i + k }); i += k; }
    else if (last && !last.value) { last.e = toks[i].e; last.to = i + 1; i++; }
    else { segs.push({ s: toks[i].s, e: toks[i].e, value: false, from: i, to: i + 1 }); i++; }
  }
  const parts: Array<{ s: number; e: number }> = [];
  for (const g of segs) {
    const words = toks.slice(g.from, g.to);
    const cuts = !g.value && words.length > 1 ? headingParts(words.map((w) => w.t)) : null;
    if (!cuts) { parts.push({ s: g.s, e: g.e }); continue; }
    cuts.forEach((c, i) => parts.push({ s: words[c].s, e: words[(cuts[i + 1] ?? words.length) - 1].e }));
  }
  if (parts.length < 2) return [it];
  const len = it.str.length || 1;
  return parts.map((p) => ({ ...it, str: it.str.slice(p.s, p.e), x: it.x + (it.w * p.s) / len, w: (it.w * (p.e - p.s)) / len }));
}

/** Rebuilds lines (top to bottom) and their cells (left to right) from positioned text. */
export function linesOf(pages: PdfItem[][]): Line[] {
  const out: Line[] = [];
  pages.forEach((items, page) => {
    const its = items.filter((i) => i.str && i.str.trim() && Number.isFinite(i.x) && Number.isFinite(i.y)).flatMap(splitItem).sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: Array<{ y: number; size: number; items: PdfItem[] }> = [];
    for (const it of its) {
      const g = groups[groups.length - 1];
      const tol = Math.max(1, Math.min(it.size || 8, 14) * 0.45);
      if (g && Math.abs(g.y - it.y) <= tol) { g.items.push(it); g.size = Math.max(g.size, it.size); } else groups.push({ y: it.y, size: it.size, items: [it] });
    }
    for (const g of groups) {
      const cells: Cell[] = [];
      for (const it of g.items.sort((a, b) => a.x - b.x)) {
        const text = clean(it.str);
        if (!text) continue;
        const last = cells[cells.length - 1];
        const size = Math.max(it.size, last?.size || 0) || 8;
        const gap = last ? it.x - last.x1 : Infinity;
        // Pieces of one phrase are joined; two values or two headings that happen to sit close are not.
        const apart = last && ((isValue(last.text) && isValue(text)) || (roleOf(last.text) && roleOf(text)));
        if (last && !apart && gap <= size * 0.3) {
          last.text += gap > size * 0.1 && !last.text.endsWith(' ') ? ` ${text}` : text;
          last.x1 = Math.max(last.x1, it.x + it.w);
          last.size = Math.max(last.size, it.size);
        } else cells.push({ text, x0: it.x, x1: it.x + Math.max(it.w, 0), size: it.size });
      }
      if (cells.length) out.push({ page, y: g.y, size: g.size, cells, text: cells.map((c) => c.text).join('  ') });
    }
  });
  return out;
}

// ---------- values ----------

const isValue = (t: string) => !!(moneyValue(t) || dateValue(t));

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** 1–12 for a month name or its short form ("Oct", "Sept"), else 0. */
const monthOf = (s: string) => {
  const w = s.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
  return i >= 0 && (w === 'sept' || MONTHS[i].startsWith(w)) ? i + 1 : 0;
};

export interface PeriodEnd { y: number; m: number }

/** A date at the start of a cell: 10/25/2026, 10/25/26, 2026-10-25, 10/25, Oct 25, 2026, Oct 25, 25 Oct. */
export function dateValue(text: string, end?: PeriodEnd): IsoDate | null {
  const s = text.trim().replace(/^(\w+\.?\s+\d{1,2})(st|nd|rd|th)\b/i, '$1');
  const yearFor = (m: number) => (end ? (m > end.m + 1 ? end.y - 1 : end.y) : new Date().getFullYear());
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?![\d/])/);
  if (m) return validDate(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]));
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?![\d/-])/);
  if (m) return validDate(yearFor(Number(m[1])), Number(m[1]), Number(m[2]));
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?(?![\d:])/);
  if (m && monthOf(m[1])) { const mo = monthOf(m[1]); return validDate(m[3] ? Number(m[3]) : yearFor(mo), mo, Number(m[2])); }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?(?:\s+(\d{4}))?(?![\d:])/);
  if (m && monthOf(m[2])) { const mo = monthOf(m[2]); return validDate(m[3] ? Number(m[3]) : yearFor(mo), mo, Number(m[1])); }
  return null;
}

/** Money with cents: $1,234.56, -$45.10, (45.10), 45.10-, 45.10 CR. */
export function moneyValue(text: string): { v: number; marker?: 'cr' | 'dr' } | null {
  const s = clean(text);
  for (const tok of [s, ...s.split(' ').map((t, i, a) => (/^(cr|dr)$/i.test(a[i + 1] || '') ? `${t} ${a[i + 1]}` : t))]) {
    if (!/^[-+(]?\s*[$£€]?\s*[-+]?\d{1,3}(?:[,.]?\d{3})*[.,]\d{2}\)?(?:\s*(?:cr|dr|-))?$/i.test(tok)) continue;
    const v = parseAmountCell(tok.replace(/\s*(cr|dr)$/i, ''));
    if (v == null) continue;
    const marker = /cr$/i.test(tok) ? 'cr' : /dr$/i.test(tok) ? 'dr' : undefined;
    return { v, marker };
  }
  return null;
}

const DATE_TXT = String.raw`(?:[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})`;
const RANGE = new RegExp(`(${DATE_TXT})\\s*(?:-|to|through|thru)\\s*(${DATE_TXT})`, 'i');

/** The statement period's last day, for dates printed without a year. */
export function periodEnd(lines: Line[]): PeriodEnd | undefined {
  for (const ln of lines) {
    const m = ln.text.match(RANGE);
    const d = m ? dateValue(m[2].replace(/(\d)(st|nd|rd|th)\b/i, '$1')) : null;
    if (d) return { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) };
  }
  const years = new Map<number, number>();
  for (const ln of lines) for (const y of ln.text.match(/\b20\d\d\b/g) || []) years.set(Number(y), (years.get(Number(y)) || 0) + 1);
  const y = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return y ? { y, m: 12 } : undefined;
}

// ---------- columns ----------

function roleOf(raw: string): Role | null {
  const t = raw.toLowerCase().replace(/[^a-z/& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 34) return null;
  if (/^(running |ending |daily |available )?balance$/.test(t)) return 'balance';
  if (/^net amount$|^ref(erence)?( no| number)?$|^check (no|number)$|^serial( no| number)?$/.test(t)) return 'other';
  if (/^((transaction|trans|tran|posting|post|posted|settlement|settle|effective|eff|value|process|processing|activity|purchase|sale) )?date( posted)?$|^date (posted|of transaction)$|^posted$|^trans$|^tran$/.test(t)) {
    return /settle|post|effective|eff|value|process/.test(t) && !/trans|purchase|sale|activity/.test(t) ? 'date2' : 'date';
  }
  if (/^(transaction |merchant |payee )?(description|details|name)$|^(merchant|payee|memo|narrative|particulars|activity|transactions?)$|^description of transaction$/.test(t)) return 'desc';
  if (/^(transaction )?type$|^category$/.test(t)) return 'type';
  if (/^(transaction )?amount( usd)?$|^amt$/.test(t)) return 'amount';
  if (/^(debits?|withdrawals?|charges?|money out|paid out|subtractions?|purchases?)( amount)?$|^(withdrawals?|debits?|checks?) ?(\/|&|and) ?(debits?|withdrawals?|other subtractions)$/.test(t)) return 'out';
  if (/^(credits?|deposits?|money in|paid in|additions?)( amount)?$|^(deposits?|credits?) ?(\/|&|and) ?(credits?|deposits?|other additions)$/.test(t)) return 'in';
  return null;
}

function headerCols(ln: Line): Col[] | null {
  if (ln.cells.length < 2) return null;
  if (ln.cells.some((c) => moneyValue(c.text) || dateValue(c.text))) return null;
  const cols: Col[] = [];
  for (const c of ln.cells) {
    const role = roleOf(c.text);
    if (role) cols.push({ role, x0: c.x0, x1: c.x1 });
  }
  const has = (...r: Role[]) => cols.some((c) => r.includes(c.role));
  if (!has('date', 'date2') || !has('amount', 'out', 'in')) return null;
  if (!has('date')) cols.find((c) => c.role === 'date2')!.role = 'date';
  let seenDate = false, seenAmount = false;
  for (const c of cols) {
    if (c.role === 'date') { if (seenDate) c.role = 'date2'; seenDate = true; }
    if (c.role === 'amount') { if (seenAmount) c.role = 'other'; seenAmount = true; }
  }
  return cols;
}

/** The column a cell sits in: the one it overlaps most, else the nearest. */
function colFor(cols: Col[], c: Cell): Col {
  let best = cols[0], bestOv = 0;
  for (const col of cols) {
    const ov = Math.min(c.x1, col.x1) - Math.max(c.x0, col.x0);
    if (ov > bestOv) { bestOv = ov; best = col; }
  }
  if (bestOv > 0) return best;
  let bestGap = Infinity;
  for (const col of cols) {
    const gap = c.x1 < col.x0 ? col.x0 - c.x1 : c.x0 > col.x1 ? c.x0 - col.x1 : 0;
    if (gap < bestGap) { bestGap = gap; best = col; }
  }
  return best;
}

// ---------- statement structure ----------

function titleKind(ln: Line): Kind | null {
  if (ln.cells.length !== 1) return null;
  const t = ln.text.toLowerCase();
  if (t.length > 90 || !/\bstatement$/.test(t)) return null;
  if (/secured account|checking|savings|deposit account|spending account|money market|bank account/.test(t)) return 'bank';
  if (/\bcard\b|credit account|visa|mastercard/.test(t)) return 'card';
  if (/account statement|\baccount\b/.test(t)) return 'bank';
  return null;
}

const ACCOUNT_LABEL = /^account\s*(?:number|no\.?|#)\s*:?$/i;
const ACCOUNT_INLINE = /account\s*(?:number|no\.?|#|ending(?:\s+in)?)\s*:?\s*[x*•.\-\s]*(\d[\d\s-]{3,})/i;

const isTotal = (ln: Line) => /^(total\b|sub ?total\b)/i.test(ln.cells[0].text) || /^(ending|closing) balance\b/i.test(ln.cells[0].text);
const SUMMARY_DESC = /\b(beginning|ending|opening|closing|starting|previous) balance\b|\bbalance forward\b|\b(sub ?)?total\b/i;
const SKIP_SECTION = /disputed|pending|declined|authori[sz]ations? on hold/i;

const OUT_TYPE = /\b(purchases?|pos|debit|withdrawals?|atm|fees?|charges?|checks?|cash advance|sent|card transaction)\b/i;
const IN_TYPE = /\b(deposits?|credits?|refunds?|returns?|reversal|interest (earned|paid)|cash ?back|rewards?|received)\b/i;
function typeDir(type: string): 'out' | 'in' | null {
  if (!type) return null;
  if (/payment/i.test(type) && !/\b(received|sent)\b/i.test(type)) return null;
  const o = OUT_TYPE.test(type), i = IN_TYPE.test(type);
  return o && !i ? 'out' : i && !o ? 'in' : null;
}
function sectionDir(section: string, kind: Kind): 'out' | 'in' | null {
  const s = section.toLowerCase();
  if (!s) return null;
  const i = /\b(deposits?|credits?|additions|money in|refunds?)\b/.test(s) || (kind === 'card' && /^payments?\b/.test(s));
  const o = /\b(withdrawals?|debits?|subtractions|purchases?|charges?|fees?|checks?( paid)?|atm|card transactions|money out|cash advances?|interest charged)\b/.test(s);
  return i && !o ? 'in' : o && !i ? 'out' : null;
}
function kindHint(type: string, kind: Kind, flow: number): MerchantKind | undefined {
  const t = type.toLowerCase();
  if (!t) return undefined;
  if (/transfer|round ?up/.test(t)) return 'transfer';
  if (/direct deposit|payroll/.test(t)) return 'payroll';
  if (/\batm\b/.test(t)) return 'atm';
  if (/\bfees?\b/.test(t)) return 'fee';
  if (/interest/.test(t)) return 'interest';
  if (kind === 'card' && /^payments?$/.test(t) && flow > 0) return 'cardPayment';
  return undefined;
}

/** Which way money moved for each row of a table. */
function directions(t: Table): Array<'out' | 'in'> {
  const signed = t.rows.some((r) => r.shown < 0);
  let plus = 0, minus = 0; // evidence that a plus amount is money out / money in
  for (const r of t.rows) {
    if (r.col || r.marker) continue;
    const dir = typeDir(r.type) ?? (MONEY_IN_HINT.test(`${r.desc} ${r.more.join(' ')}`) ? 'in' : null);
    if (!dir) continue;
    if ((dir === 'out') === (r.shown > 0)) plus++; else minus++;
  }
  let outSign = plus > minus ? 1 : minus > plus ? -1 : 0;
  let perRow = false;
  if (!outSign) {
    const sec = sectionDir(t.section, t.kind);
    if (!signed && sec) outSign = sec === 'out' ? 1 : -1;
    else if (t.kind === 'card') outSign = 1;
    else if (signed) outSign = -1;
    else perRow = true;
  }
  return t.rows.map((r) => {
    if (r.col) return r.col;
    if (r.marker) return r.marker === 'cr' ? 'in' : 'out';
    if (perRow) return MONEY_IN_HINT.test(`${r.desc} ${r.more.join(' ')}`) || typeDir(r.type) === 'in' ? 'in' : 'out';
    return (r.shown < 0 ? -1 : 1) === outSign ? 'out' : 'in';
  });
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Reads a statement's transactions from the text of its pages. Throws when there's nothing to read. */
export function parsePdfStatement(pages: PdfItem[][]): ParsedStatement {
  const lines = linesOf(pages);
  if (!lines.length) throw new Error("This PDF has no text in it (it may be a scanned picture). Download the statement from your bank's website or app instead.");
  const end = periodEnd(lines);
  const docText = lines.map((l) => l.text).join('\n');
  let kind: Kind = /payment due date|minimum payment|credit limit|available credit/i.test(docText) ? 'card' : /beginning balance|ending balance|checking|savings/i.test(docText) ? 'bank' : undefined;
  const bank = /\bchime\b/i.test(docText) ? 'Chime' : undefined;
  let account: string | undefined;
  let accountLabel: { x0: number; x1: number; page: number } | null = null;
  let section = '';
  let table: Table | null = null;
  let row: Row | null = null;
  const tables: Table[] = [];

  const close = () => { table = null; row = null; };

  for (const ln of lines) {
    if (accountLabel) {
      const c = ln.page === accountLabel.page ? ln.cells.find((x) => Math.min(x.x1, accountLabel!.x1) - Math.max(x.x0, accountLabel!.x0) > 0) : undefined;
      const digits = c && /^[\dXx*•\s-]{4,}$/.test(c.text) ? c.text.replace(/\D/g, '') : '';
      if (digits.length >= 4) account = digits.slice(-4);
      accountLabel = null;
    }
    const tk = titleKind(ln);
    if (tk) { close(); kind = tk; account = undefined; section = ''; continue; }
    for (const c of ln.cells) {
      const inline = c.text.match(ACCOUNT_INLINE);
      if (inline && inline[1].replace(/\D/g, '').length >= 4) account = inline[1].replace(/\D/g, '').slice(-4);
      else if (ACCOUNT_LABEL.test(c.text)) accountLabel = { x0: c.x0, x1: c.x1, page: ln.page };
    }
    const cols = headerCols(ln);
    if (cols) {
      close();
      const t: Table = { cols, section, kind, account, rows: [], totals: [], skip: SKIP_SECTION.test(section) };
      tables.push(t);
      table = t;
      continue;
    }
    const tb = table as Table | null;
    if (!tb) {
      if (ln.cells.length === 1 && !moneyValue(ln.text) && !dateValue(ln.text) && ln.text.length <= 60) section = ln.text;
      continue;
    }
    if (isTotal(ln)) {
      for (const c of ln.cells) { const mv = moneyValue(c.text); if (mv) tb.totals.push(mv.v); }
      close();
      continue;
    }
    // Sort the line's text into the table's columns, then read each column.
    const byCol = new Map<Col, string[]>();
    for (const c of ln.cells) {
      const col = colFor(tb.cols, c);
      byCol.set(col, [...(byCol.get(col) || []), c.text]);
    }
    const hasDesc = tb.cols.some((c) => c.role === 'desc');
    let date: IsoDate | null = null;
    let m: { v: number; marker?: 'cr' | 'dr'; col?: 'out' | 'in' } | null = null;
    let stray = false;
    const desc: string[] = [], type: string[] = [];
    for (const [col, texts] of byCol) {
      const joined = texts.join(' ');
      if (col.role === 'date') {
        const d = dateValue(joined, end) ?? dateValue(texts[0], end);
        if (d) date = d;
        else if (!hasDesc) desc.push(joined);
        else stray = true;
      } else if (col.role === 'amount' || col.role === 'out' || col.role === 'in') {
        const mv = moneyValue(joined) ?? moneyValue(texts[0]);
        if (mv && (!m || m.v === 0)) m = { ...mv, col: col.role === 'amount' ? undefined : col.role };
        else if (!mv) stray = true;
      } else if (col.role === 'desc' || (!hasDesc && col.role === 'other')) desc.push(joined);
      else if (col.role === 'type') type.push(joined);
    }
    const text = desc.join(' ');
    // A row without its own date (some banks print the date once per day) must follow right after the one above.
    const sameDay = !date && !!tb.lastDate && !!text && !!row && row.page === ln.page && row.lastY - ln.y <= row.size * 4;
    if (m && m.v !== 0 && (date || sameDay) && !SUMMARY_DESC.test(text)) {
      const r: Row = { date: date || tb.lastDate!, shown: m.v, marker: m.marker, col: m.col, desc: text, more: [], type: type.join(' '), page: ln.page, lastY: ln.y, size: ln.size };
      tb.rows.push(r);
      tb.lastDate = r.date;
      row = r;
    } else if (!m && !date && !stray && row && row.page === ln.page && row.lastY - ln.y <= Math.max(row.size, ln.size) * 2.3 && (text || type.length)) {
      if (text) row.more.push(text);
      if (type.length) row.type = `${row.type} ${type.join(' ')}`.trim();
      row.lastY = ln.y;
    } else if (date || m) {
      row = null;
    }
  }

  const txns: RawTxn[] = [];
  let skippedRows = 0, checked = 0, matched = 0;
  const accounts: string[] = [];
  for (const t of tables) {
    if (!t.rows.length) continue;
    if (t.skip) { skippedRows += t.rows.length; continue; }
    if (t.account && !accounts.includes(t.account)) accounts.push(t.account);
    if (t.totals.length) {
      checked++;
      const sum = t.rows.reduce((s, r) => s + r.shown, 0);
      const outSum = t.rows.filter((r) => r.col === 'out').reduce((s, r) => s + Math.abs(r.shown), 0);
      const inSum = t.rows.filter((r) => r.col === 'in').reduce((s, r) => s + Math.abs(r.shown), 0);
      if (t.totals.some((v) => near(v, sum) || near(Math.abs(v), Math.abs(sum)) || (outSum > 0 && near(Math.abs(v), outSum)) || (inSum > 0 && near(Math.abs(v), inSum)))) matched++;
    }
    const dirs = directions(t);
    t.rows.forEach((r, i) => {
      const flow = Math.round((dirs[i] === 'out' ? -Math.abs(r.shown) : Math.abs(r.shown)) * 100) / 100;
      const more = r.more.join(' ').trim();
      txns.push({
        date: r.date, flow, description: r.desc || more, memo: r.desc && more ? more : undefined,
        account: t.account, source: 'pdf', kindHint: kindHint(r.type, t.kind, flow), bankType: r.type || undefined,
      });
    });
  }
  if (!txns.length) throw new Error("Couldn't find a list of transactions in this PDF. If your bank also offers a CSV, QFX or OFX download, try that instead.");
  const dates = txns.map((t) => t.date).sort();
  const summary: PdfSummary = { bank, accounts, tables: tables.filter((t) => t.rows.length && !t.skip).length, checked, matched, from: dates[0], to: dates[dates.length - 1] };
  return { format: 'pdf', txns, skippedRows, needsCheck: false, account: accounts.length === 1 ? accounts[0] : undefined, pdf: summary };
}
