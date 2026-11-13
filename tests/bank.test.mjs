// Bank SMS import, end to end without Supabase, OneSignal or a phone:
//   the REAL parser + Edge Function code (supabase/functions/bank-sms-import/index.ts)
//   + REAL PostgreSQL with the repository's migrations (keys, fingerprints, wallets, balance rules, outbox trigger)
//   + the REAL notify-transactions function + a recording stand-in for the OneSignal REST API.
//                                                                     node --no-warnings tests/bank.test.mjs
import fs from 'node:fs';import path from 'node:path';
import {test,eq,ok,throws,done,startDb,MIGRATIONS,ROOT} from './harness.mjs';
import {handle,parseSms,parseAmount,findDate,cleanSms,foldSms,describe,fingerprint,RULES,SENDERS,normSender,issuerOf,cairoToUtc} from '../supabase/functions/bank-sms-import/index.ts';
import {handle as notifyHandle} from '../supabase/functions/notify-transactions/index.ts';

const FX=JSON.parse(fs.readFileSync(path.join(ROOT,'tests/fixtures/bank-sms.json'),'utf8'));
const NOW=Date.parse(FX._now),M=Object.fromEntries(FX.messages.map(m=>[m.id,m]));
const P=(text,issuer='nbe',now=NOW)=>parseSms(text,{issuer,now});
const fx=id=>{const m=M[id],p=P(m.text,m.issuer);eq(p,{ok:true,...m.expect},id+':');return p};
const no=(text,reason,issuer='nbe')=>{const p=P(text,issuer);eq([p.ok,p.reason],[false,reason],JSON.stringify(text).slice(0,70)+':')};

console.log('\nBank SMS parser (deterministic rules)');
await test('bank card purchase (English + Arabic) → expense; the merchant is kept as written; the balance is never taken as the amount',()=>{
  const a=fx('card_en'),b=fx('card_ar');eq([a.type,a.amount,b.amount,b.party],['expense',1250.5,250,'كارفور المعادي']);
  eq(describe(a),{category:'CARREFOUR MAADI',note:'Bank SMS · Card · ref 123456789012'});eq(describe(b),{category:'كارفور المعادي',note:'Bank SMS · Card'})});
await test('ATM withdrawal (English + Arabic, Arabic digits) → withdraw',()=>{const a=fx('atm_en'),b=fx('atm_ar');eq([a.type,b.type,b.amount],['withdraw','withdraw',2000]);eq(describe(a),{category:'Withdraw cash',note:'Bank SMS · ATM'})});
await test('deposit / credit → income; cash paid in at the ATM → deposit',()=>{fx('credit_en');fx('credit_ar');fx('cash_deposit_en');fx('cash_deposit_ar');
  eq(describe(P(M.credit_en.text)),{category:'Add income',note:'From ACME COMPANY · Bank SMS · Bank'});eq(describe(P(M.cash_deposit_en.text)).category,'Cash back to bank')});
await test('bank transfer sent → expense with the recipient; reference kept',()=>{const a=fx('transfer_en'),b=fx('transfer_ar');eq([a.provider,b.provider,b.party],['bank','bank','محمد علي']);
  eq(describe(a),{category:'MOHAMED ALI',note:'Transfer · Bank SMS · Bank · ref FT26317ABC'})});
await test('InstaPay sent / received (English + Arabic) → expense / income, provider "instapay"',()=>{for(const k of ['instapay_out_en','instapay_out_ar','instapay_in_en','instapay_in_ar'])eq(fx(k).provider,'instapay');
  eq(describe(P(M.instapay_in_ar.text)),{category:'Add income',note:'From سارة حسن · Bank SMS · InstaPay · ref 555666777'})});
await test('Vodafone Cash received / sent (English + Arabic) → income / expense, provider "vodafone_cash"',()=>{for(const k of ['vfcash_in_en','vfcash_in_ar','vfcash_out_en','vfcash_out_ar'])eq(fx(k).provider,'vodafone_cash')});
await test('refund and reversal (English + Arabic) → income marked as refund / reversal',()=>{fx('refund_en');fx('refund_ar');fx('reversal_en');fx('reversal_ar');
  eq(describe(P(M.refund_en.text)),{category:'Add income',note:'Refund · AMAZON EG · Bank SMS · Card'});eq(describe(P(M.reversal_ar.text)).note,'Reversal · NOON · Bank SMS · Card')});
await test('every rule is exercised by a fixture, and only existing app transaction types are produced',()=>{
  const used=new Set(FX.messages.map(m=>m.expect.rule));eq(RULES.map(r=>r.id).filter(id=>!used.has(id)),[]);
  eq([...new Set(RULES.map(r=>r.type))].sort(),['deposit','expense','income','withdraw']);eq(new Set(RULES.map(r=>r.id)).size,RULES.length);
  for(const m of FX.messages)eq(P(m.text,null),{ok:true,...m.expect},m.id+' (no issuer filter: still exactly one kind)')});
await test('unknown SMS → not recognised: advert, balance enquiry, plain text with an amount, limit change',()=>{
  no('Enjoy 20% cashback up to EGP 500 when you shop online with your card this weekend!','no_rule_matched');
  no('Your available balance is EGP 12,345.67 as of 12/11/2026','no_rule_matched');no('EGP 250.00 transaction transfer LE 250','no_rule_matched');
  no('عزيزي العميل تم تحديث بياناتكم بنجاح لدى البنك الأهلي المصري','no_rule_matched');no('Dear customer, your card limit is now EGP 50,000.00','no_rule_matched')});
await test('messages about money that are NOT a completed transaction → never imported (one-time code, declined, failed)',()=>{
  no('Your OTP is 482913 for purchase of EGP 1,250.50 at CARREFOUR using card ending 1234','one_time_code');
  no('رمز التحقق 482913 لعملية شراء بمبلغ 250.00 جنيه ببطاقتكم','one_time_code');
  no('Your card ending 1234 was declined for purchase of EGP 900.00 at NOON','declined_or_failed');no('تم رفض عملية شراء بمبلغ 900 جنيه ببطاقتكم رقم 1234','declined_or_failed');
  no('Transfer of EGP 500.00 from your account failed due to insufficient balance','declined_or_failed')});
await test('malformed SMS → not recognised: empty, too short, not text, absurdly long',()=>{
  for(const t of ['','   ','EGP 5','charged'])no(t,'malformed_message');for(const t of [null,undefined,12345,{},['x']])eq(P(t).reason,'malformed_message');no('Your card was charged EGP 10.00 at X '+'z'.repeat(1200),'malformed_message')});
