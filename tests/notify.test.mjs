// Household-only transaction notifications, end to end without Supabase or OneSignal:
//   REAL PostgreSQL + the repository's migrations (trigger, outbox, membership, RLS)
//   + the REAL Edge Function code (supabase/functions/notify-transactions/index.ts)
//   + a recording stand-in for the OneSignal REST API.          node tests/notify.test.mjs
import {test,eq,ok,throws,done,startDb,MIGRATIONS} from './harness.mjs';
import {handle,compose} from '../supabase/functions/notify-transactions/index.ts';
import {createRequire} from 'node:module';const Core=createRequire(import.meta.url)('../core.js');
const db=await startDb();const {admin,as}=db;
const one=async(uid,sql,p)=>(await as(uid,sql,p)).rows[0];
const user=async name=>(await admin.query('insert into auth.users(email,raw_user_meta_data) values($1,$2) returning id',[name+'@t.io',{name}])).rows[0].id;
const sub=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const cid=()=>crypto.randomUUID();

/* ---- the world outside the function ---- */
const sent=[];                       // every request that reached "OneSignal"
const os={mode:'ok',invalid:[]},fakeState={partial:false};     // how "OneSignal" behaves
const ENV={SUPABASE_URL:'https://proj.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service-secret',ONESIGNAL_REST_API_KEY:'os_v2_app_testkey'};
const J=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function fakeFetch(url,init={}){
  const h=init.headers||{};
  if(url.endsWith('/auth/v1/user')){const tok=String(h.Authorization||'').replace('Bearer ','');           // token "user:<uuid>" = a valid login of that user
    const m=/^user:(.+)$/.exec(tok);if(!m)return J(401,{msg:'invalid JWT'});
    const u=(await admin.query('select id from auth.users where id=$1',[m[1]])).rows[0];return u?J(200,{id:u.id}):J(403,{msg:'user not found'})}
  if(url.includes('/rest/v1/rpc/')){if(h.apikey!==ENV.SUPABASE_SERVICE_ROLE_KEY)return J(401,{message:'bad key'});
    const fn=url.split('/rpc/')[1],a=JSON.parse(init.body);const c=admin;await c.query('begin');await c.query('set local role service_role');
    try{let r;if(fn==='push_claim')r=(await c.query('select push_claim($1) v',[a.caller])).rows[0].v;
      else if(fn==='push_done'){await c.query('select push_done($1,$2,$3,$4,$5,$6)',[a.nid,a.st,a.n,a.err,a.bad,a.langs]);r=null}else throw new Error('unexpected rpc '+fn);
      await c.query('commit');return new Response(r===null?'':JSON.stringify(r),{status:200})}catch(e){await c.query('rollback');return J(400,{message:e.message})}}
  if(url==='https://api.onesignal.com/notifications'){const b=JSON.parse(init.body);sent.push({auth:h.Authorization,...b});
    if(os.mode==='down')throw new Error('network error');if(os.mode==='500')return J(500,{errors:['server error']});if(os.mode==='400')return J(400,{errors:['Bad request']});if(os.mode==='401')return J(401,{errors:['Invalid API key']});
    if(fakeState.partial&&b.include_subscription_ids.includes(sub(3)))return J(503,{errors:['try later']});
    const inv=b.include_subscription_ids.filter(x=>os.invalid.includes(x));return J(200,inv.length?{id:'n1',errors:{invalid_player_ids:inv}}:{id:'n1'})}
  throw new Error('unexpected request '+url)}
const call=async(uid,env=ENV,token)=>{const r=await handle(new Request('https://proj.supabase.co/functions/v1/notify-transactions',{method:'POST',headers:{Authorization:'Bearer '+(token||'user:'+uid)},body:'{"household_id":"ignored","recipients":["ignored"]}'}),env,fakeFetch);return{status:r.status,...(await r.json())}};
const targets=()=>sent.map(s=>[...s.include_subscription_ids].sort());
const outbox=async tx=>(await admin.query('select status,recipients,error from notification_outbox where transaction_id=$1',[tx])).rows[0];

