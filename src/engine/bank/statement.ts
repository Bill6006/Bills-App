/**
 * Reads bank statement downloads: CSV in the layouts banks commonly use (found by looking at the headers and
 * the values), and OFX/QFX (the "Quicken" / "Money" downloads). Everything becomes RawTxn with a signed
 * money flow (negative = money out).
 */
import { daysInMonth, isoDate, msUTC, type IsoDate } from '../dates';
import type { CsvProfile } from '../types';

export interface RawTxn {
  date: IsoDate;
  /** Negative is money out, positive is money in. */
  flow: number;
  description: string;
  memo?: string;
  /** The bank's own id for the transaction (OFX/QFX). */
  fitid?: string;
  bankCategory?: string;
  pending?: boolean;
  account?: string;
}

export interface ParsedStatement {
  format: 'csv' | 'ofx';
  txns: RawTxn[];
  /** Rows that had no date or amount (summary lines, blank amounts). */
  skippedRows: number;
  /** CSV only. */
  profile?: CsvProfile;
  headers?: string[];
  rows?: string[][];
  /** First time this CSV layout is seen: show how it was read before importing. */
  needsCheck: boolean;
  account?: string;
}

// ---------- CSV ----------

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0, q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ch && !q) n++;
  }
  return n;
}

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  let best = ',', bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d)).filter((n) => n > 0);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) || 0) + 1);
    const [mode, times] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const score = times * Math.min(mode, 12);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export function parseCsv(text: string, delim = detectDelimiter(text)): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

// ---------- values ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validDate(y: number, m: number, d: number): IsoDate | null {
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= daysInMonth(y, m))) return null;
  return isoDate(msUTC(y, m, d));
}

export function parseDateCell(raw: string, order: CsvProfile['dateOrder'] = 'mdy'): IsoDate | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?!\d{3})/);
  if (m && s.length >= 8) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const a = Number(m[1]), b = Number(m[2]);
    return order === 'dmy' ? validDate(y, b, a) : validDate(y, a, b);
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); return mi >= 0 ? validDate(+m[3], mi + 1, +m[2]) : null; }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{2,4})/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mi >= 0 ? validDate(y, mi + 1, +m[1]) : null;
  }
  return null;
}

