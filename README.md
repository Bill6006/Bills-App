# Bills Planner

A paycheck-first planner for bills, spending money, savings and loans, rebuilt from Bills Account Planner v117.

Every paycheck splits three ways: a fixed amount moves to your **Bills account**, a fixed amount moves to **Savings**, and the rest is **yours to spend**. The app works out those amounts so the Bills account never drops below your cushion and always carries enough into next month. It's a guide: it shows what each account *should* have today, and you keep your bank in line with it. You don't enter your real balances.

- **Installable PWA.** Add it to your home screen; it works offline and updates itself.
- **Private.** Everything is stored on your device (IndexedDB). Optional **cloud sync** keeps an end-to-end encrypted copy on a small Cloudflare Worker, which only ever sees scrambled bytes. No accounts with anyone, no tracking. This repository contains only app code, never anyone's data.
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
- **To review** holds the rest: one tap for a suggested budget, **Split** to divide one purchase across budgets, or **Not spending**. Suggestions update as you go, so after one purchase from a store the others from it suggest the same budget. Each purchase counts in the pay period (or month) it was made, so filing a purchase from an earlier period doesn't change the current one.
- **Bills**: a charge that's one of your bills isn't spending. **Pick a budget › It's a bill** (or **Not spending › It's one of my bills**) marks it as one of your bills, or adds it as a new bill. The bank's text is remembered for that bill, so the next charge is recognized on its own. When a charge names one of your bills but its amount is far from the plan's, it asks "Looks like your Ionos bill" and lets you say what happened: the price went up (the bill changes from now on), a one-time extra (the planned amount is the bill and the rest comes out of a budget, Unassigned unless you pick another), or count it all as the bill. Bills named after a store where you also shop (Google Play Pass, Amazon Prime) only match by their whole name.
- **Not spending is skipped**: transfers between your accounts, your paycheck, card payments and bills that are already in your plan.
- **Nothing is counted twice**: transactions from earlier imports are recognized (the bank's id in QFX/OFX; date, amount and text in CSV, with identical same-day purchases kept apart), the same purchase from a CSV and a QFX is matched, purchases you logged by hand are linked instead of added (you're asked when a log is close but not exact, or dated days away from the purchase), and pending charges wait until they post. A whole import can be removed again.
- The first CSV from a bank shows how its columns were read so you can correct them once; after that the layout is remembered.
- **PDF statements** are read from their transaction tables: the column headings say which text is the date, description, type and amount, a table that continues on the next page is followed, and the store's bank text printed under its name is kept. Money in or out comes from the transaction type (Purchase, Refund, Fee, Transfer), money in / money out columns, the section (Deposits, Withdrawals) or the kind of account (a card or a bank account). Every table with a total line is checked against it, and the preview says whether everything added up. Scanned (picture-only) PDFs can't be read. The PDF reader ([pdf.js](https://mozilla.github.io/pdf.js/)) loads only when a PDF is picked and is cached for offline use.

## Loans update themselves

Each loan's payment is planned as a bill on its due day. With automatic payments on (the default), the balance drops on each due date as if the scheduled payment went through, so there's nothing to log month to month. Log a payment only when it's extra or different:

- An **extra** payment lowers the balance and leaves the schedule alone.
- A payment **instead of** a scheduled one replaces it (and undoes the automatic one if it was already applied).
- Editing or deleting a payment moves the balance by that payment only, so a balance you typed in from your lender stays put.

If a loan's last logged payment is months old (common right after importing), the loan asks whether those payments were made and can record them for you, or you can type the balance your lender shows.

## Cloud sync

Chrome can delete a site's storage when the phone runs low on space. With **Plan › Cloud sync** turned on, that no longer loses anything:

- You pick a **sync name** and **sync password** once, and let Chrome's password manager save them.
- A few seconds after every change the app uploads an encrypted copy. It also checks for a newer copy when it opens, when you come back to it, and every few minutes, so a phone and a computer stay in step.
- If the app's storage is wiped (or on a new phone), the app opens empty and restores itself using the password Chrome saved. If Chrome can't hand it over silently, tap **Restore from the cloud** on the Welcome screen.
- The cloud keeps every version from the last day and one a day for 30 days (**Earlier versions**).
- If this device and the cloud copy both changed since they last matched, the app asks which one to keep. An empty or sample-data app never uploads over a real copy.

**Privacy.** The password never leaves the device. PBKDF2 (600,000 rounds) turns the name and password into an AES-GCM key (data is gzipped, then encrypted on the device), an access token the server stores only as a hash, and a key for a checksum that lets two copies be compared without decrypting them. The Worker stores ciphertext only. Forgetting the password means the cloud copy can't be opened by anyone. The code is in `src/sync/` (app) and `worker/` (server).

### Running the sync server

`worker/` is a Cloudflare Worker named `bills-sync`. Each sync name is a SQLite-backed Durable Object, which works on the free plan and needs nothing created by hand. It deploys from this repository through **Cloudflare Workers Builds**:

| Setting | Value |
|---|---|
| Worker name | `bills-sync` (must match `worker/wrangler.jsonc`) |
| Root directory | `worker` |
| Build command | `npm run build` (type-checks the Worker) |
| Deploy command | `npx wrangler deploy` |

To set it up: Cloudflare dashboard › **Workers & Pages** › **Create** › **Import a repository**, connect GitHub (only this repository), pick it and enter the settings above. After the first deploy, put the Worker's address (`https://bills-sync.<your-subdomain>.workers.dev`) in `DEPLOYED_URL` in `src/sync/config.ts`. Until it's set, the app hides every sync control. The Worker accepts browser calls only from the origins in `ALLOWED_ORIGINS` (`worker/wrangler.jsonc`) and from localhost.

Local development: `cd worker && npm install && npm run dev` starts it at `http://127.0.0.1:8787`, then start the app with `VITE_SYNC_URL=http://127.0.0.1:8787` (for example in `.env.development.local`). `npm run smoke` in `worker/` runs end-to-end checks against the running Worker.

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
npm test         # engine, importer, loan, view-model and sync tests
npm run build    # type-check and production build into dist/
```

`scripts/v117-golden.mjs` runs the real v117 HTML in a headless browser with a frozen clock and writes its numbers for a given export, so the parity tests can compare against them: `PARITY_DIR=<folder> npm test`, where the folder holds `NAME.json` (the export) and `NAME.golden.json`. Keep personal exports out of the repository; `.gitignore` already excludes the usual file names and `local/`.

Icons are generated with `node scripts/make-icons.mjs` (needs Playwright's Chromium).

## Deployment

`.github/workflows/deploy.yml` builds, tests and publishes `dist/` to GitHub Pages on every push. The sync server deploys separately through Cloudflare Workers Builds (see **Running the sync server**). One-time setup in the repository: **Settings › Pages › Build and deployment › Source: GitHub Actions**, then re-run the latest workflow (or push again). The site is served at `https://bill6006.github.io/Bills-App/`.
