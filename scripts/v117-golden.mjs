// Runs Bills Account Planner v117 in headless Chromium with a frozen clock and records the numbers its own
// functions produce, so the new engine can be checked against them ("golden" results).
//
// Usage: node scripts/v117-golden.mjs <v117.html> <state.json> <YYYY-MM-DD today> <out.json>
//
// Nested v117 functions (spending periods, month summaries, graphs, loans) live inside renderBills(),
// so their source is extracted from the HTML and evaluated with the same inputs renderBills gives them.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [, , htmlPath, statePath, today, outPath] = process.argv;
if (!htmlPath || !statePath || !/^\d{4}-\d{2}-\d{2}$/.test(today || '') || !outPath) {
  console.error('Usage: node scripts/v117-golden.mjs <v117.html> <state.json> <YYYY-MM-DD> <out.json>');
  process.exit(2);
}
const html = fs.readFileSync(htmlPath, 'utf8');
const stateText = fs.readFileSync(statePath, 'utf8');

function extractFunction(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(html);
  if (!m) throw new Error(`v117 function not found: ${name}`);
  let i = html.indexOf('{', m.index);
  let depth = 0;
  const start = m.index;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`Unbalanced braces in ${name}`);
}

const NESTED = [
  'formatSpendHistoryDate', 'extraSpendPeriodInfo', 'extraSpendMonthSummaryFromPayPeriods', 'graphPocketBaseForPeriodStart',
  'extraSpendGraphRowsForMonth', 'extraSpendGraphRowsLastN', 'extraSpendGraphAverageBreakdown',
  'normalizeDebt', 'debtIsoFromMs', 'debtNextDueIsoAfter', 'debtLastPaymentDate', 'debtPayoffCalc', 'debtPaymentPrincipal',
  'debtPaymentInterest', 'debtPrincipalPaidTotal', 'debtDailyInterestDays', 'debtPaymentSplit', 'debtPaymentSortAsc',
  'recalcDebtFromPayments', 'debtMonthsLabel', 'debtOrderedList', 'debtPaidSoFar', 'debtSummary',
];
const nestedSrc = NESTED.map(extractFunction).join('\n\n');

const browser = await chromium.launch();
const context = await browser.newContext({ timezoneId: 'America/New_York' });
await context.addInitScript((s) => { try { localStorage.setItem('bap_state_clean_template_v1', s); } catch {} }, stateText);
const page = await context.newPage();
await page.clock.install({ time: new Date(`${today}T17:00:00Z`) });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + htmlPath);
await page.waitForTimeout(400);

