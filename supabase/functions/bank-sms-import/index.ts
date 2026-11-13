// Supabase Edge Function: bank-sms-import
// ---------------------------------------------------------------------------------------------------------------
// Bank SMS text  ->  authenticated import key  ->  deterministic parser  ->  ONE normal Household Tracker
// transaction (database function bank_import_commit, migration 011)  ->  the existing notification outbox.
//
//   POST  { "sender": "BanK-AIAhly", "text": "<the SMS>", "dry_run": false }
//   Header  Authorization: Bearer htk_...      (or  X-Import-Key: htk_...)
//
// * The import key decides the user, the household and the wallets. Nothing in the request body can change them
//   (user_id / household_id / wallet_id fields are never read).
// * The parser is a list of provider- and type-specific RULES (see VERIFIED_RULES below). No AI, no guessing: if not exactly
//   one kind of transaction is recognised, or the amount / date is not clean, nothing is created (unrecognized_sms).
// * The same bank transaction can only ever be recorded once (fingerprint, unique in the database).
// * This function does not talk to OneSignal. After an import it only asks the existing notify-transactions
//   function to process the outbox; if that call fails the notification simply stays queued.
// * The SMS text is never stored and never logged - only hashes, the rule that matched and the outcome.
//
// No new secret is needed: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every Edge Function.
// "Verify JWT" must be OFF for this function (the caller is a phone automation, not a browser session); the
// function authenticates every request itself with the import key.
// (Plain JavaScript on purpose, so the same file is exercised by the repository's tests.)

/* ============================== 1. text helpers ============================== */
const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٫': '.', '٬': ',' };

/** Cleans an SMS without changing its words: Arabic digits -> 0-9, invisible marks removed, whitespace collapsed. */
export function cleanSms(s) {
  return String(s == null ? '' : s).normalize('NFC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u0640\u064B-\u0652]/g, '')   // bidi marks, tatweel, diacritics
    .replace(/[٠-٩۰-۹٫٬]/g, (c) => DIGITS[c])
    .replace(/\s+/g, ' ').trim();
}
/** Matching form of a cleaned SMS. SAME LENGTH as the input (so positions map back to the original words):
    A-Z lower-cased, Arabic alef variants and final ya unified. Used only to recognise, never to display. */
export function foldSms(clean) {
  return clean.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
}

/** "1,250.50" -> 1250.5 ; "2000" -> 2000 ; anything ambiguous or malformed ("1,50", "1.500", "12,34,567") -> null. */
export function parseAmount(s) {
  s = String(s == null ? '' : s).trim();
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1e10 ? Math.round(n * 100) / 100 : null;
}

/* ---- Africa/Cairo (the app's time zone; handles summer time) ---- */
const CAIRO = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const cairoParts = (ts) => { const o = {}; for (const p of CAIRO.formatToParts(new Date(ts))) o[p.type] = Number(p.value); return o; };
const cairoOffset = (ts) => { const p = cairoParts(ts); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000; };
/** A Cairo wall-clock time -> the instant (ms). */
export function cairoToUtc(y, m, d, hh = 0, mm = 0, ss = 0) {
  const local = Date.UTC(y, m - 1, d, hh, mm, ss);
  const first = local - cairoOffset(local - 2 * 3600e3);
  return local - cairoOffset(first);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const RE_ISO = /(?<![\d/.-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d/-])/gu;
const RE_DMY = /(?<![\d/.-])(\d{1,2})([/-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d/-])/gu;
const RE_DMON = /(?<![\d/.-])(\d{1,2})[ -]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:[ ,-]{1,2}(\d{4}|\d{2})(?![:\d]))?/gu;
const RE_TIME = /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?(am|pm|ص|م)(?![\p{L}]))?(?![\d:])/gu;

/** The transaction date/time written in the SMS (day/month order, Cairo time).
    -> { at: ms, source: 'sms' | 'sms_date_only' }  |  { source: 'none' }  |  { error: reason }                      */
