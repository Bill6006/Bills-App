# Bills Planner

A paycheck-first planner for bills, spending money, savings and loans, rebuilt from Bills Account Planner v117.

Every paycheck splits three ways: a fixed amount moves to your **Bills account**, a fixed amount moves to **Savings**, and the rest is **yours to spend**. The app works out those amounts so the Bills account never drops below your cushion and always carries enough into next month. It's a guide: it shows what each account *should* have today, and you keep your bank in line with it. You don't enter your real balances.

- **Installable PWA.** Add it to your home screen; it works offline and updates itself.
- **Private.** Everything is stored on your device (IndexedDB). There is no server, account or tracking. This repository contains only app code, never anyone's data.
- **Same math as v117.** The calculation engine in `src/engine` is a tested port of v117's formulas, with a short list of deliberate bug fixes.

## What's where

| Screen | What it answers |
|---|---|
| **Home** | What the Bills account should have today (and before today's bills), spending money left until payday, the next payday's split, anything that needs attention, what's coming up. |
| **Timeline** | Every payday, bill and withdrawal with running balances, by pay period or month, with a Today line. Cards on a phone, a table on a desktop. |
| **Spending** | Budgets for the pay period or month, logging purchases and refunds, moving money between budgets, history with search, and trends. |
| **Plan** | Income, bills, spending budgets, savings and withdrawals, loans, safety net, backup and settings. |

Tap any big number to see how it was worked out. **What-if mode** (Plan or Settings) lets you try a change and keep or discard it; Home shows your real plan next to it.

## Spending from your bank

Instead of logging each purchase, import your bank's monthly **PDF statement** (for banks like Chime that only offer PDFs) or a transactions download (**CSV**, **QFX** or **OFX**) under **Spending › Import from your bank**.

- **It files purchases for you** when it's sure, using your own history: the stores you've used and the amounts. At a gas station a fill-up goes to Gas and a snack to Groceries, and amounts in between are left for you to pick. Every correction teaches it; a store can also be set to always use one budget, always ask, or always skip (**Plan › Bank import**).
- **To review** holds the rest: one tap for a suggested budget, **Split** to divide one purchase across budgets, or **Not spending**.
- **Not spending is skipped**: transfers between your accounts, your paycheck, card payments and bills that are already in your plan.
- **Nothing is counted twice**: transactions from earlier imports are recognized (the bank's id in QFX/OFX; date, amount and text in CSV, with identical same-day purchases kept apart), the same purchase from a CSV and a QFX is matched, purchases you logged by hand are linked instead of added, and pending charges wait until they post. A whole import can be removed again.
- The first CSV from a bank shows how its columns were read so you can correct them once; after that the layout is remembered.
- **PDF statements** are read from their transaction tables: the column headings say which text is the date, description, type and amount, a table that continues on the next page is followed, and the store's bank text printed under its name is kept. Money in or out comes from the transaction type (Purchase, Refund, Fee, Transfer), money in / money out columns, the section (Deposits, Withdrawals) or the kind of account (a card or a bank account). Every table with a total line is checked against it, and the preview says whether everything added up. Scanned (picture-only) PDFs can't be read. The PDF reader ([pdf.js](https://mozilla.github.io/pdf.js/)) loads only when a PDF is picked and is cached for offline use.

## Loans update themselves

Each loan's payment is planned as a bill on its due day. With automatic payments on (the default), the balance drops on each due date as if the scheduled payment went through, so there's nothing to log month to month. Log a payment only when it's extra or different:

- An **extra** payment lowers the balance and leaves the schedule alone.
- A payment **instead of** a scheduled one replaces it (and undoes the automatic one if it was already applied).
- Editing or deleting a payment moves the balance by that payment only, so a balance you typed in from your lender stays put.

If a loan's last logged payment is months old (common right after importing), the loan asks whether those payments were made and can record them for you, or you can type the balance your lender shows.

## Changes from v117

The engine keeps v117's numbers exactly when these fixes are off (`NO_FIXES`, used by the parity tests). The app runs with all of them on:

- **Loans stop after payoff.** v117 kept scheduling the payment after a loan was paid off and never shortened the last one.
- **Savings add up to the goal.** In months with three paydays v117 lost a cent; the last payday now takes the remainder.
- **Withdrawals count the same everywhere.** Recurring savings withdrawals are counted in the savings projection the same way as in the ledger.
- **Month boundaries are visible.** When a month needs less in the Bills account than the last one left, the Timeline shows the extra you can move out (or the amount to add) instead of silently jumping.

## Moving from v117

In v117 tap **Export JSON**, then in this app open **Plan › Backup & import** (or the Welcome screen) and import that file. You'll see a preview before anything is saved, and the import can be undone. Files exported while v117's projected mode was on are recovered to your real numbers.

## Development

```bash
npm install      # uses legacy peer resolution (.npmrc)
npm run dev      # local dev server
npm test         # engine, importer, loan and view-model tests
npm run build    # type-check and production build into dist/
```

`scripts/v117-golden.mjs` runs the real v117 HTML in a headless browser with a frozen clock and writes its numbers for a given export, so the parity tests can compare against them: `PARITY_DIR=<folder> npm test`, where the folder holds `NAME.json` (the export) and `NAME.golden.json`. Keep personal exports out of the repository; `.gitignore` already excludes the usual file names and `local/`.

Icons are generated with `node scripts/make-icons.mjs` (needs Playwright's Chromium).

## Deployment

`.github/workflows/deploy.yml` builds, tests and publishes `dist/` to GitHub Pages on every push. One-time setup in the repository: **Settings › Pages › Build and deployment › Source: GitHub Actions**, then re-run the latest workflow (or push again). The site is served at `https://bill6006.github.io/Bills-App/`.