await test('amounts: comma-separated, decimal, plain, EGP / LE / L.E. / جنيه / ج.م before or after, Arabic digits and separators',()=>{
  eq(['1,250.50','2000','0.50','12,345,678.9','1000000','7'].map(parseAmount),[1250.5,2000,0.5,12345678.9,1000000,7]);
  const card=m=>P(`Your card ending 1234 was charged ${m} at SHOP on 12/11/2026`).amount;
  eq(['EGP 1,250.50','EGP1250.5','1,250.50 EGP','LE 1250.50','L.E. 1,250.50','1250.50 L.E'].map(card),[1250.5,1250.5,1250.5,1250.5,1250.5,1250.5]);
  const ar=m=>P(`تم خصم ${m} من بطاقتكم رقم 1234 لدى متجر`).amount;
  eq(['250.75 جنيه','٢٥٠٫٧٥ جنيه','١٬٢٥٠٫٥٠ جنيها','1250.5 ج.م','جنيه 99','3,000 جنيه مصري'].map(ar),[250.75,250.75,1250.5,1250.5,99,3000])});
await test('malformed / ambiguous amount → not recognised (never "repaired"); foreign currency → not recognised (never converted)',()=>{
  eq(['1,50','1.500','12,34,567','1,2345','1..5','.5','5.','abc','','0','-5','1 250','1e3'].map(parseAmount),Array(13).fill(null));
  for(const m of ['EGP 1,25.0','EGP 12,34,567','EGP 1.500','EGP 1,250.505'])no(`Your card ending 1234 was charged ${m} at SHOP on 12/11/2026`,'amount_malformed');
  no('Your card ending 1234 was charged at SHOP on 12/11/2026. Available balance EGP 900.00','amount_not_found');
  no('Your card ending 1234 was charged USD 20.00 at AMAZON US on 12/11/2026. Available balance EGP 900.00','unsupported_currency');
  no('تم خصم 20.00 دولار من بطاقتكم رقم 1234 لدى AMAZON','unsupported_currency')});