export function findDate(fold, now) {
  const found = [];
  let rest = fold;
  const blank = (m) => { rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length); };
  for (const m of fold.matchAll(RE_ISO)) { found.push({ y: +m[1], mo: +m[2], d: +m[3], end: m.index + m[0].length, start: m.index }); blank(m); }
  for (const m of rest.matchAll(RE_DMON)) { found.push({ y: m[3] ? +m[3] : null, mo: MONTHS[m[2]], d: +m[1], end: m.index + m[0].length, start: m.index }); blank(m); }
  for (const m of rest.matchAll(RE_DMY)) found.push({ y: m[4] ? +m[4] : null, mo: +m[3], d: +m[1], end: m.index + m[0].length, start: m.index });
  if (!found.length) return { source: 'none' };
  const today = cairoParts(now);
  const days = new Set();
  for (const f of found) {
    if (f.y !== null && f.y < 100) f.y += 2000;
    f.assumedYear = f.y === null;
    if (f.y === null) f.y = today.year;
    const chk = new Date(Date.UTC(f.y, f.mo - 1, f.d));
    if (f.mo < 1 || f.mo > 12 || f.d < 1 || f.d > 31 || chk.getUTCMonth() !== f.mo - 1 || chk.getUTCDate() !== f.d) return { error: 'date_malformed' };
    days.add(`${f.y}-${f.mo}-${f.d}`);
  }
  if (days.size > 1) return { error: 'date_ambiguous' };                 // several different dates: which one is the transaction?
  const f = found[0];
  // a time counts only when it is written right next to the date ("12/11/2026 14:35", "on 12/11 at 14:35")
  let time = null;
  for (const m of fold.matchAll(RE_TIME)) {
    const gap = m.index >= f.end ? m.index - f.end : f.start - (m.index + m[0].length);
    if (gap < 0 || gap > 14) continue;
    let hh = +m[1]; const mi = +m[2], ss = m[3] ? +m[3] : 0, ap = m[4];
    if (ap) { if (hh < 1 || hh > 12) return { error: 'date_malformed' }; if (ap === 'pm' || ap === 'م') hh = hh % 12 + 12; else hh = hh % 12; }
    if (hh > 23 || mi > 59 || ss > 59) return { error: 'date_malformed' };
    time = { hh, mi, ss }; break;
  }
  const make = (y) => cairoToUtc(y, f.mo, f.d, time ? time.hh : 12, time ? time.mi : 0, time ? time.ss : 0);
  let at = make(f.y);
  if (f.assumedYear && at > now + 86400e3) at = make(f.y - 1);            // "31/12" read on 1 January
  if (at > now + 86400e3) return { error: 'date_in_future' };
  if (at < now - 90 * 86400e3) return { error: 'date_too_old' };
  return { at, source: time ? 'sms' : 'sms_date_only' };
}

/** A date read from a FIXED position of a known message (shape rules). y may be missing (the year of receipt). */
export function resolveDate(g, now) {
  if (g.d === undefined || g.mo === undefined) return { source: 'none' };
  const d = +g.d, mo = +g.mo, hasTime = g.hh !== undefined, hh = hasTime ? +g.hh : 12, mi = hasTime ? +g.mi : 0;
  let y = g.y === undefined ? null : +g.y; if (y !== null && y < 100) y += 2000;
  const assumed = y === null; if (assumed) y = cairoParts(now).year;
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d || hh > 23 || mi > 59) return { error: 'date_malformed' };
  let at = cairoToUtc(y, mo, d, hh, mi, 0);
  if (assumed && at > now + 86400e3) { const c2 = new Date(Date.UTC(y - 1, mo - 1, d)); if (c2.getUTCDate() !== d) return { error: 'date_malformed' }; at = cairoToUtc(y - 1, mo, d, hh, mi, 0); }
  if (at > now + 86400e3) return { error: 'date_in_future' };
  if (at < now - 90 * 86400e3) return { error: 'date_too_old' };
  return { at, source: hasTime ? 'sms' : 'sms_date_only' };
}

/* ============================== 2. the rules ============================== */
// Building blocks. All patterns run on the FOLDED text (lower-case latin, unified alef/ya).
const NB = '(?<![\\p{L}\\p{N}])', NA = '(?![\\p{L}\\p{N}])';                 // "not inside a word"
const W = (alt) => new RegExp(`${NB}(?:${alt})${NA}`, 'u');                  // whole word(s)
const A = (alt) => new RegExp(`(?:${alt})`, 'u');                            // Arabic stem (prefixes/suffixes allowed)
const CUR = `(?:egp|l\\.?e\\.?|جنيها? مصريا?|جنيها?|ج\\.م\\.?|جم)`;         // Egyptian pounds only
const NUM = `\\d[\\d,.]*\\d|\\d`;
// money = currency next to the number, in either order. The number is validated separately (parseAmount).
const money = (x = '') => `(?:${NB}${CUR}\\s?(?<a${x}>${NUM})(?![\\d])|(?<![\\p{L}\\p{N}.,])(?<b${x}>${NUM})\\s?${CUR}${NA})`;
const MONEY = money();
const AR_FILL = `(?:\\s+(?:نقدي|لحظي|تحويل|مبلغ|بمبلغ|قيمه|قيمة|بقيمه|بقيمة|عمليه|عملية))*`;
const EN_FILL = `(?:\\s+(?:with|of|for|by|an|the|amount|transaction))*`;
// where a merchant / person name ends
const END = `(?=\\s+(?:on|at|dated|date|ref|reference|available|avl|bal|balance|your|using|with|via|to|from|was|has|is|transaction|trx|بتاريخ|يوم|الساعه|الساعة|الرصيد|رصيدكم|رقم|مرجع|في|من|الي|عبر)${NA}|\\s+علي\\s+(?:محفظ|حساب|بطاق)|\\s+\\d{1,2}[/-]\\d|[.،,;]\\s|[.،,;]?$)`;
const PARTY = `(?!\\d{1,2}:\\d{2})(?<party>\\S[^\\n]{0,58}?\\S)${END}`;
const amt = (lead, fill) => new RegExp(`(?:${lead})${fill}\\s+${MONEY}`, 'ud');
const party = (lead) => new RegExp(`(?:${lead})\\s+${PARTY}`, 'ud');
const RE_REF = new RegExp(`${NB}(?:ref(?:erence)?(?:\\s*(?:no|number|id))?|transaction\\s*(?:id|no|number)|trx\\s*(?:id|no)?|رقم مرجعي|الرقم المرجعي|رقم المرجع|رقم العمليه|رقم العملية|مرجع)\\.?\\s*[:#-]?\\s*(?<ref>[a-z0-9]{4,30})${NA}`, 'ud');

