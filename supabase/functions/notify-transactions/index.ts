// Supabase Edge Function: notify-transactions
// ---------------------------------------------------------------------------------------------------------------
// Sends the push notifications that are due for NEW transactions - to the members of the household that owns the
// transaction, and to nobody else.
//
// The browser calls this function (with the user's normal login token and NO parameters) right after its entries
// were saved. The function decides nothing from browser input:
//   1. it asks Supabase Auth who the caller is (the token must be valid);
//   2. the database function push_claim() hands out the notifications that are due for the caller's household(s),
//      each exactly once, together with the devices of the CURRENT members of that household;
//   3. it sends them through the OneSignal REST API and records the result with push_done().
// A OneSignal failure is only recorded: the transaction was committed before any of this started.
//
// Secret required (Supabase > Edge Functions > Secrets):  ONESIGNAL_REST_API_KEY
// Optional: ONESIGNAL_APP_ID (defaults to the app's public id), NOTIFY_SKIP_CREATOR=true (do not notify the person
// who made the entry), APP_URL (page opened when a notification is tapped).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided to every Edge Function by Supabase.
// (This file is plain JavaScript on purpose so the same code is exercised by the repository's tests.)

const DEFAULT_APP_ID = '80a0910d-f366-4e2a-9a97-ca1fb05b0fd4';       // public value, same as in index.html
const ONESIGNAL_URL = 'https://api.onesignal.com/notifications';

/* Arabic names of the app's built-in quick purchases (same list as CATALOG in core.js) and built-in wallet names.
   Only exact built-ins are translated; anything a user typed is sent exactly as stored. */
const AR_ITEMS = {"bread":"خبز","tomatoes":"طماطم","potatoes":"بطاطس","onions":"بصل","cucumbers":"خيار","carrots":"جزر","green_peppers":"فلفل أخضر","eggplant":"باذنجان","zucchini":"كوسة","molokhia":"ملوخية","lettuce":"خس","cabbage":"كرنب","garlic":"ثوم","peas":"بسلة","green_beans":"فاصوليا خضراء","spinach":"سبانخ","bananas":"موز","apples":"تفاح","oranges":"برتقال","mandarins":"يوسفي","mango":"مانجو","grapes":"عنب","guava":"جوافة","strawberries":"فراولة","watermelon":"بطيخ","cantaloupe":"شمام","peaches":"خوخ","pomegranates":"رمان","chicken":"فراخ","meat":"لحمة","fish":"سمك","eggs":"بيض","milk":"لبن","cheese":"جبنة","yogurt":"زبادي","rice":"رز","pasta":"مكرونة","lentils":"عدس","beans":"فول","cooking_oil":"زيت","sugar":"سكر","flour":"دقيق","vegetables":"خضار","fruits":"فاكهة","other_groceries":"بقالة أخرى"};
const AR_WALLETS = { 'Household cash': 'نقدية المنزل', 'Bank account': 'حساب بنكي', 'Personal cash': 'نقدية شخصية' };
const SYSTEM_LABELS = ['Transfer', 'Withdraw cash', 'Add income', 'Expense', 'Cash back to bank'];

const TEXT = {
  en: {
    title: { expense: 'New expense', income: 'New income', withdraw: 'Cash withdrawal', deposit: 'Cash deposited', transfer: 'Transfer', other: 'New transaction' },
    someone: 'Someone',
    money: (a) => 'EGP ' + a,
    expense: (who, amt, what) => `${who} added ${amt}` + (what ? ` for ${what}` : ' expense'),
    income: (who, amt, what) => `${who} added ${amt} income` + (what ? ` (${what})` : ''),
    withdraw: (who, amt, what, route) => `${who} withdrew ${amt}` + (route ? `: ${route}` : '') + (what ? ` (${what})` : ''),
    deposit: (who, amt, what, route) => `${who} deposited ${amt}` + (route ? `: ${route}` : '') + (what ? ` (${what})` : ''),
    transfer: (who, amt, what, route) => `${who} transferred ${amt}` + (route ? `: ${route}` : '') + (what ? ` (${what})` : ''),
    other: (who, amt, what) => `${who} added ${amt}` + (what ? ` (${what})` : ''),
    arrow: ' → ',
  },
  ar: {
    title: { expense: 'مصروف جديد', income: 'دخل جديد', withdraw: 'سحب نقدي', deposit: 'إيداع نقدي', transfer: 'تحويل', other: 'معاملة جديدة' },
    someone: 'أحد الأعضاء',
    money: (a) => a + ' جنيه',
    expense: (who, amt, what) => `أضاف ${who} مصروفًا بقيمة ${amt}` + (what ? `: ${what}` : ''),
    income: (who, amt, what) => `أضاف ${who} دخلًا بقيمة ${amt}` + (what ? ` (${what})` : ''),
    withdraw: (who, amt, what, route) => `سحب ${who} ${amt}` + (route ? `: ${route}` : '') + (what ? ` (${what})` : ''),
    deposit: (who, amt, what, route) => `أودع ${who} ${amt}` + (route ? `: ${route}` : '') + (what ? ` (${what})` : ''),
    transfer: (who, amt, what, route) => `حوّل ${who} ${amt}` + (route ? `: ${route}` : '') + (what ? ` (${what})` : ''),
    other: (who, amt, what) => `أضاف ${who} معاملة بقيمة ${amt}` + (what ? ` (${what})` : ''),
    arrow: ' ← ',
  },
};

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const amount = (a) => { const n = Number(a); return Number.isFinite(n) ? n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(a); };