/** "$1,234.56", "(12.34)", "-12.34", "12.34-", "12,34" → number; null when it isn't money. */
export function parseAmountCell(raw: string): number | null {
  let s = String(raw || '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/\s*(cr)$/i.test(s)) s = s.replace(/\s*cr$/i, '');
  else if (/\s*(dr)$/i.test(s)) { neg = !neg; s = s.replace(/\s*dr$/i, ''); }
  s = s.replace(/[$£€\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d{2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = Math.round(Number(s) * 100) / 100;
  return neg ? -v : v;
}

// ---------- CSV layout detection ----------

const HEADER_WORD = /date|description|payee|merchant|amount|debit|credit|withdrawal|deposit|balance|memo|category|details|type|reference|status|narrative|transaction|name/;
const isHeaderRow = (r: string[]) => r.filter((c) => HEADER_WORD.test(c.toLowerCase())).length >= 2 && !r.some((c) => parseDateCell(c));

function columnStats(rows: string[][], col: number) {
  let n = 0, dates = 0, nums = 0, textLen = 0, texts = 0;
  for (const r of rows.slice(0, 300)) {
    const v = (r[col] ?? '').trim();
    if (!v) continue;
    n++;
    if (parseDateCell(v)) dates++;
    else if (parseAmountCell(v) != null) nums++;
    else { texts++; textLen += v.length; }
  }
  return { n, dateRate: n ? dates / n : 0, numRate: n ? nums / n : 0, avgText: texts ? textLen / texts : 0, textRate: n ? texts / n : 0 };
}

function detectOrder(values: string[]): CsvProfile['dateOrder'] {
  let firstOver12 = false, secondOver12 = false, iso = 0;
  for (const v of values) {
    if (/^\d{4}[-/.]/.test(v) || /^\d{8}/.test(v)) { iso++; continue; }
    const m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/);
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (iso > values.length / 2) return 'ymd';
  if (firstOver12 && !secondOver12) return 'dmy';
  return 'mdy';
}

const MONEY_IN_HINT = /\b(payroll|direct dep|dir dep|salary|interest paid|interest earned|refund|transfer from|mobile deposit|deposit|payment received)\b|payment\W+thank you|thank you\W+(for your )?payment/i;

/** Works out which column is which, and how money out is shown. */
export function detectProfile(all: string[][]): { profile: CsvProfile; headers: string[]; rows: string[][] } | null {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(all.length, 25); i++) if (isHeaderRow(all[i])) { headerIdx = i; break; }
  const headers = headerIdx >= 0 ? all[headerIdx].map((h) => h.trim()) : [];
  const body = (headerIdx >= 0 ? all.slice(headerIdx + 1) : all).filter((r) => r.length >= 2 && r.some((c) => parseDateCell(c)));
  if (!body.length) return null;
  const width = Math.max(headers.length, ...body.map((r) => r.length));
  const stats = Array.from({ length: width }, (_, c) => columnStats(body, c));
  const h = (c: number) => (headers[c] || '').toLowerCase();
  const find = (re: RegExp, ok: (c: number) => boolean, not?: RegExp) => {
    for (let c = 0; c < width; c++) if (re.test(h(c)) && (!not || !not.test(h(c))) && ok(c)) return c;
    return -1;
  };

  // Date: prefer the transaction date over the posting date.
  let date = find(/trans|^date$/, (c) => stats[c].dateRate >= 0.8, /post/);
  if (date < 0) date = find(/date/, (c) => stats[c].dateRate >= 0.8);
  if (date < 0) date = stats.findIndex((s) => s.dateRate >= 0.8);
  if (date < 0) return null;

  const isNum = (c: number) => c !== date && stats[c].numRate >= 0.8;
  const indicatorRe = /indicator|dr\/cr|cr\/dr|debit\/credit|credit\/debit/;
  let amount = find(/^amount$|^transaction amount$|^amount \(|amount$/, isNum, /balance|running|original|instructed|exchange/);
  if (amount < 0) amount = find(/amount/, isNum, /balance|running|original|instructed|exchange/);
  let debit = find(/debit|withdrawal|money out|paid out|charge|spent/, (c) => c !== date && stats[c].n > 0, indicatorRe);
  let credit = find(/credit|deposit|money in|paid in|^payments?$|receipt/, (c) => c !== date && c !== debit && stats[c].n > 0, indicatorRe);
  if (amount >= 0) { debit = -1; credit = -1; }
  if (amount < 0 && (debit < 0 || credit < 0)) {
    debit = -1; credit = -1;
    for (let c = 0; c < width; c++) if (isNum(c) && !/balance|running/.test(h(c))) { amount = c; break; }
  }
  if (amount < 0 && (debit < 0 || credit < 0)) return null;

  const used = new Set([date, amount, debit, credit]);
  let description = find(/description|payee|merchant|^name$|narrative|^transaction$/, (c) => !used.has(c) && stats[c].textRate > 0.5);
  if (description < 0) description = find(/details|memo/, (c) => !used.has(c) && stats[c].textRate > 0.5 && stats[c].avgText > 6);
  if (description < 0) {
    let bestLen = 0;
    for (let c = 0; c < width; c++) if (!used.has(c) && stats[c].avgText > bestLen && stats[c].textRate > 0.5) { bestLen = stats[c].avgText; description = c; }
  }
  if (description < 0) return null;
  used.add(description);
  const memo = find(/memo|details|reference|extended/, (c) => !used.has(c) && stats[c].textRate > 0.3 && stats[c].avgText > 3);
  const category = find(/category/, (c) => !used.has(c));
  const statusCol = (() => {
    const byName = find(/status|state/, (c) => !used.has(c));
    if (byName >= 0) return byName;
    for (let c = 0; c < width; c++) if (!used.has(c) && body.some((r) => /^(pending|posted)$/i.test(r[c] || ''))) return c;
    return -1;
  })();
  let indicator = find(indicatorRe, (c) => !used.has(c));
  if (indicator < 0 && amount >= 0) {
    for (let c = 0; c < width; c++) {
      if (used.has(c)) continue;
      const vals = body.map((r) => (r[c] || '').toLowerCase()).filter(Boolean);
      if (vals.length && vals.every((v) => /^(debit|credit|dr|cr)$/.test(v))) { indicator = c; break; }
    }
  }
  const order = detectOrder(body.map((r) => r[date] || ''));

  // How money out is shown, when one column holds both directions.
  let outNegative = true;
  if (amount >= 0) {
    const amts = body.map((r) => parseAmountCell(r[amount] || '')).filter((v): v is number => v != null && v !== 0);
    const allPositive = amts.every((v) => v > 0);
    if (!(indicator >= 0 && allPositive)) {
      let inPos = 0, inNeg = 0;
      body.forEach((r) => {
        const v = parseAmountCell(r[amount] || '');
        if (v == null || v === 0 || !MONEY_IN_HINT.test(r[description] || '')) return;
        if (v > 0) inPos++; else inNeg++;
      });
      if (inPos + inNeg >= 1 && inPos !== inNeg) outNegative = inPos > inNeg;
      else outNegative = amts.filter((v) => v < 0).length >= amts.filter((v) => v > 0).length;
    }
  }

  const signature = headers.length ? `h:${headers.map((x) => x.toLowerCase()).join('|')}` : `n:${width}:${stats.map((s) => (s.dateRate > 0.8 ? 'd' : s.numRate > 0.8 ? 'n' : s.textRate > 0.5 ? 't' : '-')).join('')}`;
  const nn = (c: number) => (c >= 0 ? c : null);
  return {
    profile: {
      signature, date, description, memo: nn(memo), amount: nn(amount), debit: nn(debit), credit: nn(credit), category: nn(category),
      status: nn(statusCol), indicator: indicator >= 0 && amount >= 0 ? indicator : null, outNegative, dateOrder: order,
    },
    headers,
    rows: body,
  };
}

const SUMMARY_ROW = /\b(beginning|ending|opening|closing|starting|previous) balance\b|\btotal\b/i;

/** Reads rows with a layout (detected or one you corrected). */
export function readCsvRows(rows: string[][], p: CsvProfile): { txns: RawTxn[]; skipped: number } {
  const txns: RawTxn[] = [];
  let skipped = 0;
  for (const r of rows) {
    const date = parseDateCell(r[p.date] || '', p.dateOrder);
    const description = (r[p.description] || '').replace(/\s+/g, ' ').trim();
    let flow: number | null = null;
    if (p.amount != null) {
      const v = parseAmountCell(r[p.amount] || '');
      if (v != null) {
        if (p.indicator != null) {
          const ind = (r[p.indicator] || '').toLowerCase();
          flow = /^(debit|dr|d)/.test(ind) ? -Math.abs(v) : /^(credit|cr|c)/.test(ind) ? Math.abs(v) : (p.outNegative ? v : -v);
        } else flow = p.outNegative ? v : -v;
      }
    } else {
      const d = parseAmountCell(r[p.debit ?? -1] || ''), c = parseAmountCell(r[p.credit ?? -1] || '');
      if (d != null && d !== 0) flow = -Math.abs(d);
      else if (c != null && c !== 0) flow = Math.abs(c);
    }
    if (!date || flow == null || flow === 0 || !description || SUMMARY_ROW.test(description)) { skipped++; continue; }
    const status = p.status != null ? (r[p.status] || '').toLowerCase() : '';
    const memo = p.memo != null ? (r[p.memo] || '').trim() : '';
    txns.push({
      date, flow, description, memo: memo && memo !== description ? memo : undefined,
      bankCategory: p.category != null ? (r[p.category] || '').trim() || undefined : undefined,
      pending: /pending|processing|authoriz|hold/.test(status) || /^pending\b/i.test(description),
    });
  }
  return { txns, skipped };
}

// ---------- OFX / QFX ----------

const decode = (s: string) => s.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&apos;|&#39;/gi, "'").replace(/&quot;/gi, '"');

export function parseOfx(text: string): { txns: RawTxn[]; account?: string; skipped: number } {
  const acct = (text.match(/<ACCTID>([^<\r\n]+)/i)?.[1] || '').trim();
  const account = acct ? acct.slice(-4) : undefined;
  const txns: RawTxn[] = [];
  let skipped = 0;
  for (const chunk of text.split(/<STMTTRN>/i).slice(1)) {
    const b = chunk.split(/<\/STMTTRN>/i)[0];
    const tag = (n: string) => decode((b.match(new RegExp(`<${n}>([^<\\r\\n]*)`, 'i'))?.[1] ?? '').trim());
    const dt = (tag('DTUSER') || tag('DTPOSTED')).replace(/\D/g, '').slice(0, 8);
    const date = dt.length === 8 ? validDate(+dt.slice(0, 4), +dt.slice(4, 6), +dt.slice(6, 8)) : null;
    const flow = parseAmountCell(tag('TRNAMT'));
    const name = tag('NAME'), memo = tag('MEMO');
    if (!date || flow == null || flow === 0 || !(name || memo)) { skipped++; continue; }
    txns.push({ date, flow, description: name || memo, memo: name && memo && memo !== name ? memo : undefined, fitid: tag('FITID') || undefined, account });
  }
  return { txns, account, skipped };
}

export const looksLikeOfx = (text: string) => /OFXHEADER|<OFX>|<STMTTRN>/i.test(text.slice(0, 4000)) || /<STMTTRN>/i.test(text);

/** Reads a statement file. CSV layouts you confirmed before are reused without asking. */
export function parseStatement(text: string, saved: CsvProfile[] = []): ParsedStatement {
  if (looksLikeOfx(text)) {
    const o = parseOfx(text);
    if (!o.txns.length) throw new Error("This OFX/QFX file doesn't have any transactions in it.");
    return { format: 'ofx', txns: o.txns, skippedRows: o.skipped, needsCheck: false, account: o.account };
  }
  const all = parseCsv(text);
  const det = detectProfile(all);
  if (!det) throw new Error("Couldn't find dates and amounts in this file. Download it from your bank as CSV, QFX or OFX (not PDF).");
  const known = saved.find((p) => p.signature === det.profile.signature);
  const profile = known ?? det.profile;
  const { txns, skipped } = readCsvRows(det.rows, profile);
  if (!txns.length) throw new Error('No transactions with a date and an amount were found in this file.');
  return { format: 'csv', txns, skippedRows: skipped, profile, headers: det.headers, rows: det.rows, needsCheck: !known };
}