/* Who sends which family of messages. A sender not listed here is refused (sender_not_supported).
   l / I / 1 are treated as the same character: "BanK-AIAhly" and "BanK-AlAhly" look identical on a phone. */
export const SENDERS = {
  nbe: ['BanK-AIAhly', 'BanK-AlAhly', 'NBE'],
  vodafone_cash: ['VF-Cash', 'VodafoneCash', 'Vodafone Cash'],
};
export const normSender = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[l1]/g, 'i');
export const issuerOf = (sender) => { const n = normSender(sender); for (const [k, list] of Object.entries(SENDERS)) if (list.some((x) => normSender(x) === n)) return k; return null; };

/* One rule = one message family of one provider, in one language.
     issuer   who sends it (see SENDERS)          provider  the service shown in the result / description
     kind     what happened                       type      the EXISTING app transaction type it becomes
     all      every pattern must be present       none      no pattern may be present
     amount   where THIS kind of message states the transaction amount (never "the first number in the text")
     party    merchant / recipient / sender name, if the message has one
   To support another provider or wording: add a rule here (and a test with a real message). Nothing else changes.

   A rule with "shape" describes the WHOLE structure of one real message: every value is taken from its fixed
   position in that structure (the amount after its own wording, the balance / phone number / reference / advert
   each in their own place), so one can never be mistaken for another. If the wording of such a message changes,
   the shape no longer fits and nothing is created (structure_mismatch). */

