# Household Tracker

Static PWA (no build step) + Supabase Auth, Postgres, RLS and Realtime.

## 1. Supabase
1. Create a project at supabase.com.
2. SQL Editor → paste `supabase/schema.sql` → Run. Then run `supabase/002_analytics.sql`, then `supabase/003_wallets_offline.sql`, one after another.
3. Project Settings → API → copy the Project URL and the **anon** key into `config.js` (never the service_role key).
4. Authentication → URL Configuration → set Site URL to your deployed address (needed for email confirmation and password reset).

## 2. Deploy (HTTPS is required for install and offline)
Drag this folder onto app.netlify.com/drop, or push it to GitHub Pages / Vercel. Open the URL once while online.

## 3. iPhone
Open the URL in **Safari** → Share → Add to Home Screen → Add. It opens full-screen without the address bar.
Android: Chrome menu → Install app.

## 4. Invite your father
Create an account, create the household, tap "Invite code" at the top and send it. He signs up, taps "Join household" and pastes the code.

## 5. Offline
Works automatically after the first online load. Purchases made offline are queued on the phone (marked "waiting to sync") and sent when the connection returns. Each has a unique ID, so retries never duplicate.

## Notes
Arabic/English: tap العربية / EN (login screen or top bar). Wallets: Household cash, Bank account, Personal cash; use Transfer to move money between them (not counted as spending). Offline edit/delete works for synced transactions; if someone else changed the same one first, your edit is skipped with a message. Quick-item names and wallet names you rename yourself are not auto-translated.

## Test checklist
Sign up two accounts → join one household → add a purchase on each → confirm both see it live → go offline, add one, reconnect → confirm it appears once → confirm withdrawals do not raise "Today".

## Version 2 (integrity release)
SQL order for a fresh project: schema.sql, 002_analytics.sql, 003_wallets_offline.sql, 004_fix_withdraw.sql, **005_integrity_security.sql**.
Already-deployed project: run only 005 (safe, changes no data, only rules and permissions).

Files: `core.js` holds the single accounting rule set + the per-user offline queue; `index.html` uses it; `tests/unit.test.js` tests it.

Tests: `node tests/unit.test.js` (no setup). Real-database tests: `npm i`, then `SUPABASE_URL=... SUPABASE_ANON_KEY=... node tests/integration.mjs` (Confirm email must be OFF; delete the throwaway users afterwards).

## Version 3 (funds, members, quick purchases)
SQL: after 005 run **006_funds_members_quickitems.sql**. It blocks negative wallets in the database (row-locked, atomic), adds owner-only remove-member and delete-household, quick-item dedupe and wallet names in stats. It changes no existing rows. Wallets that are ALREADY negative stay as they are; only further spending from them is blocked.
Tests: `node tests/unit.test.js` (no setup) and `node tests/integration_v3.mjs` (needs your Supabase).

## Version 4 (new look, quick purchases, delete account)
SQL: after 006 run **007_account_deletion_quickitems.sql**. Deleting an account is done by a server function (no service-role key in the browser). Entries the user made in households that continue are KEPT and shown as "Deleted user". An owner whose household still has other members must remove them or delete the household first; a sole owner's household is deleted with the account.
Quick Purchase = a saved item + price + automatic icon (never a transaction). Tapping its card makes the purchase.
Tests: `npm test` (unit + UI smoke, no setup) and `node tests/integration_v4.mjs` (needs your Supabase).

## Version 5 (delete fix, deleted users, fast start, mobile layout)
SQL: after 007 run **`008 delete fix deleted users.sql`** (safe: changes no rows, no RLS policy and no grant).
Full order for a fresh project: `schema.sql`, `002_analytics.sql`, `003_wallets_offline.sql`, `004 fix withdraw.sql`, `005 integrity security.sql`, `006 funds members quickitems.sql`, `007 account deletion quickitems.sql`, `008 delete fix deleted users.sql`.
(`004 fix withdraw.sql` was missing from the repository and has been reconstructed; a database that already has the original 004 does not need it.)

- **Deleting never needs funds.** The "Insufficient funds" rule applies to new spending/transfers and to edits that take money out, not to removing a record. If you delete an income or top-up whose money was already spent, the wallet shows a negative balance (the app warns first) and cannot be spent from until it is topped up.
- **Sync errors name the operation**: "Expense sync failed (Shoes · EGP 50.00): …", "Delete sync failed …", "Edit sync failed …".
- **Deleted user / Former member**: entries of a deleted account stay and show "Deleted user"; entries of a member who was removed show "Former member". Only the household owner can edit or delete them (unchanged rule).
- **Startup**: the last dashboard is shown from the device at once; the session and fresh data are checked in the background (status pill: "Updating…"). Offline or with the server down the saved data and the offline queue keep working; only a session the server rejects returns to the login screen.
- `supabase.min.js` (supabase-js 2.45.4) is now served from the app itself and precached for offline; the CDNs are only a fallback. **Upload it together with the other files.**

Tests (`npm i` once): `npm test` runs
- `tests/unit.test.js` – accounting rules, offline queue, sync and error attribution;
- `tests/db.test.mjs` – the SQL files above on a real PostgreSQL (embedded binary), as the `authenticated` role with RLS: funds, concurrent spending, deletes, account deletion, permissions;
- `tests/ui.test.mjs` – the real app in headless Chromium against a fake backend: startup (cached / slow / offline / expired / server down), deletes, offline queue, layout on iPhone / Android / iPad, safe areas, Arabic RTL, service worker.

## Version 6 — Home redesign, Quick Purchase names, built-in catalog

**Database:** run `009 quick purchase catalog.sql` in the Supabase SQL editor (after 008). It adds two nullable
columns to `quick_items` (`key`, `icon`), tags the ten original starter items as built-in, and adds
`save_quick_item()`. No names, prices, transactions, policies or grants change. The app also works *before* 009
is run (it falls back to the older `upsert_quick_item`; chosen icons are then not stored).

**Quick Purchase names**
- The Arabic UI used to be produced by a find-and-replace over all on-screen text, and the dictionary contained the
  starter item names. Any custom name containing one of those words ("Bread basket", "Fish food") was partly
  rewritten on screen. Now user-entered text (custom item names, categories, notes, member names, renamed wallets)
  is marked `data-nt` and never passes through that translator.
- Built-in items carry a `key` and are shown in the app language from the catalog in `core.js` (`CATALOG`).
  Custom items have no key and are always shown exactly as stored.
- Icon = icon chosen by the user → built-in icon → closest match on the name (English or Arabic) → 🛒.

**Home:** "Add item" (last tile in Quick Purchases) opens the built-in list (Bread, Vegetables, Fruits,
Food & groceries); "Custom item…" opens the expense form with "Add to Quick Purchases" switched on, including an
icon chooser. "Edit prices" also shows a × on each tile to remove it (past transactions are unaffected).

**Tests:** `npm test` → unit 23, database 32, UI 31.
