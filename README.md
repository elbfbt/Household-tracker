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