/** Title + body of one notification in one language. Pure function (unit-tested). */
export function compose(n, lang) {
  const L = TEXT[lang === 'ar' ? 'ar' : 'en'], ar = L === TEXT.ar;
  const type = L.title[n.type] ? n.type : 'other';
  const who = clip(n.actor, 40) || L.someone;
  const wallet = (w) => (w ? (ar && AR_WALLETS[w]) || clip(w, 30) : '');
  // what it was for: the built-in item (localized by key), else the stored text; app-generated labels say nothing new
  let what = '';
  const cat = String(n.category || '').trim(), note = String(n.note || '').trim();
  if (cat && !SYSTEM_LABELS.includes(cat)) what = ar && n.builtin_key && AR_ITEMS[n.builtin_key] ? AR_ITEMS[n.builtin_key] : clip(cat, 60);
  if (note && note !== cat) what = what ? `${what} · ${clip(note, 60)}` : clip(note, 60);
  const route = n.wallet && n.to_wallet ? wallet(n.wallet) + L.arrow + wallet(n.to_wallet) : '';
  return { title: '🔔 ' + L.title[type], body: L[type](who, L.money(amount(n.amount)), what, route) };
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** The whole function. `env` and `fetchFn` are parameters so it can be tested without Supabase or OneSignal. */
export async function handle(req, env, fetchFn = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, ''), service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !service) return reply(500, { error: 'function is not configured' });

  // 1. who is calling? Ask Supabase Auth - never trust anything in the request body.
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return reply(401, { error: 'not signed in' });
  let uid = null;
  try {
    const r = await fetchFn(`${base}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY || service } });
    if (r.ok) uid = (await r.json()).id || null;
  } catch (_e) { return reply(503, { error: 'auth unavailable' }); }
  if (!uid) return reply(401, { error: 'not signed in' });

  // Without the OneSignal key nothing is claimed (rows simply expire) - the app itself is unaffected.
  const key = env.ONESIGNAL_REST_API_KEY;
  if (!key) { console.error('notify-transactions: ONESIGNAL_REST_API_KEY is not set'); return reply(200, { configured: false, claimed: 0, sent: 0, failed: 0 }); }

  const rpc = async (fn, args) => {
    const r = await fetchFn(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`${fn}: ${r.status} ${clip(await r.text(), 200)}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };

  // 2. the notifications that are due for the caller's household(s); each can be claimed exactly once
  let due;
  try { due = (await rpc('push_claim', { caller: uid })) || []; }
  catch (e) { console.error('notify-transactions: claim failed', String(e && e.message || e)); return reply(500, { error: 'claim failed' }); }

  const skipCreator = /^(1|true|yes)$/i.test(String(env.NOTIFY_SKIP_CREATOR || ''));
  const appId = env.ONESIGNAL_APP_ID || DEFAULT_APP_ID;
  const auth = (/^os_v2_/.test(key) ? 'Key ' : 'Basic ') + key;
  let sent = 0, failed = 0;

  // 3. send: one request per language, every device at most once
  for (const n of due) {
    let devices = 0; const errors = [], bad = []; let ok = 0, tried = 0; const seen = new Set();
    const mine = new Set(skipCreator ? (n.actor_devices || []) : []);
    for (const lang of ['en', 'ar']) {
      const ids = [...new Set((n.targets && n.targets[lang]) || [])].filter((id) => !mine.has(id) && !seen.has(id));
      ids.forEach((id) => seen.add(id));
      if (!ids.length) continue;
      tried++;
      const msg = compose(n, lang);
      const body = { app_id: appId, target_channel: 'push', include_subscription_ids: ids, idempotency_key: lang === 'ar' ? n.key_ar : n.key_en,
        headings: { en: msg.title }, contents: { en: msg.body } };                      // "en" is OneSignal's default slot; the text is already in the device owner's app language
      if (env.APP_URL) body.web_url = env.APP_URL;
      try {
        const r = await fetchFn(ONESIGNAL_URL, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
        let j = {}; try { j = await r.json(); } catch (_e) { /* not JSON */ }
        const inv = j && j.errors && !Array.isArray(j.errors) ? [].concat(j.errors.invalid_player_ids || [], j.errors.invalid_subscription_ids || []) : [];
        inv.forEach((x) => bad.push(String(x)));
        if (r.ok) {
          ok++; devices += Math.max(0, ids.length - inv.length);
          if (j && !j.id) errors.push(`${lang}: accepted but not delivered ${clip(JSON.stringify(j.errors || ''), 160)}`);   // e.g. "All included players are not subscribed"
        } else errors.push(`${lang}: HTTP ${r.status} ${clip(JSON.stringify(j && j.errors || j), 200)}`);
      } catch (e) { errors.push(`${lang}: ${clip(e && e.message || e, 200)}`); }
    }
    const status = tried === 0 ? 'skipped' : ok === tried ? 'sent' : ok > 0 ? 'sent' : 'failed';
    if (status === 'failed') { failed++; console.error('notify-transactions: OneSignal failed for', n.id, errors.join(' | ')); } else if (status === 'sent') sent++;
    try { await rpc('push_done', { nid: n.id, st: status, n: devices, err: errors.length ? errors.join(' | ') : (tried === 0 ? 'no subscribed devices' : null), bad: bad.length ? bad : null }); }
    catch (e) { console.error('notify-transactions: could not record result', String(e && e.message || e)); }
  }
  return reply(200, { configured: true, claimed: due.length, sent, failed });
}

// Supabase / Deno entry point (absent when the file is imported by the Node tests)
if (typeof Deno !== 'undefined' && Deno.serve) Deno.serve((req) => handle(req, Deno.env.toObject()));