/* ---- VERIFIED rules: written against real messages (tests/fixtures/bank-sms.json, "real": true) ---- */
const N = `\\d[\\d,.]*\\d|\\d`;                                  // a number as written (validated by parseAmount)
const EGPW = `(?:جم|جنيها?|ج\\.م\\.?|egp|l\\.?e\\.?)`;               // Egyptian pounds
const PHONE = `01\\d{9}`;
const shape = (src) => new RegExp(src, 'ud');
export const VERIFIED_RULES = [
  // (real messages write the hour word both as "الساعة" and "الساعه")
  // "تم تنفيذ تحويل لحظي من حسابكم رقم 0170 بمبلغ 1.00 جم إلى <name> رقم مرجعي <ref> يوم MM-DD الساعة HH:MM ..."
  { id: 'nbe.instapay_out.ar', issuer: 'nbe', provider: 'instapay', kind: 'transfer_out', type: 'expense', dateOrder: 'md',
    all: [A('تحويل لحظي'), A('تم تنفيذ'), A('من حسابكم')], none: [A('اضاف|استلام|خصم|بطاق')],
    shape: shape(`^تم تنفيذ تحويل لحظي من حسابكم رقم ?\\d{2,8} بمبلغ ?(?<amount>${N}) ?${EGPW} الي (?<party>\\S.{0,78}?\\S) رقم مرجعي ?(?<ref>\\d{6,20}) يوم ?(?<mo>\\d{1,2})-(?<d>\\d{1,2}) الساع[ةه] ?(?<hh>\\d{1,2}):(?<mi>\\d{2})(?!\\d)`) },
  // "تم إضافة تحويل لحظي لحسابكم رقم 0170 بمبلغ 205.00 جم من <name> رقم مرجعي <ref> يوم MM-DD الساعة HH:MM ..."
  { id: 'nbe.instapay_in.ar', issuer: 'nbe', provider: 'instapay', kind: 'transfer_in', type: 'income', dateOrder: 'md',
    all: [A('تحويل لحظي'), A('تم اضافة'), A('لحسابكم')], none: [A('تنفيذ|استلام|خصم|بطاق')],
    shape: shape(`^تم اضافة تحويل لحظي لحسابكم رقم ?\\d{2,8} بمبلغ ?(?<amount>${N}) ?${EGPW} من (?<party>\\S.{0,78}?\\S) رقم مرجعي ?(?<ref>\\d{6,20}) يوم ?(?<mo>\\d{1,2})-(?<d>\\d{1,2}) الساع[ةه] ?(?<hh>\\d{1,2}):(?<mi>\\d{2})(?!\\d)`) },
  // "تم خصم 200 EGP من بطاقة الخصم المباشر رقم2521 عندMansoura Market 2 D يوم12/11/26 الساعة21:43 المتاح11.31EGP ..."
  { id: 'nbe.debit_card_purchase.ar', issuer: 'nbe', provider: 'debit_card', kind: 'card_purchase', type: 'expense', dateOrder: 'dmy',
    all: [A('تم خصم'), A('بطاقة الخصم المباشر'), A('عند')], none: [A('سحب|صراف|atm|رد مبلغ|استرداد|عكس|الغاء|تحويل|ايداع|اضاف|استلام')],
    shape: shape(`^تم خصم ?(?<amount>${N}) ?${EGPW} من بطاقة الخصم المباشر رقم ?\\d{4} عند ?(?<party>\\S.{0,78}?\\S) ?يوم ?(?<d>\\d{1,2})/(?<mo>\\d{1,2})/(?<y>\\d{4}|\\d{2}) الساع[ةه] ?(?<hh>\\d{1,2}):(?<mi>\\d{2}) المتاح ?(?<bal>${N}) ?${EGPW}`) },
  // "تم استلام مبلغ 1.00 جنيه من 010...؛ المسجل بإسم <name> على رقم محفظتك 010... بتاريخ HH:MM YY-MM-DD. رصيدك الحالي: 6.93 جنيه رقم العملية: <ref> ..."
  { id: 'vfc.received.ar', issuer: 'vodafone_cash', provider: 'vodafone_cash', kind: 'transfer_in', type: 'income', dateOrder: 'ymd',
    all: [A('تم استلام مبلغ'), A('محفظتك'), A('رقم العملية')], none: [A('شحن|لحظي|انستاباي|instapay|خصم|تم تحويل|مصاريف الخدمة')],
    shape: shape(`^تم استلام مبلغ ?(?<amount>${N}) ?${EGPW} من ${PHONE} ?[؛;]?(?: ?المسجل باسم (?<party>\\S.{0,78}?\\S))? علي رقم محفظتك ${PHONE} بتاريخ (?<hh>\\d{1,2}):(?<mi>\\d{2}) (?<y>\\d{2})-(?<mo>\\d{1,2})-(?<d>\\d{1,2})\\.? ?رصيدك الحالي: ?(?<bal>${N}) ?${EGPW} ?رقم العملية: ?(?<ref>\\d{6,20})(?!\\d)`) },
  // "تم شحن رصيد موبايلك ب 30 بنجاح وخصم 30 من محفظتك شاملة الضريبة; رصيد حسابك في فودافون كاش الحالي 4.93. <advert>"
  // the amount is what was TAKEN FROM THE WALLET (after "وخصم"); the message carries no date and no reference
  { id: 'vfc.mobile_recharge.ar', issuer: 'vodafone_cash', provider: 'vodafone_cash', kind: 'mobile_recharge', type: 'expense',
    all: [A('تم شحن رصيد موبايلك'), A('من محفظتك'), A('فودافون كاش')], none: [A('استلام|لحظي|انستاباي|instapay|تم تحويل|مصاريف الخدمة|رقم العملية')],
    shape: shape(`^تم شحن رصيد موبايلك ب ?(?<topup>${N}) بنجاح وخصم (?<amount>${N}) من محفظتك(?: شاملة الضريبة)? ?[؛;]? ?رصيد حسابك في فودافون كاش الحالي (?<bal>${N})(?![\\d,]|\\.\\d)`) },
  // "تم تحويل 105 جنيه لرقم 010... مصاريف الخدمة 0 جنيه رصيد حسابك فى فودافون كاش الحالي 3.93. تاريخ العملية HH:MM YY-MM-DD : رقم العملية <ref> : <advert>"
  // the recipient is only a phone number: it is matched and thrown away. The service fee has its own place; only a
  // fee of 0 has been seen, so a message with any other fee is refused (fee_not_verified) instead of guessing
  // whether the fee is part of the amount.
  { id: 'vfc.sent.ar', issuer: 'vodafone_cash', provider: 'vodafone_cash', kind: 'transfer_out', type: 'expense', dateOrder: 'ymd',
    all: [A('تم تحويل'), A('لرقم'), A('مصاريف الخدمة'), A('فودافون كاش'), A('رقم العملية')], none: [A('شحن|استلام|لحظي|انستاباي|instapay|بطاق')],
    shape: shape(`^تم تحويل ?(?<amount>${N}) ?${EGPW} لرقم ${PHONE} مصاريف الخدمة ?(?<fee>${N}) ?${EGPW} رصيد حسابك في فودافون كاش الحالي (?<bal>${N})\\.? ?تاريخ العملية (?<hh>\\d{1,2}):(?<mi>\\d{2}) (?<y>\\d{2})-(?<mo>\\d{1,2})-(?<d>\\d{1,2}) ?:? ?رقم العملية ?:? ?(?<ref>\\d{6,20})(?!\\d)`) },
];

/* ---- PROVISIONAL rules: written from the typical wording of such messages, NOT checked against real ones.
   They are SWITCHED OFF in the deployed function (a message they would match is answered unrecognized_sms) and
   only run in the tests / with the test-only setting BANK_SMS_PROVISIONAL_RULES=on. Each one is to be replaced
   by a verified rule as soon as a real message of that kind is available. ---- */
