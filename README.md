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

## Version 7 — Web Push (OneSignal)

- `index.html` loads the OneSignal Web SDK v16 **after** the page has loaded and initialises it with the public
  App ID / Safari Web ID. If the SDK cannot be fetched (offline, blocked) the app is unaffected.
- Two service workers, two scopes: `sw.js` (scope `/`) still does offline + caching; OneSignal uses
  `push/onesignal/OneSignalSDKWorker.js` (scope `/push/onesignal/`). `sw.js` never caches OneSignal requests.
- Subscribing: the OneSignal bell (hidden once the device is subscribed) or **Settings → Turn on notifications**.
  On iPhone/iPad push only works when the app was added to the Home Screen (iOS 16.4+).
- OneSignal dashboard: the **Site URL** must be exactly the address the app is served from. If the web
  configuration is "Typical Site", set under *Advanced Push Settings → Service Workers*: path `/push/onesignal/`,
  filename `OneSignalSDKWorker.js`, scope `/push/onesignal/`.
- No private OneSignal key is in the repository. Sending notifications from the backend would need the REST API key
  in a server-side secret (e.g. a Supabase Edge Function), never in this frontend.
- Tests: `npm test` → unit 23, database 32, UI 35.

## Version 8 — Household-only transaction notifications (stage 1)

When a transaction is **committed** in the database, the *other* members of that household get a push
notification. The person who made the entry is not notified about their own entry.

**Setup (once)**
1. SQL editor: run `010 transaction notifications.sql` (after 009).
2. Edge Functions: deploy `supabase/functions/notify-transactions/index.ts` under the name `notify-transactions`
   (dashboard editor: create function → paste the file; or `supabase functions deploy notify-transactions`).
   Switch "Verify JWT with legacy secret" OFF for this function (`supabase/config.toml` does that for CLI
   deploys). The function is still not public: it confirms the caller's session with Supabase Auth and answers
   401 otherwise. A 401 whose text is `Invalid JWT` comes from the gateway (setting still on); a 401 whose text
   starts with `not signed in - …` comes from the function and names the reason.
3. Edge Functions → Secrets: add `ONESIGNAL_REST_API_KEY` (OneSignal → Settings → Keys & IDs → REST API key).
   Optional secret: `APP_URL` (page opened when a notification is tapped).

**How it works**
- Trigger `tx_notify_outbox` (AFTER INSERT on `transactions`) writes one row to `notification_outbox` inside the
  same database transaction. Rejected / rolled-back entries leave nothing; `transaction_id` is unique.
- The app calls the Edge Function with the user's login token and **no parameters** (a) right after its entries
  were saved and (b) once each time the app is opened. The function asks Supabase Auth who is calling, then
  `push_claim()` hands out the due rows of the caller's household(s), one run at a time.
- Recipients are decided by the database function `push_targets(household, creator)`: devices of the *current*
  members (`members` ⨝ `push_devices`) except the creator. A future notification-preference system changes only
  this function.
- `push_devices` maps a OneSignal subscription (one browser/phone) to the signed-in user. The app registers it
  after login, removes it at log-out; a subscription has one owner; rows disappear with a deleted account.
- A queued notification stays deliverable until processed. Temporary problems (network, OneSignal 5xx/429,
  wrong key) put it back in the queue with a back-off. It is closed as `failed` (reason in
  `notification_outbox.error`) only when: OneSignal rejects the request as invalid (4xx), 10 attempts failed, or
  it could not be delivered for 48 hours. `skipped` = nobody but the creator has a subscribed device.
- No duplicates: one row per transaction, one run per row, the same OneSignal idempotency key on every attempt,
  and a language batch that was accepted is never sent again.
- Neither table is reachable from the browser; `push_claim` / `push_done` / `push_targets` are service-role only.

**Known limitation (stage 1):** delivery is started by an app of a household member (the creator's, right after
saving; otherwise the next member who opens the app). If the creator closes the app in the instant between
"saved" and that call, the others are notified only when someone next opens the app. Removing this needs a
server-side starter: a database webhook / `pg_net` call on insert plus a `pg_cron` job for retries, calling this
same function with a server credential. Not included in this stage.

**Tests:** `npm test` → unit 23, database 32, notifications 27 (real Postgres + the real function code + a
stand-in OneSignal), UI 45.

### Notifications stay `pending` (attempts 0) — how to find the reason

The app calls the Edge Function `notify-transactions` after every saved entry and once at every app start. Since
this version the answer is never swallowed: a setup problem is shown once per app start
("Notifications were not sent: …") and the full answer is kept in `window.HTNotifyLast`.

| Message | Meaning | Fix |
|---|---|---|
| the server function "notify-transactions" was not found (HTTP 404) | not deployed, or deployed under another name | deploy it with exactly this name |
| the server refused the login token (HTTP 401 …Invalid JWT / …Missing authorization header) | the gateway's "Verify JWT" check rejects the user token | switch "Verify JWT with legacy secret" OFF for this function (it verifies the user itself) |
| the server refused the login token (HTTP 401: not signed in) | the function could not confirm the user with Supabase Auth | log out and in again |
| the server key ONESIGNAL_REST_API_KEY is missing | secret absent or named differently | add the secret with exactly this name |
| server error (HTTP 500: claim failed - …) | the database function `push_claim` could not be called; the text after the dash is the database's reason | run the current `010 transaction notifications.sql` |

Rows that are still `pending` are delivered by the first successful call - no manual step.
