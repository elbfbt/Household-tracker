// Real-database tests: runs the repository's SQL files on a real PostgreSQL and exercises them as the
// "authenticated" role with RLS on. No Supabase project needed:  node tests/db.test.mjs
import {test,eq,ok,throws,done,startDb,MIGRATIONS} from './harness.mjs';
const db=await startDb();const {admin,as}=db;
const one=async(uid,sql,p)=>(await as(uid,sql,p)).rows[0];
const user=async name=>(await admin.query('insert into auth.users(email,raw_user_meta_data) values($1,$2) returning id',[name+'@t.io',{name}])).rows[0].id;
const INS='insert into transactions(client_id,household_id,user_id,wallet_id,to_wallet_id,type,amount,category) values(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7) returning id';
let H,O,M,D,W={};
const add=(uid,type,amount,w1,w2=null,cat=type)=>one(uid,INS,[H,uid,W[w1],w2?W[w2]:null,type,amount,cat]).then(r=>r.id);
const bals=async uid=>{const r=(await one(uid,'select wallet_balances($1) b',[H])).b;return Object.fromEntries(r.map(x=>[x.name,+x.balance]))};
try{
  await db.migrate(MIGRATIONS.slice(0,-1));   // everything up to 007 = the state in which the bug was reported
  O=await user('Owner');M=await user('Member');D=await user('Dad');
  H=(await one(O,"select create_household('Home') h")).h;
  const code=(await one(O,'select invite_code c from households where id=$1',[H])).c;
  await as(M,'select join_household($1)',[code]);await as(D,'select join_household($1)',[code]);
  for(const w of (await as(O,'select id,name from wallets where household_id=$1',[H])).rows)W[w.name]=w.id;
  const C='Household cash',B='Bank account',P='Personal cash';
  let tTransfer,tDadExpense,tMine;

  console.log('\nFunds (database-enforced)');
  await test('setup: income, withdraw, transfer, expense are accepted',async()=>{
    await add(O,'income',1000,B);await add(O,'withdraw',500,B,C);
    tTransfer=await add(D,'transfer',200,C,P,'Top-up');tDadExpense=await add(D,'expense',150,P,null,'Fish');
    eq(await bals(O),{[C]:300,[B]:500,[P]:50})});
  await test('expense cannot make a wallet negative',async()=>{
    await throws(()=>add(M,'expense',60,P),/Insufficient funds\. Available balance in Personal cash: 50\.00 EGP/)});
  await test('transfer cannot make the source wallet negative (and is atomic)',async()=>{
    await throws(()=>add(M,'transfer',60,P,C),/Insufficient funds/);eq(await bals(O),{[C]:300,[B]:500,[P]:50})});
  await test('editing an expense upwards beyond the balance is rejected (UPDATE keeps the funds rule)',async()=>{
    tMine=await add(M,'expense',10,P,null,'Bread');
    await throws(()=>as(M,'update transactions set amount=500 where id=$1',[tMine]),/Insufficient funds/);
    eq((await bals(O))[P],40)});
  await test('two devices cannot both spend the same available balance (real concurrent sessions)',async()=>{
    const a=await db.conn(),b=await db.conn();
    try{await db.begin(a,O);await db.begin(b,M);
      await a.query(INS,[H,O,W[P],null,'expense',30,'A']);              // device A: not committed yet, holds the wallet lock
      let bState='waiting';const pb=b.query(INS,[H,M,W[P],null,'expense',30,'B']).then(()=>bState='ok',e=>bState=e.message);
      await new Promise(r=>setTimeout(r,400));eq(bState,'waiting','device B must wait for the wallet lock:');
      await a.query('commit');await pb;
      ok(/Insufficient funds\. Available balance in Personal cash: 10\.00 EGP/.test(bState),'device B should be rejected, got: '+bState);
      await b.query('rollback');
    }finally{await a.end();await b.end()}
    eq((await bals(O))[P],10)});
  await test('transfers/withdrawals are not spending and do not change the total',async()=>{
    const s=(await one(O,'select household_summary($1) s',[H])).s,b=await bals(O);
    eq(+s.month,190);eq(+s.balance,810);eq(b[C]+b[B]+b[P],810);
    const r=(await one(O,"select range_stats($1,(now() at time zone 'Africa/Cairo')::date,(now() at time zone 'Africa/Cairo')::date) s",[H])).s;
    eq(+r.expenses,190);eq(+r.income,1000);eq(r.count,3)});
  await test('offline retry of the same entry (same client_id) never duplicates',async()=>{
    const cid='11111111-1111-4111-8111-111111111111',q='insert into transactions(client_id,household_id,user_id,wallet_id,type,amount,category) values($1,$2,$3,$4,$5,$6,$7) on conflict(client_id) do nothing';
    await as(M,q,[cid,H,M,W[C],'expense',5,'Milk']);await as(M,q,[cid,H,M,W[C],'expense',5,'Milk']);
    eq((await admin.query('select count(*)::int n from transactions where client_id=$1',[cid])).rows[0].n,1)});
  await test('wallet / ownership rules: foreign wallet, other user, anon are rejected',async()=>{
    const X=await user('Stranger');const H2=(await one(X,"select create_household('Other') h")).h;
    const w2=(await one(X,'select id from wallets where household_id=$1 limit 1',[H2])).id;
    await throws(()=>one(M,INS,[H,M,w2,null,'expense',1,'x']),/wallet does not belong/);
    await throws(()=>one(M,INS,[H,O,W[C],null,'expense',1,'x']),/row-level security|another user/);
    await throws(()=>one(X,INS,[H,X,W[C],null,'expense',1,'x']),/row-level security/);
    eq((await as(X,'select count(*)::int n from transactions where household_id=$1',[H])).rows[0].n,0,'stranger sees nothing:');
    await throws(()=>as(M,"insert into wallets(household_id,name) values($1,'Mine')",[H]),/row-level security/);
    await throws(()=>as(X,'select wallet_bal($1)',[W[C]]),/permission denied/);
    await admin.query('begin');await admin.query('set local role anon');
    const e=await throws(()=>admin.query('select * from transactions'),/permission denied/);await admin.query('rollback');ok(e)});

  console.log('\nRoot cause of the reported delete error (database at 007, before the fix)');
  await test('REPRODUCED: deleting an entry that put money INTO a wallet fails with "Insufficient funds ... Personal cash"',async()=>{
    // Personal cash = 10: Dad transferred 200 in and 190 of it has been spent. Deleting the 200 transfer lowers the wallet.
    const e=await throws(()=>as(O,'delete from transactions where id=$1',[tTransfer]),/Insufficient funds\. Available balance in Personal cash: 10\.00 EGP/);
    eq(e.code,'P0001')});
  await test('...and it does NOT depend on the creator being deleted (same error for a living user\'s income)',async()=>{
    const inc=await add(M,'income',20,P);await add(M,'expense',25,P,null,'Tea');
    await throws(()=>as(M,'delete from transactions where id=$1',[inc]),/Insufficient funds\. Available balance in Personal cash: 5\.00 EGP/);
    await as(O,'delete from transactions where category=$1',['Tea']);await as(M,'delete from transactions where id=$1',[inc])});
  await test('deleting an expense (money comes back) was never blocked',async()=>{
    const x=await add(M,'expense',1,P);eq((await as(M,'delete from transactions where id=$1 returning id',[x])).rowCount,1)});

  await test('REPRODUCED (007 NULL-logic hole): an owner could blank the creator of a living member\'s entry',async()=>{
    await admin.query('begin');await admin.query('set local role authenticated');await admin.query("select set_config('request.jwt.claim.sub',$1,true)",[O]);
    const r=await admin.query('update transactions set user_id=null where id=$1 returning user_id',[tMine]);await admin.query('rollback');
    eq(r.rowCount,1);eq(r.rows[0].user_id,null)});

  await db.migrate(MIGRATIONS.slice(-1));     // apply 008

  console.log('\nAccount deletion');
  await test('owner with other members cannot delete their account; non-owners cannot remove members / delete the household',async()=>{
    await throws(()=>as(O,"select delete_my_account('DELETE')"),/own a household that still has other members/);
    await throws(()=>as(M,'select remove_member($1,$2)',[H,D]),/only the household owner/);
    await throws(()=>as(M,"select delete_household($1,'Home')",[H]),/only the household owner/);
    await throws(()=>as(D,"select delete_my_account('nope')"),/confirmation text/);
    await throws(()=>as(null,"select delete_my_account('DELETE')"),/not signed in/)});
  await test('a client can never blank the creator of someone\'s entry',async()=>{
    await throws(()=>as(O,'update transactions set user_id=null where id=$1',[tMine]),/immutable transaction field/);
    await throws(()=>as(O,'update transactions set user_id=$2 where id=$1',[tMine,O]),/immutable transaction field/)});
  await test('member deletes own account: entries stay as "Deleted user", everyone else is untouched',async()=>{
    const before=await bals(O),n=(await admin.query('select count(*)::int n from transactions where household_id=$1',[H])).rows[0].n;
    await as(D,"select delete_my_account('DELETE')");
    eq((await admin.query('select count(*)::int n from auth.users where id=$1',[D])).rows[0].n,0);
    eq((await admin.query('select count(*)::int n from profiles where id=$1',[D])).rows[0].n,0);
    eq((await admin.query('select count(*)::int n from members where user_id=$1',[D])).rows[0].n,0);
    eq((await admin.query('select count(*)::int n from transactions where household_id=$1',[H])).rows[0].n,n,'no transaction lost:');
    eq((await admin.query('select user_id from transactions where id=any($1) order by 1',[[tTransfer,tDadExpense]])).rows.map(r=>r.user_id),[null,null]);
    eq(await bals(O),before,'balances unchanged:');
    eq((await admin.query('select role from members where household_id=$1 order by role',[H])).rows.map(r=>r.role),['member','owner']);
    eq((await admin.query('select name from profiles where id=any($1) order by name',[[O,M]])).rows.map(r=>r.name),['Member','Owner'])});
  await test('History / Daily query (profiles embed = LEFT JOIN) still returns deleted-user rows',async()=>{
    const r=(await as(M,'select t.id,p.name from transactions t left join profiles p on p.id=t.user_id where t.household_id=$1 and t.id=$2',[H,tDadExpense])).rows;
    eq(r.length,1);eq(r[0].name,null);
    eq((await as(M,'select count(*)::int n from transactions where household_id=$1 and user_id is null',[H])).rows[0].n,2)});
  await test('Statistics keep deleted-user spending and label it "Deleted user"',async()=>{
    const r=(await one(M,"select range_stats($1,(now() at time zone 'Africa/Cairo')::date,(now() at time zone 'Africa/Cairo')::date) s",[H])).s;
    eq(+r.expenses,195);const d=r.by_member.find(x=>x.name==='Deleted user');ok(d,'Deleted user row missing');eq(+d.total,150);
    ok(r.top.some(x=>x.pname==='Deleted user'&&x.category==='Fish'))});

  console.log('\nDelete');
  await test('non-owner cannot delete or edit a deleted user\'s entry (RLS unchanged: creator or owner only)',async()=>{
    eq((await as(M,'delete from transactions where id=$1 returning id',[tDadExpense])).rowCount,0);
    eq((await as(M,'update transactions set amount=1 where id=$1 returning id',[tDadExpense])).rowCount,0);
    eq((await as(M,'delete from transactions where id=$1 returning id',[tTransfer])).rowCount,0)});
  await test('owner can edit a deleted user\'s entry; it stays "Deleted user"',async()=>{
    const r=await as(O,"update transactions set note='fixed',amount=140 where id=$1 returning user_id,amount",[tDadExpense]);
    eq(r.rowCount,1);eq(r.rows[0].user_id,null);eq((await bals(O))['Personal cash'],20)});
  await test('FIXED: owner deletes the deleted user\'s transfer although the wallet cannot cover it (delete needs no funds)',async()=>{
    eq((await as(O,'delete from transactions where id=$1 returning id',[tTransfer])).rowCount,1);
    eq(await bals(O),{[C]:495,[B]:500,[P]:-180})});
  await test('...funds protection is NOT weakened: the negative wallet cannot be spent or transferred from, only topped up',async()=>{
    await throws(()=>add(M,'expense',1,P),/Insufficient funds/);await throws(()=>add(O,'transfer',1,P,C),/Insufficient funds/);
    await throws(()=>as(M,'update transactions set amount=11 where id=$1',[tMine]),/Insufficient funds/);
    await add(O,'transfer',200,C,P);eq((await bals(O))[P],20);await add(M,'expense',20,P);
    await throws(()=>add(M,'expense',0.01,P),/Insufficient funds/)});
  await test('delete normal transaction (own); cannot delete another member\'s; owner can',async()=>{
    eq((await as(M,'delete from transactions where id=$1 returning id',[tMine])).rowCount,1);
    const o=await add(O,'expense',3,C);
    eq((await as(M,'delete from transactions where id=$1 returning id',[o])).rowCount,0);
    const m=await add(M,'expense',3,C);eq((await as(O,'delete from transactions where id=$1 returning id',[m])).rowCount,1)});
  await test('deletes and edits are written to the audit log',async()=>{
    ok((await admin.query("select count(*)::int n from audit_log where tx_id=$1 and action='DELETE'",[tTransfer])).rows[0].n===1)});

  console.log('\nQuick purchases');
  await test('saving a Quick Purchase never creates a transaction, never duplicates, updates the price, is shared',async()=>{
    const n=(await admin.query('select count(*)::int n from transactions')).rows[0].n;
    await as(M,'select upsert_quick_item($1,$2,$3)',[H,'Tuna',30]);await as(O,'select upsert_quick_item($1,$2,$3)',[H,' tuna ',45]);
    const r=(await as(O,"select name,default_price from quick_items where household_id=$1 and lower(name)='tuna'",[H])).rows;
    eq(r.length,1);eq(+r[0].default_price,45);
    eq((await admin.query('select count(*)::int n from transactions')).rows[0].n,n)});

  console.log('\nOwnership / orphans');
  await test('account deleted from the Supabase dashboard also leaves entries as "Deleted user" (used to fail)',async()=>{
    const X=await user('Guest');await as(X,'select join_household($1)',[code]);const t=await add(X,'expense',2,C,null,'Gum');
    await admin.query('delete from auth.users where id=$1',[X]);
    eq((await admin.query('select user_id from transactions where id=$1',[t])).rows[0].user_id,null)});
  await test('removed member loses access, keeps account; entries stay',async()=>{
    const t=await add(M,'expense',2,C,null,'Pen');await as(O,'select remove_member($1,$2)',[H,M]);
    eq((await as(M,'select count(*)::int n from transactions where household_id=$1',[H])).rows[0].n,0);
    eq((await admin.query('select user_id from transactions where id=$1',[t])).rows[0].user_id,M);
    eq((await admin.query('select count(*)::int n from auth.users where id=$1',[M])).rows[0].n,1)});
  await test('sole owner deletes account: household is purged, nothing orphaned, other accounts intact',async()=>{
    await as(O,"select delete_my_account('DELETE')");
    for(const t of ['households','members','wallets','transactions','quick_items','audit_log'])
      eq((await admin.query(`select count(*)::int n from ${t} where household_id=$1`.replace('household_id',t==='households'?'id':'household_id'),[H])).rows[0].n,0,t+':');
    eq((await admin.query('select count(*)::int n from profiles where id=$1',[M])).rows[0].n,1)});
}catch(e){console.error(e);process.exitCode=1}
finally{done('database');await db.stop()}
