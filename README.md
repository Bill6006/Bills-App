# Bills Planner

A paycheck-first planner for bills, spending money, savings and loans, rebuilt from Bills Account Planner v117.

Every paycheck splits three ways: a fixed amount moves to your **Bills account**, a fixed amount moves to **Savings**, and the rest is **yours to spend**. The app works out those amounts so the Bills account never drops below your cushion and always carries enough into next month. It's a guide: it shows what each account *should* have today, and you keep your bank in line with it.

- **Installable PWA.** Add it to your home screen; it works offline and updates itself.
- **Private.** Everything is stored on your device (IndexedDB). There is no server, account or tracking. This repository contains only app code, never anyone's data.
- **Same math as v117.** The calculation engine in `src/engine` is a tested port of v117's formulas, with a short list of deliberate bug fixes.

## Moving from v117

In v117 tap **Export JSON**, then in this app open **Plan › Backup & import** and import that file. You'll see a preview before anything is saved, and the import can be undone.

## Development

```bash
npm install      # uses legacy peer resolution (.npmrc)
npm run dev      # local dev server
npm test         # engine and importer tests
npm run build    # type-check and production build into dist/
```

Icons are generated with `node scripts/make-icons.mjs` (needs Playwright's Chromium).

## Deployment

`.github/workflows/deploy.yml` builds, tests and publishes `dist/` to GitHub Pages on every push. One-time setup in the repository: **Settings › Pages › Build and deployment › Source: GitHub Actions**. The site is served at `https://bill6006.github.io/Bills-App/`.