const EN_NOT_CARD = 'atm|withdraw\\w*|refund\\w*|revers\\w*|instapay|ipn|transfer\\w*|credited|deposit\\w*|received';
const PROVISIONAL = [
  // ---- bank card purchase -> expense on the account wallet
  { id: 'nbe.card_purchase.en', issuer: 'nbe', provider: 'bank_card', kind: 'card_purchase', type: 'expense',
    all: [W('card|visa|mastercard|meeza'), W('charged|purchase|pos|spent|debited')], none: [W(EN_NOT_CARD)],
    amount: amt('charged|purchase|spent|debited', EN_FILL), party: party(`${NB}at|${NB}at merchant`) },
  // ---- ATM cash withdrawal -> withdraw (account wallet -> cash wallet)
  { id: 'nbe.atm_withdrawal.en', issuer: 'nbe', provider: 'atm', kind: 'atm_withdrawal', type: 'withdraw',
    all: [W('atm'), W('withdraw\\w*')], none: [W('refund\\w*|revers\\w*|deposit\\w*|instapay|ipn|transfer\\w*')],
    amount: amt('withdraw\\w*', EN_FILL) },
  { id: 'nbe.atm_withdrawal.ar', issuer: 'nbe', provider: 'atm', kind: 'atm_withdrawal', type: 'withdraw',
    all: [A('سحب'), A('صراف|atm|ماكين')], none: [A('رد مبلغ|استرداد|عكس|الغاء|ايداع|انستاباي|instapay|تحويل')],
    amount: amt('سحب', AR_FILL) },
  // ---- cash paid in -> deposit (cash wallet -> account wallet)
  { id: 'nbe.cash_deposit.en', issuer: 'nbe', provider: 'atm', kind: 'cash_deposit', type: 'deposit',
    all: [W('cash deposit\\w*')], none: [W('refund\\w*|revers\\w*|withdraw\\w*|instapay|ipn')],
    amount: amt('deposit\\w*', EN_FILL) },
  { id: 'nbe.cash_deposit.ar', issuer: 'nbe', provider: 'atm', kind: 'cash_deposit', type: 'deposit',
    all: [A('ايداع نقدي')], none: [A('رد مبلغ|استرداد|عكس|الغاء|سحب|انستاباي|instapay')],
    amount: amt('ايداع', AR_FILL) },
  // ---- account credited (salary, incoming bank transfer...) -> income on the account wallet
  { id: 'nbe.credit.en', issuer: 'nbe', provider: 'bank', kind: 'credit', type: 'income',
    all: [W('credited'), W('account|a/c|acc')], none: [W('instapay|ipn|refund\\w*|revers\\w*|cash deposit\\w*|card|atm')],
    amount: amt('credited', EN_FILL), party: party(`${NB}from`) },
  { id: 'nbe.credit.ar', issuer: 'nbe', provider: 'bank', kind: 'credit', type: 'income',
    all: [A('اضاف'), A('حساب')], none: [A('انستاباي|instapay|لحظي|رد مبلغ|استرداد|عكس|الغاء|ايداع نقدي|بطاق|سحب')],
    amount: amt('اضاف\\S*', AR_FILL), party: party(`\\sمن`) },
  // ---- bank transfer sent to someone -> expense on the account wallet (the money leaves the household)
  { id: 'nbe.transfer_out.en', issuer: 'nbe', provider: 'bank', kind: 'transfer_out', type: 'expense',
    all: [W('transfer\\w*'), W('from your (?:account|a/c|acc)')], none: [W('instapay|ipn|received|credited|refund\\w*|revers\\w*|atm|card')],
    amount: amt('transfer\\w*', EN_FILL), party: party(`${NB}to`) },
  { id: 'nbe.transfer_out.ar', issuer: 'nbe', provider: 'bank', kind: 'transfer_out', type: 'expense',
    all: [A('تحويل'), A('من حساب')], none: [A('انستاباي|instapay|لحظي|استلام|اضاف|رد مبلغ|استرداد|عكس|الغاء|بطاق')],
    amount: amt('تحويل', AR_FILL), party: party(`\\sالي`) },
  // ---- InstaPay (instant payment network) - needs InstaPay's own wording
  { id: 'nbe.instapay_out.en', issuer: 'nbe', provider: 'instapay', kind: 'transfer_out', type: 'expense',
    all: [W('instapay|ipn'), W('sent|transferred|debited|transfer')], none: [W('received|credited|refund\\w*|revers\\w*|vodafone cash')],
    amount: new RegExp(`${NB}(?:sent|transferred|debited|transfer)${EN_FILL}\\s+${MONEY}|${money(2)}\\s+(?:was|has been|have been)\\s+(?:sent|transferred|debited)${NA}`, 'ud'), party: party(`${NB}to`) },
  { id: 'nbe.instapay_in.en', issuer: 'nbe', provider: 'instapay', kind: 'transfer_in', type: 'income',
    all: [W('instapay|ipn'), W('received|credited')], none: [W('sent|transferred|debited|refund\\w*|revers\\w*|vodafone cash')],
    amount: amt('received|credited', EN_FILL), party: party(`${NB}from`) },
  // ---- refund / reversal -> the money is back on the account wallet (income, marked as refund / reversal)
  { id: 'nbe.refund.en', issuer: 'nbe', provider: 'bank_card', kind: 'refund', type: 'income',
    all: [W('refund\\w*')], none: [W('revers\\w*|atm|withdraw\\w*')],
    amount: amt('refund\\w*', EN_FILL), party: party(`${NB}from|${NB}at`) },
  { id: 'nbe.refund.ar', issuer: 'nbe', provider: 'bank_card', kind: 'refund', type: 'income',
    all: [A('رد مبلغ|استرداد')], none: [A('عكس|الغاء|سحب|صراف')],
    amount: amt('رد|استرداد', AR_FILL), party: party(`\\sمن|لدي|عند`) },
  { id: 'nbe.reversal.en', issuer: 'nbe', provider: 'bank_card', kind: 'reversal', type: 'income',
    all: [W('revers\\w*')], none: [W('refund\\w*|atm|withdraw\\w*')],
    amount: amt('transaction|purchase|payment|amount', EN_FILL), party: party(`${NB}at`) },
  { id: 'nbe.reversal.ar', issuer: 'nbe', provider: 'bank_card', kind: 'reversal', type: 'income',
    all: [A('عكس|الغاء')], none: [A('رد مبلغ|استرداد|سحب|صراف')],
    amount: amt('عكس|الغاء', AR_FILL), party: party('لدي|عند') },
  // ---- Vodafone Cash wallet (its own sender, its own key, its own wallet) - needs Vodafone Cash's own wording
  { id: 'vfc.received.en', issuer: 'vodafone_cash', provider: 'vodafone_cash', kind: 'transfer_in', type: 'income',
    all: [W('received'), W('wallet|vodafone cash')], none: [W('refund\\w*|revers\\w*|instapay|ipn|sent|transferred|paid')],
    amount: amt('received', EN_FILL), party: party(`${NB}from`) },
  { id: 'vfc.sent.en', issuer: 'vodafone_cash', provider: 'vodafone_cash', kind: 'transfer_out', type: 'expense',
    all: [W('transferred|sent|paid'), W('wallet|vodafone cash')], none: [W('received|refund\\w*|revers\\w*|instapay|ipn')],
    amount: amt('transferred|sent|paid', EN_FILL), party: party(`${NB}to`) },
];
export const PROVISIONAL_RULES = PROVISIONAL.map((x) => ({ ...x, provisional: true }));
export const RULES = [...VERIFIED_RULES, ...PROVISIONAL_RULES];