let A,B,WA={},WB={},Ahmed,Mona,Dad,Bob,Bea;
const INS='insert into transactions(client_id,household_id,user_id,wallet_id,to_wallet_id,type,amount,category,note) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (client_id) do nothing returning id';
const add=async(uid,h,w,type,amount,cat,{to=null,note='',client=cid()}={})=>{const r=await one(uid,INS,[client,h,uid,w,to,type,amount,cat,note]);return r&&r.id};
try{
  await db.migrate(MIGRATIONS);
  Ahmed=await user('Ahmed');Mona=await user('Mona');Dad=await user('Dad');Bob=await user('Bob');Bea=await user('Bea');
  A=(await one(Ahmed,"select create_household('Home A') h")).h;B=(await one(Bob,"select create_household('Home B') h")).h;
  const code=async(u,h)=>(await one(u,'select invite_code c from households where id=$1',[h])).c;
  await as(Mona,'select join_household($1)',[await code(Ahmed,A)]);await as(Dad,'select join_household($1)',[await code(Ahmed,A)]);await as(Bea,'select join_household($1)',[await code(Bob,B)]);
  for(const w of (await admin.query('select id,name,household_id from wallets')).rows)(w.household_id===A?WA:WB)[w.name]=w.id;
  // devices: Ahmed has a phone (en) and an iPad (ar); Mona one phone (ar); Dad one phone (en); household B: Bob and Bea one each
  await as(Ahmed,'select register_push_device($1,$2)',[sub(1),'en']);await as(Ahmed,'select register_push_device($1,$2)',[sub(2),'ar']);
  await as(Mona,'select register_push_device($1,$2)',[sub(3),'ar']);await as(Dad,'select register_push_device($1,$2)',[sub(5),'en']);
  await as(Bob,'select register_push_device($1,$2)',[sub(11),'en']);await as(Bea,'select register_push_device($1,$2)',[sub(12),'en']);
  // money to spend (also produces notifications; deliver and forget them)
  await add(Ahmed,A,WA['Household cash'],'income',5000,'Add income');await add(Bob,B,WB['Household cash'],'income',5000,'Add income');await call(Ahmed);await call(Bob);sent.length=0;
  const retryNow=()=>admin.query("update notification_outbox set next_attempt_at=now() where status='pending'");
  const cash=()=>WA['Household cash'];

  console.log('\nHousehold targeting (the creator is never notified)');
  let tA;
  await test('1+2. Ahmed adds an expense in household A → the OTHER members of A (Mona, Dad); not Ahmed\'s own devices; nothing to household B',async()=>{
    tA=await add(Ahmed,A,cash(),'expense',250,'Groceries');const r=await call(Ahmed);
    eq([r.status,r.claimed,r.sent,r.failed,r.retry],[200,1,1,0,0]);
    eq(targets(),[[sub(5)],[sub(3)]],'one request per language; Dad (en) and Mona (ar) only:');
    ok(!targets().flat().some(x=>[sub(1),sub(2)].includes(x)),'creator\'s phone and iPad are left out');ok(!targets().flat().some(x=>[sub(11),sub(12)].includes(x)),'no household B device');
    const en=sent.find(s=>s.include_subscription_ids.includes(sub(5))),ar=sent.find(s=>s.include_subscription_ids.includes(sub(3)));
    eq([en.headings.en,en.contents.en],['🔔 New expense','Ahmed added EGP 250.00 for Groceries']);
    eq([ar.headings.en,ar.contents.en],['🔔 مصروف جديد','أضاف Ahmed مصروفًا بقيمة 250.00 جنيه: Groceries'],'Arabic device gets Arabic text; the custom name is untouched:');
    eq([en.app_id,en.target_channel,en.auth],['80a0910d-f366-4e2a-9a97-ca1fb05b0fd4','push','Key os_v2_app_testkey']);ok(!('included_segments' in en)&&!('include_aliases' in en),'never a broadcast');
    const o=await outbox(tA);eq([o.status,o.recipients,o.error],['sent',2,null])});
  await test('3. another member of A (Mona) adds income → Ahmed (both devices) and Dad receive it, Mona does not',async()=>{
    sent.length=0;await add(Mona,A,cash(),'income',900,'Add income',{note:'Salary'});await call(Mona);
    eq(targets(),[[sub(1),sub(5)],[sub(2)]]);eq(sent[0].contents.en,'Mona added EGP 900.00 income (Salary)')});
  await test('household B transaction → only the other member of B',async()=>{
    sent.length=0;await add(Bea,B,WB['Household cash'],'expense',40,'Bread');await call(Bea);eq(targets(),[[sub(11)]]);eq(sent[0].contents.en,'Bea added EGP 40.00 for Bread')});
  await test('creator exclusion is decided in the database and cannot be switched by the function\'s environment or the browser',async()=>{
    sent.length=0;await add(Ahmed,A,cash(),'expense',3,'Gum');await call(Ahmed,{...ENV,NOTIFY_SKIP_CREATOR:'false',NOTIFY_CREATOR:'true'});eq(targets(),[[sub(5)],[sub(3)]]);
    eq((await admin.query('select push_targets($1,$2) t',[A,Ahmed])).rows[0].t,{ar:[sub(3)],en:[sub(5)]});
    eq((await admin.query('select push_targets($1,null) t',[A])).rows[0].t,{ar:[sub(2),sub(3)],en:[sub(1),sub(5)]},'(a future preference system can include the creator by changing push_targets only)')});
  await test('nobody else has a device (single-member household / all others unsubscribed) → processed as "skipped", nothing sent',async()=>{
    const Solo=await user('Solo');const h=(await one(Solo,"select create_household('Solo') h")).h;const w=(await admin.query("select id from wallets where household_id=$1 and name='Household cash'",[h])).rows[0].id;
    await as(Solo,'select register_push_device($1,$2)',[sub(20),'en']);sent.length=0;const t=await add(Solo,h,w,'income',10,'Add income');const r=await call(Solo);
    eq([r.claimed,r.sent,sent.length],[1,0,0]);const o=await outbox(t);eq([o.status,o.error],['skipped','no subscribed devices besides the creator'])});
  await test('the browser cannot choose recipients: a member of B calling the function gets nothing of A\'s; request body is ignored',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',5,'Pen');const r=await call(Bob);eq([r.claimed,sent.length],[0,0]);eq((await outbox(t)).status,'pending');
    await call(Ahmed);eq(targets(),[[sub(5)],[sub(3)]])});
  await test('caller must be signed in: no token / forged token → 401, nothing sent, nothing claimed',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',6,'Pen');
    eq((await call(null,ENV,'garbage')).status,401);eq((await call(null,ENV,'user:00000000-0000-4000-8000-00000000ffff')).status,401);eq(sent.length,0);eq((await outbox(t)).status,'pending');await call(Ahmed);sent.length=0});
  await test('all transaction types are announced (withdraw, deposit, transfer with wallets; built-in item localized by key)',async()=>{
    sent.length=0;const b=WA['Bank account'],c=cash(),p=WA['Personal cash'];
    await add(Ahmed,A,c,'deposit',1000,'Cash back to bank',{to:b});await add(Ahmed,A,c,'transfer',300,'Transfer',{to:p});await add(Ahmed,A,b,'withdraw',200,'Withdraw cash',{to:c});await add(Ahmed,A,c,'expense',20,'Bread');
    await call(Ahmed);const en=sent.filter(s=>s.include_subscription_ids.includes(sub(5))).map(s=>s.headings.en+' | '+s.contents.en),ar=sent.filter(s=>s.include_subscription_ids.includes(sub(3))).map(s=>s.contents.en);
    eq(en.length,4);ok(en.some(x=>/Transfer \| Ahmed transferred EGP 300.00: Household cash → Personal cash/.test(x)),en.join('\n'));ok(en.some(x=>/New expense \| Ahmed added EGP 20.00 for Bread/.test(x)));
    ok(en.some(x=>/Cash deposited \| Ahmed deposited EGP 1,000.00: Household cash → Bank account$/.test(x))&&en.some(x=>/Cash withdrawal \| Ahmed withdrew EGP 200.00: Bank account → Household cash$/.test(x)),en.join('\n'));
    ok(ar.some(x=>x==='أضاف Ahmed مصروفًا بقيمة 20.00 جنيه: خبز'),ar.join('\n'));ok(ar.some(x=>x==='حوّل Ahmed 300.00 جنيه: نقدية المنزل ← نقدية شخصية'),ar.join('\n'))});

  console.log('\nOnly after a successful commit; never twice; never silently lost');
  await test('4. transaction rejected by the database (insufficient funds / RLS / rollback) → no outbox row, no notification',async()=>{
    sent.length=0;const n=(await admin.query('select count(*)::int n from notification_outbox')).rows[0].n;
    await throws(()=>add(Mona,A,WA['Personal cash'],'expense',999999,'Car'),/Insufficient funds/);
    await throws(()=>as(Bob,INS,[cid(),A,Bob,cash(),null,'expense',1,'Hack','']),/row-level security|violates/);        // not a member: RLS rejects
    const c=await db.conn();try{await db.begin(c,Ahmed);await c.query(INS,[cid(),A,Ahmed,cash(),null,'expense',7,'Rolled back','']);await c.query('rollback')}finally{await c.end()}   // rolled back
    eq((await admin.query('select count(*)::int n from notification_outbox')).rows[0].n,n);await call(Mona);await call(Ahmed);eq(sent.length,0)});
  await test('5. OneSignal fails (HTTP 500, then unreachable) → transaction stays committed, failure logged, function answers 200, notification stays queued and is delivered ONCE when OneSignal is back',async()=>{
    sent.length=0;os.mode='500';const t=await add(Ahmed,A,cash(),'expense',11,'Tea');let r=await call(Ahmed);eq([r.status,r.claimed,r.sent,r.failed,r.retry],[200,1,0,0,1]);
    eq((await admin.query('select count(*)::int n from transactions where id=$1',[t])).rows[0].n,1,'transaction exists:');
    let o=(await admin.query('select status,attempts,error,next_attempt_at>now() later from notification_outbox where transaction_id=$1',[t])).rows[0];eq([o.status,o.attempts,o.later],['pending',1,true]);ok(/HTTP 500/.test(o.error),o.error);
    r=await call(Ahmed);eq(r.claimed,0,'back-off: not hammered immediately');
    os.mode='down';await retryNow();r=await call(Mona);eq(r.retry,1);ok(/network error/.test((await outbox(t)).error));
    os.mode='ok';sent.length=0;await retryNow();r=await call(Dad);eq([r.claimed,r.sent],[1,1],'any member\'s app can deliver it later');eq(targets(),[[sub(5)],[sub(3)]]);eq((await outbox(t)).status,'sent');
    sent.length=0;await retryNow();await call(Ahmed);await call(Mona);eq(sent.length,0,'delivered exactly once')});
  await test('one language batch accepted, the other failed → only the failed batch is sent again (same idempotency key)',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',13,'Tea');fakeState.partial=true;await call(Ahmed);fakeState.partial=false;
    eq(targets(),[[sub(5)],[sub(3)]]);const key=sent[1].idempotency_key;let o=(await admin.query('select status,done_langs from notification_outbox where transaction_id=$1',[t])).rows[0];eq([o.status,o.done_langs],['pending',['en']]);
    sent.length=0;await retryNow();await call(Ahmed);eq(targets(),[[sub(3)]],'English devices are not notified a second time:');eq(sent[0].idempotency_key,key);
    o=(await admin.query('select status,recipients,done_langs from notification_outbox where transaction_id=$1',[t])).rows[0];eq([o.status,o.recipients,o.done_langs],['sent',2,['ar','en']])});
  await test('permanent failures are explicit: invalid request (HTTP 400) → failed at once; temporary errors → failed only after 10 attempts; reason recorded',async()=>{
    sent.length=0;os.mode='400';const t1=await add(Ahmed,A,cash(),'expense',14,'Tea');let r=await call(Ahmed);eq([r.failed,r.retry],[1,0]);os.mode='500';
    let o=await outbox(t1);eq(o.status,'failed');ok(/HTTP 400/.test(o.error),o.error);
    const t2=await add(Ahmed,A,cash(),'expense',15,'Tea');for(let i=0;i<10;i++){await retryNow();await call(Ahmed)}os.mode='ok';
    o=(await admin.query('select status,attempts,error from notification_outbox where transaction_id=$1',[t2])).rows[0];eq([o.status,o.attempts],['failed',10]);ok(/gave up after 10 attempts/.test(o.error)&&/HTTP 500/.test(o.error),o.error);
    eq((await admin.query('select count(*)::int n from transactions where id=any($1)',[[t1,t2]])).rows[0].n,2,'transactions untouched:');sent.length=0;await retryNow();await call(Ahmed);eq(sent.length,0)});
  await test('a wrong / revoked OneSignal key (HTTP 401) is a fixable problem → stays queued, delivered after the key is corrected',async()=>{
    sent.length=0;os.mode='401';const t=await add(Ahmed,A,cash(),'expense',16,'Tea');eq((await call(Ahmed)).retry,1);eq((await outbox(t)).status,'pending');os.mode='ok';sent.length=0;await retryNow();await call(Ahmed);eq(sent.length,2);eq((await outbox(t)).status,'sent')});
  await test('6+7. offline entry synced later: notified once at commit; retrying the same entry (same client_id) and calling again sends nothing more',async()=>{
    sent.length=0;const client=cid();
    await call(Ahmed);eq(sent.length,0,'nothing while the entry only exists on the phone');
    const t=await add(Ahmed,A,cash(),'expense',33,'Offline lunch',{client});ok(t);await call(Ahmed);eq(sent.length,2);
    eq(await add(Ahmed,A,cash(),'expense',33,'Offline lunch',{client}),undefined,'retry inserts nothing');
    eq((await admin.query('select count(*)::int n from notification_outbox where transaction_id=$1',[t])).rows[0].n,1);
    await call(Ahmed);await call(Mona);await Promise.all([call(Ahmed),call(Mona),call(Dad)]);eq(sent.length,2,'still exactly one notification (2 language batches)');
    ok(sent[0].idempotency_key&&sent[0].idempotency_key!==sent[1].idempotency_key&&/^[0-9a-f-]{36}$/.test(sent[1].idempotency_key),'OneSignal idempotency keys')});
  await test('concurrent calls from several members claim each notification exactly once',async()=>{
    sent.length=0;await add(Dad,A,cash(),'expense',9,'Gum');const rs=await Promise.all([call(Ahmed),call(Mona),call(Dad),call(Ahmed)]);
    eq(rs.reduce((a,r)=>a+r.claimed,0),1);eq(targets().flat().sort(),[sub(1),sub(2),sub(3)])});
  await test('creator closed the app at once (nobody called the function): the notification is NOT lost - still delivered hours later by the next member whose app opens',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',8,'Late');await admin.query("update notification_outbox set created_at=now()-interval '20 hours' where transaction_id=$1",[t]);
    const r=await call(Mona);eq([r.claimed,r.sent],[1,1]);eq(targets(),[[sub(5)],[sub(3)]]);eq((await outbox(t)).status,'sent')});
  await test('documented limit: not deliverable for 48 hours → closed as failed with the reason (never sent days late)',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',8,'Ancient');await admin.query("update notification_outbox set created_at=now()-interval '49 hours' where transaction_id=$1",[t]);
    await call(Ahmed);eq(sent.length,0);const o=await outbox(t);eq(o.status,'failed');ok(/not delivered within 48:00:00 - given up/.test(o.error),o.error)});
  await test('a run that died mid-way ("sending" for over 2 minutes) is taken over; a fresh "sending" row is left alone',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',8,'Crash');await admin.query("update notification_outbox set status='sending',claimed_at=now() where transaction_id=$1",[t]);
    await call(Ahmed);eq(sent.length,0);await admin.query("update notification_outbox set claimed_at=now()-interval '3 minutes' where transaction_id=$1",[t]);await call(Ahmed);eq(sent.length,2);eq((await outbox(t)).status,'sent')});
  await test('edits and deletes do not notify; deleting an entry removes its pending notification',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',8,'Temp');await as(Ahmed,'update transactions set amount=9 where id=$1',[t]);
    eq((await admin.query('select count(*)::int n from notification_outbox where transaction_id=$1',[t])).rows[0].n,1);await as(Ahmed,'delete from transactions where id=$1',[t]);await call(Ahmed);eq(sent.length,0)});

  console.log('\nDevices and identity');
  await test('8. several devices per user: each device once per notification, in its own language; a device re-registered many times stays one row',async()=>{
    for(let i=0;i<3;i++)await as(Ahmed,'select register_push_device($1,$2)',[sub(1),'en']);eq((await admin.query('select count(*)::int n from push_devices where user_id=$1',[Ahmed])).rows[0].n,2);
    sent.length=0;await add(Mona,A,cash(),'expense',3,'Gum');await call(Mona);const all=targets().flat();eq(all.sort(),[sub(1),sub(2),sub(5)],'Ahmed\'s phone + iPad and Dad\'s phone:');eq(new Set(all).size,all.length,'no device twice:')});
  await test('9. log out / switch account on a shared phone: the device follows the account that is signed in now',async()=>{
    await as(Mona,'select unregister_push_device($1)',[sub(3)]);                                   // Mona logs out
    sent.length=0;await add(Ahmed,A,cash(),'expense',4,'Gum');await call(Ahmed);eq(targets(),[[sub(5)]],'logged-out device is not targeted');
    await as(Bea,'select register_push_device($1,$2)',[sub(3),'en']);                              // Bea (household B) logs in on the same phone
    sent.length=0;await add(Ahmed,A,cash(),'expense',4,'Gum');await call(Ahmed);ok(!targets().flat().includes(sub(3)),'A never reaches a device now used by a B member');
    sent.length=0;await add(Bob,B,WB['Household cash'],'expense',4,'Gum');await call(Bob);eq(targets(),[[sub(3),sub(12)]],'Bea now gets B\'s notifications on both of her devices');
    await as(Ahmed,'select unregister_push_device($1)',[sub(3)]);eq((await admin.query('select user_id from push_devices where subscription_id=$1',[sub(3)])).rows[0].user_id,Bea,'someone else cannot remove your device');
    await as(Mona,'select register_push_device($1,$2)',[sub(3),'ar']);eq((await admin.query('select count(*)::int n from push_devices where subscription_id=$1',[sub(3)])).rows[0].n,1,'a device has exactly one owner')});
  await test('member removed from the household → no longer a recipient (membership is read at send time), cannot trigger its notifications',async()=>{
    await as(Ahmed,'select remove_member($1,$2)',[A,Mona]);sent.length=0;await add(Ahmed,A,cash(),'expense',4,'Gum');eq((await call(Mona)).claimed,0);await call(Ahmed);eq(targets(),[[sub(5)]])});
  await test('10. deleted account → its devices are removed with the account and never targeted again; its queued entries still notify the others',async()=>{
    const t=await add(Dad,A,cash(),'expense',4,'Dad gum');                                         // Dad adds an entry, then deletes his account before anything was sent
    await as(Dad,"select delete_my_account('DELETE')");eq((await admin.query('select count(*)::int n from push_devices where subscription_id=$1',[sub(5)])).rows[0].n,0);
    eq((await call(Dad)).status,401,'a deleted account cannot call the function');
    sent.length=0;await call(Ahmed);eq(targets().flat().sort(),[sub(1),sub(2)]);ok(sent.every(s=>/^(Someone|أحد الأعضاء| ?أضاف أحد الأعضاء)/.test(s.contents.en)||/Someone|أحد الأعضاء/.test(s.contents.en)),sent.map(s=>s.contents.en).join(' | '));
    eq((await outbox(t)).status,'sent');sent.length=0;await add(Ahmed,A,cash(),'expense',4,'Gum');await call(Ahmed);eq(sent.length,0,'no other member with a device is left')});
  await test('a device OneSignal reports as invalid is forgotten',async()=>{
    await as(Mona,'select join_household($1)',[await code(Ahmed,A)]);os.invalid=[sub(2)];sent.length=0;await add(Mona,A,cash(),'expense',4,'Gum');await call(Mona);os.invalid=[];
    eq((await admin.query('select subscription_id from push_devices where user_id=$1',[Ahmed])).rows.map(r=>r.subscription_id),[sub(1)])});

  console.log('\nSecurity');
  await test('the notification tables and server functions are unreachable from a logged-in browser',async()=>{
    await throws(()=>as(Ahmed,'select * from push_devices'),/permission denied/);await throws(()=>as(Ahmed,'select * from notification_outbox'),/permission denied/);
    await throws(()=>as(Ahmed,"insert into notification_outbox(transaction_id,household_id) values(gen_random_uuid(),$1)",[B]),/permission denied/);
    await throws(()=>as(Ahmed,'select push_claim($1)',[Bob]),/permission denied/);await throws(()=>as(Ahmed,"select push_done(gen_random_uuid(),'sent')"),/permission denied/);await throws(()=>as(Ahmed,'select push_targets($1,null)',[B]),/permission denied/);
    await throws(()=>as(null,'select register_push_device($1)',[sub(9)]),/not signed in|permission denied/);await throws(()=>as(Ahmed,'select register_push_device($1)',['not-an-id!']),/invalid subscription id/)});
  await test('without the OneSignal secret nothing is claimed or sent and the function does not fail; the notification waits and goes out once the secret exists',async()=>{
    sent.length=0;const t=await add(Ahmed,A,cash(),'expense',4,'Gum');const r=await call(Ahmed,{...ENV,ONESIGNAL_REST_API_KEY:''});eq([r.status,r.configured,r.claimed],[200,false,0]);eq(sent.length,0);eq((await outbox(t)).status,'pending');
    await call(Ahmed);eq(targets(),[[sub(3)]]);eq((await outbox(t)).status,'sent')});
  await test('message text: Arabic names for every built-in item match the app catalog; custom text is never altered; CORS preflight',async()=>{
    for(const c of Core.CATALOG)eq(compose({type:'expense',amount:1,category:c.en,builtin_key:c.key,actor:'x'},'ar').body,`أضاف x مصروفًا بقيمة 1.00 جنيه: ${c.ar}`);
    eq(compose({type:'expense',amount:12.5,category:'Fish food',builtin_key:null,actor:'منى'},'ar').body,'أضاف منى مصروفًا بقيمة 12.50 جنيه: Fish food');
    eq(compose({type:'expense',amount:29,category:'صلصه',actor:'mohamed'},'en').body,'mohamed added EGP 29.00 for صلصه');
    eq(compose({type:'expense',amount:70,category:'Fish',builtin_key:'fish',note:'Tuna',actor:''},'en'),{title:'🔔 New expense',body:'Someone added EGP 70.00 for Fish · Tuna'});
    const r=await handle(new Request('https://x/functions/v1/notify-transactions',{method:'OPTIONS'}),ENV,fakeFetch);eq([r.status,r.headers.get('Access-Control-Allow-Origin')],[200,'*']);
    eq((await handle(new Request('https://x/f',{method:'GET'}),ENV,fakeFetch)).status,405)});
}catch(e){console.error(e);process.exitCode=1}
finally{done('notifications');await db.stop()}