await test('date/time: day/month order, Cairo time incl. summer time, am/pm, 2-digit year, month names, ISO; date only → noon; no date → receipt time',()=>{
  const at=(tail,now=NOW)=>{const p=P(`Your card ending 1234 was charged EGP 10.00 at SHOP ${tail}`,'nbe',now);return p.ok?[p.at,p.date_source]:p.reason};
  eq(at('on 12/11/2026 14:35'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 05/11/2026 at 09:05:30'),['2026-11-05T07:05:30.000Z','sms']);
  eq(at('on 12-11-26 02:35 PM'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 12/11/2026 12:10 am'),['2026-11-11T22:10:00.000Z','sms']);
  eq(at('on 2026-11-12 14:35'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 12 Nov 2026 14:35'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 12-NOV-26'),['2026-11-12T10:00:00.000Z','sms_date_only']);
  eq(at('on 10/11/2026'),['2026-11-10T10:00:00.000Z','sms_date_only']);eq(at('on 12/11 at 14:35'),['2026-11-12T12:35:00.000Z','sms'],'year missing → the year of receipt');
  eq(at('on 31/12 at 23:50',Date.parse('2027-01-01T06:00:00Z')),['2026-12-31T21:50:00.000Z','sms'],'31/12 read on 1 January → last year');
  eq(at('on 15/07/2026 14:35',Date.parse('2026-07-15T16:00:00Z')),['2026-07-15T11:35:00.000Z','sms'],'summer time: Cairo is UTC+3');
  eq(at('today'),[new Date(NOW).toISOString(),'received']);eq(at('at 14:35'),[new Date(NOW).toISOString(),'received'],'a time without a date is not a timestamp');
  eq(new Date(cairoToUtc(2026,1,15,8,0,0)).toISOString(),'2026-01-15T06:00:00.000Z')});
await test('malformed date → not recognised: impossible day/month/time, two different dates, far future, too old',()=>{
  const r=tail=>P(`Your card ending 1234 was charged EGP 10.00 at SHOP ${tail}`).reason;
  eq(['on 32/11/2026','on 12/13/2026','on 31/02/2026','on 00/11/2026','on 12/11/2026 25:10','on 12/11/2026 10:75','on 12/11/2026 13:10 pm'].map(r),Array(7).fill('date_malformed'));
  eq(r('on 12/11/2026, posted 13/11/2026'),'date_ambiguous');eq(r('on 12/11/2027'),'date_in_future');eq(r('on 12/11/2019'),'date_too_old');eq(r('on 01/06/2026'),'date_too_old')});
await test('Arabic text is matched regardless of hamza / diacritics / tatweel / invisible marks; names come back exactly as written',()=>{
  const p=P('تمّ خصم مبلغ 80 جنيهاً من بطاقتكم رقم 1234 لدى \u200fمطعم أبو أحمد\u200f بتاريخ 12/11/2026');eq([p.ok,p.amount,p.party,p.rule],[true,80,'مطعم أبو أحمد','nbe.card_purchase.ar']);
  eq(P('تم خصم 80 جنيه من بطاقتكم لدي مطعم ابو احمد').rule,'nbe.card_purchase.ar');eq(foldSms('إلى الآلي ABC').length,'إلى الآلي ABC'.length);eq(cleanSms('  a \n\t b  '),'a b')});
await test('providers are not confused: InstaPay ≠ Vodafone Cash ≠ plain bank transfer; a currency or a keyword alone decides nothing',()=>{
  for(const k of ['instapay_out_en','instapay_out_ar','instapay_in_en','instapay_in_ar'])eq(P(M[k].text,'vodafone_cash').reason,'no_rule_matched',k+' with a Vodafone Cash key');
  for(const k of ['vfcash_in_en','vfcash_in_ar','vfcash_out_en','vfcash_out_ar'])eq(P(M[k].text,'nbe').reason,'no_rule_matched',k+' with a bank key');
  eq([P(M.transfer_en.text).provider,P(M.transfer_ar.text).provider],['bank','bank'],'a transfer without InstaPay wording is never "instapay"');
  eq(P(M.transfer_en.text.replace('A transfer','An InstaPay transfer')).provider,'instapay');
  eq(P('InstaPay: you received EGP 300.00 in your Vodafone Cash wallet from SARA','nbe').ok,false,'InstaPay + Vodafone Cash wording together → nobody claims it');
  eq(P('InstaPay: you received EGP 300.00 in your Vodafone Cash wallet from SARA','vodafone_cash').ok,false);
  eq(P('InstaPay EGP 750.00').reason,'no_rule_matched');eq(P('Vodafone Cash 150 جنيه','vodafone_cash').reason,'no_rule_matched');
  eq(P('SomeBank: purchase EGP 10.00 card','unknown_issuer').reason,'no_rule_matched')});
await test('similar wording, different meaning → the right kind or nothing: ATM vs purchase, refund vs purchase, sent vs received, mixed messages',()=>{
  eq(P('Your card ending 1234 was charged EGP 2,000.00 for ATM withdrawal on 12/11/2026').reason,'amount_not_found','card + charged + ATM: never a purchase, and not a withdrawal without withdrawal wording for the amount');
  eq(P('Purchase of EGP 120.00 at NOON on card ending 1234 was refunded on 10/11/2026').reason,'amount_not_found','a refund is never booked as a purchase');
  eq(P('Refund of EGP 120.00 for reversed transaction at NOON').reason,'no_rule_matched','refund + reversal wording together');
  eq(P('InstaPay: EGP 100.00 was sent and EGP 50.00 received on your account').reason,'no_rule_matched');
  const mixed=P('Your card ending 1234 was charged EGP 100.00 at SHOP. تم سحب نقدي بمبلغ 100 جنيه من ماكينة الصراف');eq([mixed.reason,mixed.rules],['ambiguous_message',['nbe.card_purchase.en','nbe.atm_withdrawal.ar']]);
  eq(P('Your card ending 1234 was charged EGP 100.00 at SHOP. تم خصم 150 جنيه من بطاقتكم لدى SHOP').reason,'ambiguous_amount','same kind twice with different amounts');
  eq(P('Your card ending 1234 was charged EGP 100.00 at SHOP. تم خصم 100 جنيه من بطاقتكم لدى SHOP').amount,100)});
await test('sender names: known families only; l / I look-alikes are the same sender; fingerprint ignores spacing and digit style',async()=>{
  eq(['BanK-AIAhly','BanK-AlAhly','bank-aiahly','BANK ALAHLY','NBE','VF-Cash','CIB','','AlAhly'].map(issuerOf),['nbe','nbe','nbe','nbe','nbe','vodafone_cash',null,null,null]);
  ok(SENDERS.nbe.includes('BanK-AIAhly'));eq(normSender('BanK-AIAhly'),normSender('BanK-AlAhly'));
  const t=M.card_ar.text,p=P(t),f=await fingerprint(p,t);eq(f,await fingerprint(p,'  '+t.replace(/ /g,'  ').replace('250.00','٢٥٠.٠٠')+'\n'));ok(/^[0-9a-f]{64}$/.test(f.fingerprint)&&/^[0-9a-f]{64}$/.test(f.sms_hash));
  const a=P(M.card_en.text),fa=await fingerprint(a,M.card_en.text);eq(fa.fingerprint,(await fingerprint(a,'completely different wording')).fingerprint,'with a bank reference the reference decides');
  ok(fa.fingerprint!==(await fingerprint({...a,reference:'999'},M.card_en.text)).fingerprint);ok(fa.fingerprint!==(await fingerprint({...a,amount:1},M.card_en.text)).fingerprint)});

/* ================================================= with the database ================================================= */
console.log('\nBank SMS import (real PostgreSQL + real Edge Functions)');
const db=await startDb();const {admin,as}=db;
const one=async(uid,sql,p)=>(await as(uid,sql,p)).rows[0];
const user=async name=>(await admin.query('insert into auth.users(email,raw_user_meta_data) values($1,$2) returning id',[name+'@t.io',{name}])).rows[0].id;
const sub=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ENV={SUPABASE_URL:'https://proj.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service-secret',ONESIGNAL_REST_API_KEY:'os_v2_app_testkey'};
const J=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const sent=[],world={notifyDown:false,loseReply:false,authCalls:0,notifyCalls:[]};
const ARGS={bank_import_auth:a=>['select bank_import_auth($1) v',[a.kh]],bank_import_commit:a=>['select bank_import_commit($1,$2,$3) v',[a.kh,JSON.stringify(a.p),!!a.dry]],
  push_claim:a=>['select push_claim($1) v',[a.caller]],push_done:a=>['select push_done($1,$2,$3,$4,$5,$6) v',[a.nid,a.st,a.n,a.err,a.bad,a.langs]]};
async function fakeFetch(url,init={}){
  const h=init.headers||{};
  if(url.includes('/rest/v1/rpc/')){if(h.apikey!=='service-secret'||h.Authorization!=='Bearer service-secret')return J(401,{message:'bad key'});
    const fn=url.split('/rpc/')[1],[sql,params]=ARGS[fn](JSON.parse(init.body));const c=await db.conn();           // own connection per call: requests really run concurrently
    try{await c.query('begin');await c.query('set local role service_role');const r=(await c.query(sql,params)).rows[0].v;await c.query('commit');
      if(fn==='bank_import_commit'&&world.loseReply){world.loseReply=false;throw new Error('connection reset')}
      return new Response(r===null||r===''?'':JSON.stringify(r),{status:200})}
    catch(e){await c.query('rollback').catch(()=>{});if(e.message==='connection reset')throw e;return J(400,{message:e.message})}finally{await c.end()}}
  if(url.endsWith('/functions/v1/notify-transactions')){world.notifyCalls.push(JSON.parse(init.body));if(world.notifyDown)throw new Error('function unreachable');
    return notifyHandle(new Request(url,{method:'POST',headers:h,body:init.body}),ENV,fakeFetch)}
  if(url.endsWith('/auth/v1/user')){world.authCalls++;const m=/^Bearer user:(.+)$/.exec(String(h.Authorization||''));return m?J(200,{id:m[1]}):J(401,{msg:'invalid JWT'})}
  if(url==='https://api.onesignal.com/notifications'){sent.push(JSON.parse(init.body));return J(200,{id:'n1'})}
  throw new Error('unexpected request '+url)}
const logs=[];const _log=console.log,_err=console.error;const quiet=async fn=>{console.log=(...a)=>logs.push(a.join(' '));console.error=(...a)=>logs.push(a.join(' '));try{return await fn()}finally{console.log=_log;console.error=_err}};
// dates in the sample messages → yesterday (Cairo), so the suite does not depend on the day it runs
const YD=(()=>{const d=new Date(Date.now()-86400e3);const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',day:'2-digit',month:'2-digit',year:'numeric'}).formatToParts(d).map(x=>[x.type,x.value]));return{txt:`${p.day}/${p.month}/${p.year}`,y:+p.year,m:+p.month,d:+p.day}})();
const sms=id=>M[id].text.replace(/\d\d\/11\/2026/g,YD.txt);
const post=(key,body,headers)=>quiet(async()=>{const r=await handle(new Request('https://proj.supabase.co/functions/v1/bank-sms-import',{method:'POST',headers:headers||(key?{Authorization:'Bearer '+key}:{}),body:typeof body==='string'?body:JSON.stringify(body)}),ENV,fakeFetch);return{http:r.status,...(await r.json())}});
const imp=(key,id,extra={})=>post(key,{sender:'BanK-AIAhly',text:typeof id==='string'&&M[id]?sms(id):id,...extra});
const txs=async h=>(await admin.query('select t.id,t.type,t.amount::float8 amount,t.category,t.note,t.user_id,t.household_id,t.created_at,w.name wallet,w2.name to_wallet from transactions t join wallets w on w.id=t.wallet_id left join wallets w2 on w2.id=t.to_wallet_id where t.household_id=$1 order by t.updated_at',[h])).rows;
const count=async h=>+(await admin.query('select count(*) n from transactions where household_id=$1',[h])).rows[0].n;
const bal=async(u,h)=>Object.fromEntries((await one(u,'select wallet_balances($1) b',[h])).b.map(w=>[w.name,+w.balance]));
const imports=async h=>(await admin.query('select * from bank_imports where household_id=$1 order by created_at',[h])).rows;
const outbox=async tx=>(await admin.query('select status,recipients,error,attempts from notification_outbox where transaction_id=$1',[tx])).rows[0];
const newKey=async(u,sender='BanK-AIAhly',...rest)=>(await one(u,'select bank_import_create_key($1,$2,$3,$4) k',[sender,rest[0]||null,rest[1]||null,rest[2]||365])).k;

let A,B,WA={},WB={},Ahmed,Mona,Bob,Dad,kA,kMona,kB;
const INS='insert into transactions(household_id,user_id,wallet_id,to_wallet_id,type,amount,category,note) values($1,$2,$3,$4,$5,$6,$7,$8) returning id';
try{
  await db.migrate([...MIGRATIONS]);
  Ahmed=await user('Ahmed');Mona=await user('Mona');Bob=await user('Bob');Dad=await user('Dad');
  A=(await one(Ahmed,"select create_household('Home A') h")).h;B=(await one(Bob,"select create_household('Home B') h")).h;
  const code=async(u,h)=>(await one(u,'select invite_code c from households where id=$1',[h])).c;
  await as(Mona,'select join_household($1)',[await code(Ahmed,A)]);await as(Dad,'select join_household($1)',[await code(Ahmed,A)]);
  for(const w of (await admin.query('select id,name,household_id from wallets')).rows)(w.household_id===A?WA:WB)[w.name]=w.id;
  await as(Ahmed,'select register_push_device($1,$2)',[sub(1),'en']);await as(Mona,'select register_push_device($1,$2)',[sub(3),'ar']);await as(Bob,'select register_push_device($1,$2)',[sub(11),'en']);
  await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',20000,'Add income','']);await as(Ahmed,INS,[A,Ahmed,WA['Household cash'],null,'income',1000,'Add income','']);
  await as(Bob,INS,[B,Bob,WB['Bank account'],null,'income',20000,'Add income','']);
  await admin.query("update notification_outbox set status='sent',done_at=now()");

  await test('migration 011 is additive and can be run twice; existing tables, policies and triggers are untouched',async()=>{
    const snap=async()=>JSON.stringify((await admin.query("select (select json_agg(x order by x) from (select tablename||':'||policyname||':'||coalesce(qual,'')||':'||coalesce(with_check,'') x from pg_policies where schemaname='public' and tablename not like 'bank_%') p) pol,(select json_agg(x order by x) from (select tgrelid::regclass||':'||tgname x from pg_trigger where not tgisinternal) t) trg,(select json_agg(x order by x) from (select table_name||'.'||column_name||':'||data_type x from information_schema.columns where table_schema='public' and table_name not like 'bank_%') c) col")).rows[0]);
    const before=await snap();await db.migrate(['011 bank sms import.sql']);const mid=await snap();await db.migrate(['011 bank sms import.sql']);eq(await snap(),mid);eq(mid,before);
    eq((await admin.query("select tablename from pg_tables where schemaname='public' and tablename like 'bank_%' order by 1")).rows.map(r=>r.tablename),['bank_import_keys','bank_imports'])});
  await test('import key: created by the signed-in user for themselves, shown once, stored only as a hash, bound to the app\'s own wallets',async()=>{
    const k=await newKey(Ahmed);kA=k.key;ok(/^htk_[0-9a-f]{64}$/.test(kA),'key format');eq([k.sender,k.wallet,k.cash_wallet],['BanK-AIAhly','Bank account','Household cash']);
    const row=(await admin.query('select * from bank_import_keys where user_id=$1',[Ahmed])).rows[0];eq([row.user_id,row.household_id,row.wallet_id,row.cash_wallet_id],[Ahmed,A,WA['Bank account'],WA['Household cash']]);
    ok(!JSON.stringify(row).includes(kA)&&/^[0-9a-f]{64}$/.test(row.key_hash),'the key itself is not in the database');ok(row.expires_at>new Date(Date.now()+364*86400e3));
    kMona=(await newKey(Mona)).key;kB=(await newKey(Bob)).key;ok(new Set([kA,kMona,kB]).size===3)});
  await test('keys and server functions are closed to the browser: no reading keys, no calling the server-only functions, no key without login, no foreign wallet',async()=>{
    await throws(()=>as(Ahmed,'select * from bank_import_keys'),/permission denied/);await throws(()=>as(Ahmed,"insert into bank_imports(household_id,fingerprint,provider,kind,rule,sms_hash) values($1,'x','x','x','x','x')",[A]),/permission denied/);
    await throws(()=>as(Ahmed,'select bank_import_auth($1)',['x']),/permission denied/);await throws(()=>as(Ahmed,"select bank_import_commit('x','{}'::jsonb,false)"),/permission denied/);
    await throws(()=>as(Ahmed,"select bank_import_key_new($1,'BanK-AIAhly',null,null,365)",[Mona]),/permission denied/,'cannot mint a key for someone else:');
    await throws(()=>as(null,"select bank_import_create_key('BanK-AIAhly')"),/not signed in|permission denied/);
    await throws(()=>newKey(Ahmed,'BanK-AIAhly',WB['Bank account']),/wallet does not belong/);await throws(()=>newKey(Ahmed,'BanK-AIAhly',WA['Bank account'],WB['Household cash']),/cash wallet does not belong/);
    await throws(()=>newKey(Ahmed,'BanK-AIAhly',null,null,5000),/validity/);await throws(()=>newKey(Ahmed,''),/sender/);
    eq((await as(Bob,'select * from bank_imports')).rows.length,0)});

  console.log('\nSecurity');
  await test('missing / malformed / unknown key → 401 unauthorized; nothing is parsed, nothing is created',async()=>{
    const n=await count(A),body={sender:'BanK-AIAhly',text:sms('card_en')};
    for(const h of [{},{Authorization:''},{Authorization:'Bearer '},{Authorization:'Bearer garbage'},{Authorization:'Bearer htk_123'},{'X-Import-Key':'htk_'+'g'.repeat(64)},{Authorization:'Bearer htk_'+'0'.repeat(64)},{Authorization:'Bearer user:'+Ahmed},{Authorization:'Bearer service-secret'},{Authorization:'Bearer '+kA.toUpperCase()},{Authorization:'Bearer '+kA+'0'}]){
      const r=await post(null,body,h);eq(r,{http:401,ok:false,status:'unauthorized'},JSON.stringify(h))}
    eq([await count(A),(await imports(A)).length],[n,0])});
  await test('expired key, revoked key, key of a member who was removed from the household → 401; a fresh key works again',async()=>{
    const n=await count(A),t=(await newKey(Dad)).key;
    eq((await imp(t,'card_en',{dry_run:true})).status,'would_import');
    await admin.query("update bank_import_keys set expires_at=now()-interval '1 second' where user_id=$1",[Dad]);eq(await imp(t,'card_en'),{http:401,ok:false,status:'unauthorized'},'expired:');
    await admin.query("update bank_import_keys set expires_at=now()+interval '1 day' where user_id=$1",[Dad]);eq((await imp(t,'card_en',{dry_run:true})).status,'would_import');
    eq((await one(Dad,'select bank_import_revoke_keys() n')).n,1);eq(await imp(t,'card_en'),{http:401,ok:false,status:'unauthorized'},'revoked:');
    const t2=(await newKey(Dad)).key;eq((await imp(t2,'card_en',{dry_run:true})).status,'would_import');
    await as(Ahmed,'select remove_member($1,$2)',[A,Dad]);eq(await imp(t2,'card_en'),{http:401,ok:false,status:'unauthorized'},'no longer a member:');
    ok(logs.some(l=>/"reason":"expired_key"/.test(l))&&logs.some(l=>/"reason":"revoked_key"/.test(l))&&logs.some(l=>/"reason":"not_a_member"/.test(l)),'the log tells the three apart, the caller cannot');
    eq(await count(A),n)});
  await test('forged user id / household id / wallet ids in the request are ignored: the entry goes to the key owner\'s own household and bank wallet',async()=>{
    const nA=await count(A),bA=await bal(Ahmed,A);
    const r=await post(kB,{sender:'BanK-AIAhly',text:sms('card_ar'),user_id:Ahmed,household_id:A,wallet_id:WA['Household cash'],to_wallet_id:WA['Bank account'],type:'income',amount:999999,key_id:'x'});
    eq([r.http,r.status,r.type,r.amount,r.wallet],[200,'imported','expense',250,'Bank account']);
    const t=(await txs(B)).pop();eq([t.user_id,t.household_id,t.wallet,t.type,t.amount],[Bob,B,'Bank account','expense',250]);
    eq([await count(A),await bal(Ahmed,A)],[nA,bA],'household A is untouched');eq((await as(Ahmed,'select * from bank_imports')).rows.length,0,'A cannot even see B\'s import record')});
  await test('sender / provider not allowed for this key → refused: wrong sender, unknown bank, Vodafone Cash message on a bank key',async()=>{
    const n=await count(A);
    eq(await post(kA,{sender:'CIB',text:sms('card_en')}),{http:403,ok:false,status:'sender_not_allowed'});eq(await post(kA,{sender:'VF-Cash',text:M.vfcash_out_en.text}),{http:403,ok:false,status:'sender_not_allowed'});
    eq(await post(kA,{sender:'BanK-AIAhly',text:M.vfcash_out_en.text}),{http:422,ok:false,status:'unrecognized_sms',reason:'no_rule_matched'},'right sender, other provider\'s wording:');
    eq((await post(kA,{sender:'bank-alahly',text:sms('card_en'),dry_run:true})).status,'would_import','l / I look-alike sender spelling is accepted');
    const kc=(await one(Mona,"select bank_import_create_key('CIB') k")).k.key;eq(await post(kc,{sender:'CIB',text:sms('card_en')}),{http:403,ok:false,status:'sender_not_supported'},'a sender the parser has no rules for:');
    eq(await count(A),n)});
  await test('bad requests → 400 (after authentication), wrong method → 405, unrecognised SMS → 422 with a safe reason; nothing created',async()=>{
    const n=await count(A);
    for(const b of ['not json','[]','{}',{sender:'BanK-AIAhly'},{text:sms('card_en')},{sender:'BanK-AIAhly',text:123},{sender:'BanK-AIAhly',text:'x'.repeat(9000)}])eq((await post(kA,b)).status,'bad_request',JSON.stringify(b).slice(0,40));
    eq((await handle(new Request('https://x/f',{method:'GET'}),ENV,fakeFetch)).status,405);eq((await handle(new Request('https://x/f',{method:'OPTIONS'}),ENV,fakeFetch)).status,200);
    eq(await imp(kA,'Enjoy 20% cashback up to EGP 500 with your card'),{http:422,ok:false,status:'unrecognized_sms',reason:'no_rule_matched'});
    eq((await imp(kA,'Your OTP is 123456 for purchase of EGP 50.00 with card 1234')).reason,'one_time_code');eq((await imp(kA,'Your card ending 1234 was charged EGP 1,25.0 at SHOP')).reason,'amount_malformed');
    eq((await imp(kA,'Your card ending 1234 was charged EGP 10.00 at SHOP on 32/13/2026')).reason,'date_malformed');eq(await count(A),n)});

  console.log('\nTransaction correctness');
  let cardTx;
  await test('card purchase → a normal expense: type, amount, wallet, balance effect, household, creator, description, SMS timestamp, source record',async()=>{
    const b0=await bal(Ahmed,A),n=await count(A);const r=await imp(kA,'card_en');
    eq([r.http,r.ok,r.status,r.provider,r.kind,r.type,r.amount,r.rule,r.wallet,r.to_wallet,r.description,r.date_source],[200,true,'imported','bank_card','card_purchase','expense',1250.5,'nbe.card_purchase.en','Bank account',null,'CARREFOUR MAADI','sms']);
    const t=(await txs(A)).pop();cardTx=t.id;eq(r.transaction_id,t.id);eq(await count(A),n+1);
    eq([t.type,t.amount,t.wallet,t.to_wallet,t.household_id,t.user_id,t.category,t.note],['expense',1250.5,'Bank account',null,A,Ahmed,'CARREFOUR MAADI','Bank SMS · Card · ref 123456789012']);
    eq(t.created_at.toISOString(),new Date(cairoToUtc(YD.y,YD.m,YD.d,14,35,0)).toISOString(),'the time written in the SMS (Cairo)');
    const b1=await bal(Ahmed,A);eq([b1['Bank account'],b1['Household cash']],[b0['Bank account']-1250.5,b0['Household cash']]);
    eq(+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance,b1['Bank account']+b1['Household cash']+b1['Personal cash']);
    const i=(await imports(A)).pop();eq([i.transaction_id,i.user_id,i.provider,i.kind,i.rule,i.reference],[t.id,Ahmed,'bank_card','card_purchase','nbe.card_purchase.en','123456789012']);
    ok(!JSON.stringify(i).includes('CARREFOUR'),'the SMS text is not stored');
    eq((await as(Mona,'select transaction_id,provider from bank_imports where transaction_id=$1',[t.id])).rows,[{transaction_id:t.id,provider:'bank_card'}],'household members can tell it was bank-imported');
    eq((await as(Mona,'select category from transactions where id=$1',[t.id])).rows.length,1,'visible to the household like any entry')});
  await test('ATM withdrawal → withdraw Bank account → Household cash (both balances move, total unchanged); cash deposit → the reverse',async()=>{
    const b0=await bal(Ahmed,A),s0=+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance;
    const r=await imp(kA,'atm_ar');eq([r.status,r.type,r.amount,r.wallet,r.to_wallet,r.description],['imported','withdraw',2000,'Bank account','Household cash','Withdraw cash']);
    let t=(await txs(A)).pop();eq([t.type,t.wallet,t.to_wallet,t.category,t.note,t.user_id],['withdraw','Bank account','Household cash','Withdraw cash','Bank SMS · ATM',Ahmed]);
    let b=await bal(Ahmed,A);eq([b['Bank account'],b['Household cash']],[b0['Bank account']-2000,b0['Household cash']+2000]);eq(+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance,s0);
    const d=await imp(kA,'cash_deposit_en');eq([d.status,d.type,d.wallet,d.to_wallet],['imported','deposit','Household cash','Bank account']);
    t=(await txs(A)).pop();eq([t.type,t.wallet,t.to_wallet,t.category,t.amount],['deposit','Household cash','Bank account','Cash back to bank',3000]);
    b=await bal(Ahmed,A);eq([b['Bank account'],b['Household cash']],[b0['Bank account']+1000,b0['Household cash']-1000])});
  await test('credit / InstaPay received / refund → income on the bank wallet; bank transfer / InstaPay sent → expense; descriptions keep the names',async()=>{
    const b0=await bal(Ahmed,A);const got=[];
    for(const id of ['credit_en','instapay_in_ar','refund_en','transfer_ar','instapay_out_en']){const r=await imp(kA,id);eq(r.status,'imported',id);const t=(await txs(A)).pop();got.push([t.type,t.amount,t.wallet,t.category,t.note])}
    eq(got,[['income',15000,'Bank account','Add income','From ACME COMPANY · Bank SMS · Bank'],['income',300,'Bank account','Add income','From سارة حسن · Bank SMS · InstaPay · ref 555666777'],
      ['income',120,'Bank account','Add income','Refund · AMAZON EG · Bank SMS · Card'],['expense',500,'Bank account','محمد علي','Transfer · Bank SMS · Bank · ref 778899'],['expense',750,'Bank account','ahmed@instapay','Transfer · Bank SMS · InstaPay · ref 987654321']]);
    eq((await bal(Ahmed,A))['Bank account'],b0['Bank account']+15000+300+120-500-750);
    eq((await one(Ahmed,"select range_stats($1,(now() at time zone 'Africa/Cairo')::date-3,(now() at time zone 'Africa/Cairo')::date) s",[A])).s.by_member[0].name,'Ahmed','counted in the normal statistics under the key owner')});
  await test('an imported entry behaves like a manual one afterwards: creator can edit it (history recorded), another member cannot, creator can delete it',async()=>{
    const r=await imp(kA,'Your card ending 1234 was charged EGP 40.00 at KIOSK on '+YD.txt+' 08:00. Ref 40404040');const id=r.transaction_id;
    eq((await as(Mona,"update transactions set amount=1 where id=$1 returning id",[id])).rows.length,0,'RLS: not the creator, not the owner');
    eq((await as(Ahmed,"update transactions set amount=45,category='Kiosk' where id=$1 returning id",[id])).rows.length,1);
    const a=(await admin.query('select action,actor,(old_row->>\'amount\')::float8 o,(new_row->>\'amount\')::float8 n from audit_log where tx_id=$1',[id])).rows;eq(a,[{action:'UPDATE',actor:Ahmed,o:40,n:45}]);
    await throws(()=>as(Ahmed,"update transactions set type='income' where id=$1",[id]),/immutable/);
    eq((await as(Ahmed,'delete from transactions where id=$1 returning id',[id])).rows.length,1);
    eq((await admin.query('select action from audit_log where tx_id=$1 order by id',[id])).rows.map(x=>x.action),['UPDATE','DELETE'])});
  await test('the app\'s balance rule applies: not enough money in the bank wallet → rejected (insufficient_funds), nothing written; later the same SMS imports',async()=>{
    const n=await count(A),i=(await imports(A)).length,b=(await bal(Ahmed,A))['Bank account'];
    const text='Your card ending 1234 was charged EGP 900,000.00 at CAR DEALER on '+YD.txt+' 11:00. Ref 9000001';
    const r=await imp(kA,text);eq([r.http,r.ok,r.status,r.reason,r.amount],[409,false,'rejected','insufficient_funds',900000]);ok(/Insufficient funds\. Available balance in Bank account/.test(r.detail));
    eq([await count(A),(await imports(A)).length,(await bal(Ahmed,A))['Bank account']],[n,i,b]);
    await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',900000,'Add income','']);
    eq((await imp(kA,text)).status,'imported');eq((await imp(kA,text)).status,'already_imported');eq(await count(A),n+2)});
  await test('wallet_required: no wallet is ever picked arbitrarily (cash wallet gone → ATM message refused; bank wallet gone → everything refused; no "Bank account" → no key)',async()=>{
    const n=await count(A),atm='Cash withdrawal of EGP 100.00 from ATM using card ending 1234 on '+YD.txt+' at 07:00';
    await admin.query('update bank_import_keys set cash_wallet_id=null where user_id=$1',[Mona]);
    eq(await imp(kMona,atm),{http:409,ok:false,status:'wallet_required',reason:'cash_wallet_missing',provider:'atm',type:'withdraw'});
    eq((await imp(kMona,'Your card ending 1234 was charged EGP 5.00 at GUM SHOP on '+YD.txt+' 07:01',{dry_run:true})).status,'would_import','purchases need only the bank wallet');
    await admin.query('update bank_import_keys set wallet_id=null where user_id=$1',[Mona]);
    eq((await imp(kMona,'Your card ending 1234 was charged EGP 5.00 at GUM SHOP on '+YD.txt+' 07:01')).reason,'account_wallet_missing');
    await admin.query('update bank_import_keys set wallet_id=$2,cash_wallet_id=$3 where user_id=$1',[Mona,WA['Bank account'],WA['Household cash']]);eq(await count(A),n);
    const Zed=await user('Zed'),Z=(await one(Zed,"select create_household('Home Z') h")).h;await admin.query("update wallets set name='Savings' where household_id=$1 and name='Bank account'",[Z]);
    await throws(()=>newKey(Zed),/wallet_required/);const zw=(await admin.query("select id from wallets where household_id=$1 and name='Savings'",[Z])).rows[0].id;
    eq((await newKey(Zed,'BanK-AIAhly',zw)).wallet,'Savings','an explicitly chosen wallet of the own household is fine')});

  console.log('\nDuplicate prevention');
  await test('same SMS twice → one transaction; the second answer is already_imported and changes nothing',async()=>{
    const n=await count(A),before=JSON.stringify((await txs(A)).find(t=>t.id===cardTx));
    const r=await imp(kA,'card_en');eq(r,{http:200,ok:true,status:'already_imported',transaction_id:cardTx});
    eq([await count(A),JSON.stringify((await txs(A)).find(t=>t.id===cardTx))],[n,before]);
    eq((await post(kA,{sender:'BanK-AIAhly',text:'  '+sms('card_en').replace(/ /g,'   ')+'\n'})).status,'already_imported','spacing differences are the same message')});
  await test('same SMS ten times at the same moment → exactly one transaction, one import record, one outbox row',async()=>{
    const n=await count(A),text='Your card ending 1234 was charged EGP 77.00 at BAKERY on '+YD.txt+' 10:10. Available balance EGP 1.00';
    const rs=await quiet(()=>Promise.all(Array.from({length:10},async()=>{const r=await handle(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer '+kA},body:JSON.stringify({sender:'BanK-AIAhly',text})}),ENV,fakeFetch);return(await r.json())})));
    eq(rs.map(r=>r.status).sort(),['already_imported',...Array(8).fill('already_imported'),'imported']);eq(new Set(rs.map(r=>r.transaction_id)).size,1,'all ten name the same transaction');
    eq(await count(A),n+1);const id=rs[0].transaction_id;eq(+(await admin.query('select count(*) n from bank_imports where transaction_id=$1',[id])).rows[0].n,1);eq(+(await admin.query('select count(*) n from notification_outbox where transaction_id=$1',[id])).rows[0].n,1);
    for(let i=0;i<10;i++)eq((await imp(kA,text)).status,'already_imported');eq(await count(A),n+1)});
  await test('retry after a timeout / lost answer: the entry was saved but the caller saw an error → the retry reports already_imported, still one transaction',async()=>{
    const n=await count(A),text='Your card ending 1234 was charged EGP 66.00 at PHARMACY on '+YD.txt+' 12:12. Ref 66006600';
    world.loseReply=true;const r1=await imp(kA,text);eq([r1.http,r1.status],[500,'error']);eq(await count(A),n+1,'it WAS saved');
    const r2=await imp(kA,text);eq([r2.status,r2.transaction_id],['already_imported',(await txs(A)).pop().id]);eq(await count(A),n+1)});
  await test('same bank reference twice (even with different wording) → one transaction; a different reference or amount is a different transaction',async()=>{
    const n=await count(A),t=ref=>`A transfer of EGP 55.00 from your account ending 5678 to OMAR was executed on ${YD.txt}. Ref ${ref}`;
    eq((await imp(kA,t('FT111222'))).status,'imported');eq((await imp(kA,t('FT111222').replace('was executed','was completed successfully'))).status,'already_imported');eq((await imp(kA,t('ft111222'))).status,'already_imported');
    eq((await imp(kA,t('FT111223'))).status,'imported');eq(await count(A),n+2)});
  await test('duplicates across the household: the same message from another member\'s phone (joint account) is not booked twice; another household is separate',async()=>{
    const n=await count(A),nB=await count(B);
    eq(await imp(kMona,'card_en'),{http:200,ok:true,status:'already_imported',transaction_id:cardTx});eq(await count(A),n);
    eq((await imp(kB,'card_en')).status,'imported');eq(await count(B),nB+1)});
  await test('an imported entry that was deleted in the app is NOT re-created when the phone re-sends the SMS',async()=>{
    const text='Your card ending 1234 was charged EGP 33.00 at CAFE on '+YD.txt+' 13:13. Ref 33003300';const r=await imp(kA,text);
    await as(Ahmed,'delete from transactions where id=$1',[r.transaction_id]);const n=await count(A);
    eq(await imp(kA,text),{http:200,ok:true,status:'already_imported',transaction_id:null});eq(await count(A),n)});
  await test('dry run: reports what would happen (parsing, wallets, duplicate state) and writes nothing; the real import afterwards works',async()=>{
    const n=await count(A),i=(await imports(A)).length,text='Refund of EGP 12.00 from BOOKSHOP to your card ending 1234 on '+YD.txt;
    const r=await imp(kA,text,{dry_run:true});eq([r.http,r.ok,r.status,r.dry_run,r.provider,r.kind,r.type,r.amount,r.wallet,r.transaction_id],[200,true,'would_import',true,'bank_card','refund','income',12,'Bank account',undefined]);
    eq([await count(A),(await imports(A)).length],[n,i]);eq((await imp(kA,text)).status,'imported');eq((await imp(kA,text,{dry_run:true})).status,'already_imported');eq(await count(A),n+1)});

  console.log('\nNotification pipeline (existing outbox → notify-transactions → OneSignal)');
  await test('import → the normal outbox row → existing notify-transactions (server call) → OneSignal: household members only, never the key owner, never another household',async()=>{
    sent.length=0;world.notifyCalls.length=0;world.authCalls=0;
    const r=await imp(kA,'Your card ending 1234 was charged EGP 88.00 at SEOUDI MARKET on '+YD.txt+' 15:15. Ref 88008800');
    eq([r.status,r.notification],['imported','triggered']);eq(world.notifyCalls,[{on_behalf_of:Ahmed}]);eq(world.authCalls,0);
    eq(sent.map(s=>[s.include_subscription_ids,s.headings.en,s.contents.en]),[[[sub(3)],'🔔 مصروف جديد','أضاف Ahmed مصروفًا بقيمة 88.00 جنيه: SEOUDI MARKET · Bank SMS · Card · ref 88008800']]);
    const o=await outbox(r.transaction_id);eq([o.status,o.recipients],['sent',1]);
    sent.length=0;eq((await imp(kA,'Your card ending 1234 was charged EGP 88.00 at SEOUDI MARKET on '+YD.txt+' 15:15. Ref 88008800')).status,'already_imported');eq(sent.length,0,'a duplicate notifies nobody')});
  await test('notify-transactions unreachable → the import still succeeds, the notification stays queued and is delivered once by the normal app call',async()=>{
    sent.length=0;world.notifyDown=true;const r=await imp(kA,'InstaPay: you received EGP 21.00 in your account ending 5678 from HODA on '+YD.txt+' 16:16. Reference 21002100');world.notifyDown=false;
    eq([r.status,r.notification,sent.length],['imported','queued',0]);eq((await outbox(r.transaction_id)).status,'pending');
    const call=async u=>{const x=await notifyHandle(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer user:'+u,apikey:'anon'},body:'{}'}),ENV,fakeFetch);return x.json()};
    eq((await quiet(()=>call(Bob))).claimed,0);eq((await quiet(()=>call(Mona))).sent,1);eq(sent.map(s=>s.include_subscription_ids),[[sub(3)]]);eq((await quiet(()=>call(Mona))).claimed,0)});
  await test('notify-transactions server call: only the service-role key opens it, a user id is required; a normal user cannot act for someone else',async()=>{
    const nf=async(headers,body)=>quiet(async()=>{const x=await notifyHandle(new Request('https://x/f',{method:'POST',headers,body:JSON.stringify(body)}),ENV,fakeFetch);return{http:x.status,...(await x.json())}});
    eq((await nf({Authorization:'Bearer service-secret'},{})).http,400);eq((await nf({Authorization:'Bearer service-secret'},{on_behalf_of:'not-a-uuid'})).http,400);
    eq((await nf({Authorization:'Bearer service-secret'},{on_behalf_of:Ahmed})).http,200);
    eq((await nf({Authorization:'Bearer service-secreT'},{on_behalf_of:Ahmed})).http,401);eq((await nf({Authorization:'Bearer '+kA},{on_behalf_of:Ahmed})).http,401,'an import key is not a login');
    sent.length=0;const t=(await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',3,'Gum',''])).rows[0].id;
    const r=await nf({Authorization:'Bearer user:'+Bob,apikey:'anon'},{on_behalf_of:Ahmed});eq([r.http,r.claimed,sent.length],[200,0,0],'on_behalf_of from a browser session is ignored');eq((await outbox(t)).status,'pending')});

  console.log('\nLogging and clean-up');
  await test('logs: outcome, rule, reason and hashed identifiers only - never the SMS text, a name, a key or the service key',async()=>{
    const all=logs.join('\n');ok(logs.length>40,'something was logged');
    for(const s of ['CARREFOUR','كارفور','MOHAMED','ahmed@instapay','SEOUDI','Available balance','card ending',kA,kB,kMona,'service-secret','os_v2_app_testkey','123456789012'])ok(!all.includes(s),'log leaks: '+s.slice(0,12));
    ok(/"status":"imported".*"rule":"nbe\.card_purchase\.en"/.test(all)&&/"status":"already_imported"/.test(all)&&/"status":"unrecognized_sms","reason":"no_rule_matched"/.test(all)&&/"status":"unauthorized","reason":"missing_key"/.test(all))});
  await test('responses never contain keys, hashes, user ids or internal errors',async()=>{
    const r=await imp(kA,'Refund of EGP 2.00 from KIOSK to your card ending 1234 on '+YD.txt+'. Ref 20002000');const s=JSON.stringify(r);
    ok(!s.includes(Ahmed)&&!s.includes(kA)&&!/key_hash|fingerprint|sms_hash|user_id/.test(s),s);
    const bad=await quiet(async()=>{const x=await handle(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer '+kA},body:'{}'}),{SUPABASE_URL:'https://proj.supabase.co'},fakeFetch);return{http:x.status,...(await x.json())}});eq(bad,{http:500,ok:false,status:'error'})});
  await test('account deletion and household deletion still work with keys and import records present',async()=>{
    const Sam=await user('Sam'),S=(await one(Sam,"select create_household('Home S') h")).h;const sw=(await admin.query("select id from wallets where household_id=$1 and name='Bank account'",[S])).rows[0].id;
    await as(Sam,INS,[S,Sam,sw,null,'income',500,'Add income','']);const k=(await newKey(Sam)).key;eq((await imp(k,'card_ar')).status,'imported');
    await as(Sam,"select delete_my_account('DELETE')");eq((await admin.query('select (select count(*) from bank_import_keys where household_id=$1)::int k,(select count(*) from bank_imports where household_id=$1)::int i,(select count(*) from households where id=$1)::int h',[S])).rows[0],{k:0,i:0,h:0});
    eq(await imp(k,'card_ar'),{http:401,ok:false,status:'unauthorized'});
    await as(Mona,"select delete_my_account('DELETE')");eq(await imp(kMona,'card_en'),{http:401,ok:false,status:'unauthorized'});
    eq(+(await admin.query('select count(*) n from bank_imports where household_id=$1 and transaction_id=$2',[A,cardTx])).rows[0].n,1,'the household\'s records stay')});
}catch(e){console.log=_log;console.error=_err;console.log('FATAL',e);process.exitCode=1}
finally{await db.stop()}
done('bank import');
