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