const out = await page.evaluate(({ nestedSrc, today }) => {
  const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : isoDate(ms));
  const view = state.selectedMonth;
  const base = state.settings.baseMonth || view;
  const horizon = Math.max(12, Number(state.settings.savings.timelineMonths || 6) + 2);
  const start = monthIndex(base) <= monthIndex(view) ? base : view;
  const endBase = monthIndex(base) >= monthIndex(view) ? base : view;
  const end = addMonthsKey(endBase, horizon);
  const ctx = buildPlanRange(start, end, state.settings, state.bills);

  const extras = Array.isArray(state.extras) ? state.extras : [];
  const debtsClone = structuredClone(Array.isArray(state.debts) ? state.debts : []);
  const extraSpendEntries = allExtraSpendEntries();
  const extraSpendTransfers = allExtraSpendTransfers();
  const names = ['extraSpendPeriodInfo', 'extraSpendMonthSummaryFromPayPeriods', 'extraSpendGraphRowsForMonth', 'extraSpendGraphRowsLastN',
    'extraSpendGraphAverageBreakdown', 'normalizeDebt', 'debtPayoffCalc', 'debtPaymentSplit', 'recalcDebtFromPayments', 'debtMonthsLabel',
    'debtOrderedList', 'debtSummary', 'debtLastPaymentDate', 'debtNextDueIsoAfter', 'debtPaidSoFar'];
  // eslint-disable-next-line no-new-func
  const nested = new Function('state', 'extras', 'debts', 'extraSpendEntries', 'extraSpendTransfers', 'ctx',
    `${nestedSrc}\nreturn { ${names.join(', ')} };`)(state, extras, debtsClone, extraSpendEntries, extraSpendTransfers, ctx);

  const plans = {};
  for (const [mk, p] of ctx.plans) {
    plans[mk] = {
      AS2: p.AS2, TargetCarry: p.TargetCarry, TB1: p.TB1, paydays: p.paydays.map(iso), payCaps: p.payCaps,
      billsPerPaycheck: p.billsPerPaycheck, desiredBillsPerPaycheck: p.desiredBillsPerPaycheck, nominalBillsPerPaycheck: p.nominalBillsPerPaycheck,
      minBillsPerPaycheckForCushion: p.minBillsPerPaycheckForCushion, maxBillsPerPaycheck: p.maxBillsPerPaycheck, extraFunding: p.extraFunding,
      savingsPerPaycheck: p.savingsPerPaycheck, topup: p.topup, startAfterTopup: p.startAfterTopup, startBills: p.startBills, startSavings: p.startSavings,
      billsStartSurplus: p.billsStartSurplus, endBills: p.endBills, endSavings: p.endSavings, lowestBillsBal: p.lowestBillsBal,
      lowestBillsBalDate: iso(p.lowestBillsBalDate), nextPaydayAfterLast: iso(p.nextPaydayAfterLast), pocketSpentByPayIndex: p.pocketSpentByPayIndex,
      pocketBase: p.paydays.map((_, i) => pocketBasePerPaycheck(p, i)),
      pocketNet: p.paydays.map((_, i) => pocketNetForPayIndex(p, i)),
      minimumInfo: p.paydays.map((_, i) => { const m = pocketMinimumInfo(p, i); return m ? { metricValue: m.metricValue, shortBy: m.shortBy } : null; }),
      periods: pocketPayPeriods(p).map((x) => ({ start: iso(x.start), end: iso(x.end), base: x.pocketBase, spent: x.pocketSpent, net: x.pocketNet })),
      rows: p.rows.map((r) => [iso(r.ms), r.transferIn, r.billsOut, r.savingsIn, r.savingsOut, r.pocketOut, r.billsBalance, r.billsBalanceWorking, r.savingsBalance]),
    };
  }
  const projectedSavings = {};
  for (let i = monthIndex(start) - 2; i <= monthIndex(end) + 1; i++) {
    const mk = monthKeyFromIndex(i);
    projectedSavings[mk] = projectedSavingsAtMonthStart(mk, state.settings);
  }

  // Spending snapshots for every pay period from the first log month (or 3 months back) to 2 months ahead.
  const logMonths = extraSpendEntries.map((e) => String(e.date || '').slice(0, 7)).filter(Boolean).sort();
  const firstMk = logMonths.length && logMonths[0] < addMonthsKey(view, -3) ? logMonths[0] : addMonthsKey(view, -3);
  const periodKeys = new Map();
  for (let i = monthIndex(firstMk); i <= monthIndex(addMonthsKey(view, 2)); i++) {
    const mk = monthKeyFromIndex(i);
    const dates = [`${mk}-01`, ...getPaydaysForMonth(mk, state.settings).map(isoDate)];
    for (const d of dates) {
      const info = nested.extraSpendPeriodInfo(d);
      if (info.startIso) periodKeys.set(info.key, info);
    }
  }
  const periodInfo = Array.from(periodKeys.values()).map((p) => ({ key: p.key, startIso: p.startIso, endIso: p.endIso }));
  const snapshots = periodInfo.map((p) => {
    const snap = extraSpendSnapshotForRange(parseISOToMs(p.startIso), parseISOToMs(p.endIso), extras, extraSpendEntries, extraSpendTransfers);
    return { startIso: p.startIso, endIso: p.endIso, totals: snap.totals, items: snap.items.map((x) => [x.id, x.budget, x.spent, x.remaining, x.entryCount, x.transferIn, x.transferOut]) };
  });
  const monthSummaries = {};
  for (let i = monthIndex(firstMk); i <= monthIndex(addMonthsKey(view, 1)); i++) {
    const mk = monthKeyFromIndex(i);
    const s = nested.extraSpendMonthSummaryFromPayPeriods(mk);
    monthSummaries[mk] = { totals: s.totals, items: s.items.map((x) => [x.id, x.budget, x.spent, x.remaining, x.entryCount]) };
  }
  const graphOf = (meta) => ({
    totalSpent: meta.totalSpent, averageSpent: meta.averageSpent, maxSpent: meta.maxSpent, count: meta.count, completedCount: meta.completedCount,
    rows: meta.rows.map((r) => [r.id, r.budget, r.spent, r.entryCount, r.isCurrentPeriod, r.isComplete]),
    average: nested.extraSpendGraphAverageBreakdown(meta).map((a) => [a.id, a.total, a.average, a.entryCount, a.periodsHit]),
  });
  const graphs = {};
  for (let i = monthIndex(firstMk); i <= monthIndex(view); i++) {
    const mk = monthKeyFromIndex(i);
    graphs[mk] = { month: graphOf(nested.extraSpendGraphRowsForMonth(mk)), last7: graphOf(nested.extraSpendGraphRowsLastN(mk, 7)) };
  }

  // Loans
  debtsClone.forEach(nested.normalizeDebt);
  const debts = debtsClone.map((d) => {
    const calc = nested.debtPayoffCalc(d);
    const last = nested.debtLastPaymentDate(d);
    const from = last || d.interestStartDate || '';
    const due = nested.debtNextDueIsoAfter(today, d.dueDay);
    const split = nested.debtPaymentSplit(d, Number(d.minPayment || 0) + Number(d.extraPayment || 0), undefined, due, from);
    const replay = structuredClone(d);
    nested.recalcDebtFromPayments(replay, Number(d.originalBalance || 0));
    return {
      id: d.id, balance: d.balance, months: Number.isFinite(calc.months) ? calc.months : 'Infinity', interest: calc.interest, stuck: calc.stuck,
      label: nested.debtMonthsLabel(calc.months), paidSoFar: nested.debtPaidSoFar(d), nextDue: due,
      split: [split.amount, split.interest, split.principal, split.balanceAfter],
      replay: { balance: replay.balance, payments: replay.payments.map((p) => [p.date, p.amount, p.interest, p.principal, p.balanceAfter]) },
    };
  });
  const order = {};
  const prevStrategy = state.ui.debtStrategy;
  for (const s of ['avalanche', 'snowball', 'custom']) { state.ui.debtStrategy = s; order[s] = nested.debtOrderedList().map((d) => d.id); }
  state.ui.debtStrategy = prevStrategy;
  const sum = nested.debtSummary();
  const debtSummary = { totalBalance: sum.totalBalance, paidSoFar: sum.paidSoFar, monthlyTotal: sum.monthlyTotal, longestMonths: Number.isFinite(sum.longestMonths) ? sum.longestMonths : 'Infinity', interest: sum.interest };

  return { today, view, base, range: [start, end], plans, projectedSavings, periodInfo, snapshots, monthSummaries, graphs, debts, order, debtSummary };
}, { nestedSrc, today });

out.pageErrors = errors;
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`golden: ${Object.keys(out.plans).length} months, ${out.snapshots.length} periods, ${out.debts.length} loans, page errors: ${errors.length} -> ${outPath}`);
await browser.close();