// Messages that mention money but are NOT a completed transaction - checked before any rule.
const NOT_TX = [
  ['one_time_code', new RegExp(`${NB}(?:otp|one[- ]time|verification code|passcode)${NA}|رمز التحقق|كلمه السر|كلمة السر|الرقم السري|رمز التاكيد`, 'u')],
  ['declined_or_failed', new RegExp(`${NB}(?:declined|rejected|failed|unsuccessful|not completed|insufficient|blocked)${NA}|مرفوض|رفض|فشل|لم تتم|لم يتم|غير كاف|تعذر`, 'u')],
];
const FOREIGN = new RegExp(`${NB}(?:usd|eur|gbp|sar|aed|kwd|qar)${NA}|\\$|€|£|دولار|يورو|ريال|درهم|دينار`, 'u');

/** The parser. Deterministic: text + issuer (+ receipt time) -> one result.
    ok:   { ok:true, provider, kind, type, rule, amount, party, reference, at (ISO), date_source }
    fail: { ok:false, reason }   - nothing may be created.                                                        */
export function parseSms(text, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (typeof text !== 'string') return { ok: false, reason: 'malformed_message' };
  const clean = cleanSms(text);
  if (clean.length < 15 || clean.length > 1000) return { ok: false, reason: 'malformed_message' };
  const fold = foldSms(clean);
  for (const [reason, re] of NOT_TX) if (re.test(fold)) return { ok: false, reason };
  const hits = RULES.filter((r) => (opts.provisional || !r.provisional) && (!opts.issuer || r.issuer === opts.issuer) && r.all.every((re) => re.test(fold)) && !r.none.some((re) => re.test(fold)));
  if (!hits.length) return { ok: false, reason: 'no_rule_matched' };
  if (new Set(hits.map((r) => `${r.provider}|${r.kind}|${r.type}`)).size > 1) return { ok: false, reason: 'ambiguous_message', rules: hits.map((r) => r.id) };
  if (hits.some((r) => r.shape)) {
    if (hits.length > 1) return { ok: false, reason: 'ambiguous_message', rules: hits.map((r) => r.id) };
    const r = hits[0], m = r.shape.exec(fold);
    if (!m) return { ok: false, reason: 'structure_mismatch', rule: r.id };
    const g = m.groups, v = parseAmount(g.amount);
    if (v === null || (g.bal !== undefined && parseAmount(g.bal) === null && Number(g.bal) !== 0) || (g.topup !== undefined && parseAmount(g.topup) === null)) return { ok: false, reason: 'amount_malformed', rule: r.id };
    if (g.fee !== undefined && !/^0+(?:\.0+)?$/.test(g.fee)) return { ok: false, reason: parseAmount(g.fee) === null ? 'amount_malformed' : 'fee_not_verified', rule: r.id };
    const when = resolveDate(g, now);
    if (when.error) return { ok: false, reason: when.error, rule: r.id };
    let who = ''; if (m.indices.groups.party) { const [s, e] = m.indices.groups.party; who = clean.slice(s, e).replace(/^[\s"'«»:؛;،,-]+|[\s"'«».؛;،,:-]+$/g, ''); }
    return { ok: true, provider: r.provider, kind: r.kind, type: r.type, rule: r.id, amount: v, party: who.length < 2 ? '' : who, reference: g.ref || '',
      at: new Date(when.source === 'none' ? now : when.at).toISOString(), date_source: when.source === 'none' ? 'received' : when.source };
  }
  // several wordings of the same kind may match (e.g. a bilingual message): they must agree on the amount
  let rule = null, amount = null; const amounts = new Set();
  for (const r of hits) {
    const m = r.amount.exec(fold); if (!m) continue;
    const v = parseAmount(m.groups.a || m.groups.b || m.groups.a2 || m.groups.b2);
    if (v === null) return { ok: false, reason: 'amount_malformed', rule: r.id };
    amounts.add(v); if (!rule) { rule = r; amount = v; }
  }
  if (!rule) return { ok: false, reason: FOREIGN.test(fold) ? 'unsupported_currency' : 'amount_not_found', rule: hits[0].id };
  if (amounts.size > 1) return { ok: false, reason: 'ambiguous_amount', rule: rule.id };
  const when = findDate(fold, now);
  if (when.error) return { ok: false, reason: when.error, rule: rule.id };
  let who = '';
  if (rule.party) { const m = rule.party.exec(fold); if (m && m.indices.groups.party) { const [s, e] = m.indices.groups.party; who = clean.slice(s, e).replace(/^[\s"'«»:،,-]+|[\s"'«».،,;:-]+$/g, ''); } }
  if (who.length < 2) who = '';
  let reference = ''; { const m = RE_REF.exec(fold); if (m && /\d/.test(m.groups.ref)) { const [s, e] = m.indices.groups.ref; reference = clean.slice(s, e).toUpperCase(); } }
  return { ok: true, provider: rule.provider, kind: rule.kind, type: rule.type, rule: rule.id, amount, party: who, reference,
    at: new Date(when.source === 'none' ? now : when.at).toISOString(), date_source: when.source === 'none' ? 'received' : when.source };
}

/* ============================== 3. from parsed message to app transaction ============================== */
const SERVICE = { debit_card: 'Debit card', bank_card: 'Card', atm: 'ATM', bank: 'Bank', instapay: 'InstaPay', vodafone_cash: 'Vodafone Cash' };
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** Category + note exactly in the app's own vocabulary (the same labels the app writes for manual entries).
    Names from the SMS are kept as written - never translated. The note marks the entry as imported. */
export function describe(p) {
  const who = clip(p.party, 60), tag = 'Bank SMS · ' + (SERVICE[p.provider] || p.provider), ref = p.reference ? 'ref ' + p.reference : '';
  const note = (...first) => clip([...first, tag, ref].filter(Boolean).join(' · '), 200);
  switch (p.kind) {
    case 'mobile_recharge': return { category: 'Vodafone Cash mobile recharge', note: note() };
    case 'card_purchase': return { category: who || 'Expense', note: note() };
    case 'transfer_out': return { category: who || (p.provider === 'vodafone_cash' ? 'Vodafone Cash transfer' : 'Expense'), note: note('Transfer') };
    case 'atm_withdrawal': return { category: 'Withdraw cash', note: note() };
    case 'cash_deposit': return { category: 'Cash back to bank', note: note() };
    case 'refund': return { category: 'Add income', note: note('Refund', who) };
    case 'reversal': return { category: 'Add income', note: note('Reversal', who) };
    default: return { category: 'Add income', note: note(who && 'From ' + who) };          // credit, transfer_in
  }
}

const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** What makes two requests "the same bank transaction" (the household is added by the database's unique index).
    With a bank reference: provider + kind + amount + reference.  Without: provider + kind + amount + the whole message. */
export async function fingerprint(p, text) {
  const smsHash = await sha256(foldSms(cleanSms(text)));
  const basis = p.reference ? `ref:${p.reference}` : `sms:${smsHash}`;
  return { sms_hash: smsHash, fingerprint: await sha256(['v1', p.provider, p.kind, p.amount.toFixed(2), basis].join('|')) };
}

/* ============================== 4. the HTTP function ============================== */
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-import-key, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const KEY_RE = /^htk_[0-9a-f]{64}$/;

export async function handle(req, env, fetchFn = fetch, now = Date.now()) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { ok: false, status: 'method_not_allowed' });
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, ''), service = env.SUPABASE_SERVICE_ROLE_KEY;
  const log = (o) => console.log('bank-sms-import ' + JSON.stringify(o));     // never the SMS text, never a key
  if (!base || !service) { console.error('bank-sms-import: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); return reply(500, { ok: false, status: 'error' }); }
  const rpc = async (fn, args) => {
    const r = await fetchFn(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${clip(await r.text(), 160)}`);
    return await r.json();
  };

  // 1. authentication: the import key (only its hash ever reaches the database)
  const key = ((req.headers.get('X-Import-Key') || '').trim() || (req.headers.get('Authorization') || '').replace(/^Bearer(\s+|$)/i, '').trim());
  if (!KEY_RE.test(key)) { log({ status: 'unauthorized', reason: key ? 'malformed_key' : 'missing_key' }); return reply(401, { ok: false, status: 'unauthorized' }); }
  const keyHash = await sha256(key), k8 = keyHash.slice(0, 8);
  let who;
  try { who = await rpc('bank_import_auth', { kh: keyHash }); }
  catch (e) { console.error('bank-sms-import: auth lookup failed', String(e && e.message || e)); return reply(500, { ok: false, status: 'error' }); }
  if (!who || !who.ok) { log({ key: k8, status: 'unauthorized', reason: who && who.reason }); return reply(401, { ok: false, status: 'unauthorized' }); }

  // 2. the request (only sender, text and dry_run are read)
  let body = null;
  try { const raw = await req.text(); if (raw.length <= 8000) body = JSON.parse(raw); } catch (_e) { /* not JSON */ }
  if (!body || typeof body !== 'object' || typeof body.text !== 'string' || typeof body.sender !== 'string') { log({ key: k8, status: 'bad_request' }); return reply(400, { ok: false, status: 'bad_request', reason: 'expected JSON {"sender": "...", "text": "..."}' }); }
  const dry = body.dry_run === true;

  // 3. the sender must be the one this key was issued for, and one this parser knows
  const issuer = issuerOf(who.sender);
  if (normSender(body.sender) !== normSender(who.sender)) { log({ key: k8, status: 'sender_not_allowed' }); return reply(403, { ok: false, status: 'sender_not_allowed' }); }
  if (!issuer) { log({ key: k8, status: 'sender_not_supported' }); return reply(403, { ok: false, status: 'sender_not_supported' }); }

  // 4. parse - or stop
  const p = parseSms(body.text, { issuer, now, provisional: env.BANK_SMS_PROVISIONAL_RULES === 'on' });
  if (!p.ok) { log({ key: k8, status: 'unrecognized_sms', reason: p.reason, rule: p.rule, issuer }); return reply(422, { ok: false, status: 'unrecognized_sms', reason: p.reason }); }
  const fp = await fingerprint(p, body.text), d = describe(p);

  // 5. create the normal transaction - atomically, once
  let res;
  try { res = await rpc('bank_import_commit', { kh: keyHash, dry, p: { type: p.type, amount: p.amount, category: d.category, note: d.note, at: p.at, provider: p.provider, kind: p.kind, rule: p.rule, reference: p.reference, ...fp } }); }
  catch (e) { console.error('bank-sms-import: commit failed', String(e && e.message || e)); return reply(500, { ok: false, status: 'error' }); }
  const st = res && res.status, parsed = { provider: p.provider, kind: p.kind, type: p.type, amount: p.amount, rule: p.rule, description: d.category, note: d.note, at: p.at, date_source: p.date_source };
  log({ key: k8, status: st, reason: res && res.reason, provider: p.provider, kind: p.kind, rule: p.rule, amount: p.amount, sms: fp.sms_hash.slice(0, 12), ref: !!p.reference, tx: res && res.transaction_id, dry });
  if (st === 'unauthorized') return reply(401, { ok: false, status: 'unauthorized' });
  if (st === 'wallet_required') return reply(409, { ok: false, status: 'wallet_required', reason: res.reason, provider: p.provider, type: p.type });
  if (st === 'rejected') return reply(409, { ok: false, status: 'rejected', reason: res.reason, detail: res.detail, provider: p.provider, type: p.type, amount: p.amount });
  if (st === 'already_imported') return reply(200, { ok: true, status: 'already_imported', transaction_id: res.transaction_id || null });
  if (st === 'would_import') return reply(200, { ok: true, status: 'would_import', dry_run: true, ...parsed, wallet: res.wallet, to_wallet: res.to_wallet || null, balance_negative: res.balance_negative === true });
  if (st !== 'imported') { console.error('bank-sms-import: unexpected commit result'); return reply(500, { ok: false, status: 'error' }); }

  // 6. hand over to the EXISTING notification pipeline (the outbox row already exists - written by the trigger).
  //    If this call fails nothing is lost: the notification stays queued and goes out on the next run.
  let notification = 'queued';
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetchFn(`${base}/functions/v1/notify-transactions`, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${service}`, apikey: service, 'Content-Type': 'application/json' }, body: JSON.stringify({ on_behalf_of: res.user_id }) });
    clearTimeout(timer);
    if (r.ok) notification = 'triggered'; else console.error('bank-sms-import: notify-transactions answered HTTP ' + r.status);
  } catch (e) { console.error('bank-sms-import: notify-transactions not reached', clip(e && e.message || e, 120)); }
  return reply(200, { ok: true, status: 'imported', transaction_id: res.transaction_id, ...parsed, wallet: res.wallet, to_wallet: res.to_wallet || null, balance_negative: res.balance_negative === true, notification });
}

// Supabase / Deno entry point (absent when the file is imported by the Node tests)
if (typeof Deno !== 'undefined' && Deno.serve) Deno.serve((req) => handle(req, Deno.env.toObject()));
