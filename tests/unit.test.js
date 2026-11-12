// Unit tests for core.js (accounting rules + offline queue + sync). No setup:  node tests/unit.test.js
const C=require('../core.js');
let pass=0,fail=0;
const eq=(a,b,m='')=>{const x=JSON.stringify(a),y=JSON.stringify(b);if(x!==y)throw new Error(`${m} expected ${y}, got ${x}`)};
const ok=(v,m='assertion failed')=>{if(!v)throw new Error(m)};
const tests=[];const test=(n,f)=>tests.push([n,f]);
const store=()=>{const m={};return{getItem:k=>k in m?m[k]:null,setItem:(k,v)=>{m[k]=String(v)},removeItem:k=>{delete m[k]},m}};
const W=[{id:'cash',balance:300},{id:'bank',balance:500},{id:'pers',balance:10}];
const ins=(type,amount,wallet_id,to_wallet_id=null,category=type)=>({client_id:'c'+Math.random(),household_id:'h',type,amount,wallet_id,to_wallet_id,category,created_at:new Date().toISOString()});
const env=(exec,o={})=>({online:()=>o.online!==false,sessionUid:o.sessionUid||(async()=>'u1'),exec});

test('wallet effects: expense -, income +, transfer/withdraw/deposit move money and never change the total',()=>{
  const q=[ins('expense',20,'cash'),ins('income',100,'bank'),ins('transfer',50,'cash','pers'),ins('withdraw',200,'bank','cash'),ins('deposit',30,'cash','bank')].map(o=>({...o,state:'pending'}));
  const b=C.balances(W,q,'cash');eq(b.wallets,{cash:400,bank:430,pers:60});eq(b.total,890);eq(C.sign('transfer'),0);eq(C.sign('withdraw'),0)});
test('transfers are not counted twice and not as spending',()=>{
  const q=[{...ins('transfer',50,'cash','pers'),state:'pending'}];eq(C.balances(W,q,'cash').total,810);eq(C.spendDeltas(q,Date.now()),{today:0,week:0,month:0})});
test('pending delete reverses the entry; pending edit replaces it; failed/conflict ops do not affect balances',()=>{
  const old={type:'expense',amount:20,wallet_id:'cash',created_at:new Date().toISOString()};
  eq(C.balances(W,[{op:'del',old,state:'pending'}],'cash').wallets.cash,320);
  eq(C.balances(W,[{op:'upd',old,patch:{amount:50,wallet_id:'pers'},state:'pending'}],'cash').wallets,{cash:320,bank:500,pers:-40});
  eq(C.balances(W,[{op:'del',old,state:'failed'},{op:'del',old,state:'conflict'}],'cash').wallets.cash,300);
  eq(C.spendDeltas([{op:'del',old,state:'pending'}],Date.now()).today,-20)});
test('deleting a transfer INTO a wallet shows the resulting negative balance (used for the confirm text)',()=>{
  const t={type:'transfer',amount:200,wallet_id:'cash',to_wallet_id:'pers'};eq(C.balances(W,[{op:'del',old:t,state:'pending'}],'cash').wallets,{cash:500,bank:500,pers:-190})});
test('quick-purchase ops are never money',()=>{const q=[{op:'qi',name:'Tuna',price:30,state:'pending'}];eq(C.balances(W,q,'cash').total,810);eq(C.spendDeltas(q,Date.now()).month,0)});
test('cents: no floating point drift',()=>{const q=[0.1,0.2,0.7].map(a=>({...ins('expense',a,'cash'),state:'pending'}));eq(C.balances(W,q,'cash').wallets.cash,299)});
test('Cairo day boundaries',()=>{eq(C.cairoYmd('2026-01-15T21:59:59Z'),'2026-01-15');eq(C.cairoYmd('2026-01-15T22:00:00Z'),'2026-01-16');eq(C.cairoStart('2026-01-16'),'2026-01-15T22:00:00.000Z');
  eq(C.cairoStart('2026-07-10'),'2026-07-09T21:00:00.000Z');eq(C.periods(new Date('2026-11-12T10:00:00Z')),{today:'2026-11-12',week:'2026-11-09',month:'2026-11-01'});eq(C.addDays('2026-03-01',-1),'2026-02-28')});
test('numbers typed with Arabic / Persian digits and separators',()=>{eq(C.num('١٢٫٥'),12.5);eq(C.num('۱۲۳'),123);eq(C.num('1,234.50'),1234.5);eq(C.num('12,5'),12.5);ok(Number.isNaN(C.num('abc')))});
test('automatic quick-purchase icons always return something',()=>{eq(C.qicon('Bread'),'🍞');eq(C.qicon('عيش بلدي'),'🍞');eq(C.qicon('Fish'),'🐟');eq(C.qicon('zzz'),'🛒');eq(C.qicon(null),'🛒')});
test('error classification',()=>{eq(C.classify(null),'ok');eq(C.classify({code:'23505'}),'duplicate');
  eq(C.classify({message:'Insufficient funds. Available balance in Personal cash: 10.00 EGP.',code:'P0001'},400),'permanent');
  eq(C.classify({message:'TypeError: Failed to fetch'},0),'network');eq(C.classify({message:'x'},503),'network');eq(C.classify({message:'JWT expired',code:'PGRST301'},401),'auth');
  eq(C.classify({message:'new row violates row-level security policy',code:'42501'},403),'permanent')});
test('queue is per user and durable; another account never sees or syncs it',async()=>{
  const s=store(),a=C.Queue(s,'u1'),b=C.Queue(s,'u2');a.push(ins('expense',5,'cash'));eq(a.all().length,1);eq(b.all().length,0);
  eq(C.foreign(s,'u2'),[{uid:'u1',count:1}]);eq(C.foreign(s,'u1'),[]);
  let ran=0;const r=await C.sync(a,'u1',env(async()=>{ran++;return{}},{sessionUid:async()=>'u2'}));eq(r.stopped,'auth');eq(ran,0);eq(a.all().length,1);
  try{C.Queue(s,null);ok(false)}catch(e){ok(/user id/.test(e.message))}});
test('sync: success removes the op; a duplicate (already saved by an earlier attempt) counts as synced, never re-sent',async()=>{
  const q=C.Queue(store(),'u1');q.push(ins('expense',5,'cash'));q.push(ins('expense',6,'cash'));let n=0;
  const r=await C.sync(q,'u1',env(async()=>(++n===1?{}:{error:{code:'23505',message:'duplicate key'}})));eq([r.synced,r.failed],[2,0]);eq(q.all().length,0);
  const r2=await C.sync(q,'u1',env(async()=>{n++;return{}}));eq(r2.synced,0);eq(n,2)});
test('sync: network error keeps everything pending in order and stops (retried later, nothing dropped)',async()=>{
  const q=C.Queue(store(),'u1');q.push(ins('expense',5,'cash'));q.push(ins('expense',6,'cash'));let n=0;
  const r=await C.sync(q,'u1',env(async()=>{n++;return{error:{message:'Failed to fetch'},status:0}}));eq(r.stopped,'network');eq(n,1);eq(q.all().map(o=>[o.state,o.tries]),[['pending',1],['pending',0]]);eq(r.errors,[])});
test('sync: offline -> nothing is attempted',async()=>{const q=C.Queue(store(),'u1');q.push(ins('expense',5,'cash'));let n=0;const r=await C.sync(q,'u1',env(async()=>{n++;return{}},{online:false}));eq(r.stopped,'network');eq(n,0)});
test('sync: a session lookup that FAILS (network) is not "signed out"; a missing session is',async()=>{
  const q=C.Queue(store(),'u1');q.push(ins('expense',5,'cash'));
  eq((await C.sync(q,'u1',env(async()=>({}),{sessionUid:async()=>{throw new Error('Failed to fetch')}}))).stopped,'network');
  eq((await C.sync(q,'u1',env(async()=>({}),{sessionUid:async()=>null}))).stopped,'auth');eq(q.all()[0].state,'pending')});
test('ERROR ATTRIBUTION: a failing expense queued next to a delete is reported as the EXPENSE; the delete succeeds',async()=>{
  const q=C.Queue(store(),'u1');q.push(ins('expense',50,'pers',null,'Shoes'));q.push({op:'del',id:'t1',old:{type:'transfer',amount:200,category:'Transfer',wallet_id:'cash',to_wallet_id:'pers'}});
  const seen=[];const r=await C.sync(q,'u1',env(async o=>{seen.push(C.opKind(o));return o.op==='del'?{}:{error:{message:'Insufficient funds. Available balance in Personal cash: 10.00 EGP.',code:'P0001'},status:400}}));
  eq(seen,['expense','del']);eq([r.synced,r.failed],[1,1]);eq(r.errors.length,1);
  eq([r.errors[0].kind,r.errors[0].name,r.errors[0].amount],['expense','Shoes',50]);ok(/Insufficient funds/.test(r.errors[0].message));
  eq(q.all().map(o=>[C.opKind(o),o.state]),[['expense','failed']]);
  const again=await C.sync(q,'u1',env(async()=>{throw new Error('must not be retried automatically')}));eq([again.synced,again.failed],[0,0])});
test('ERROR ATTRIBUTION: every kind of operation is named',async()=>{
  const q=C.Queue(store(),'u1');const old={type:'expense',amount:20,category:'Bread',wallet_id:'cash'};
  q.push(ins('transfer',5,'cash','pers','Transfer'));q.push(ins('withdraw',5,'bank','cash','Withdraw cash'));q.push(ins('income',5,'bank','','Add income'));
  q.push({op:'upd',id:'t',base:'x',old,patch:{amount:99}});q.push({op:'del',id:'t2',old});q.push({op:'qi',name:'Tuna',price:30});
  const r=await C.sync(q,'u1',env(async()=>({error:{message:'boom',code:'P0001'},status:400})));
  eq(r.errors.map(e=>e.kind),['transfer','withdraw','income','upd','del','qi']);eq(r.errors[3].amount,99);eq(r.errors[4].name,'Bread');eq(r.errors[5].name,'Tuna');ok(r.errors.every(e=>e.qid&&e.message==='boom'))});
test('edit conflict / refused delete: marked "conflict" with the reason and attributed, not applied, not retried',async()=>{
  const q=C.Queue(store(),'u1');const old={type:'expense',amount:20,category:'Bread',wallet_id:'cash'};q.push({op:'upd',id:'t',base:'v1',old,patch:{amount:30}});q.push({op:'del',id:'t9',old});
  const r=await C.sync(q,'u1',env(async o=>({conflict:true,message:o.op==='del'?'You are not allowed to delete this entry.':'changed elsewhere'})));
  eq(r.conflict,2);eq(r.conflicts.map(c=>[c.kind,c.message]),[['upd','changed elsewhere'],['del','You are not allowed to delete this entry.']]);eq(q.all().map(o=>o.state),['conflict','conflict']);
  eq(C.balances(W,q.all(),'cash').wallets.cash,300)});
test('two offline edits of one entry: the second is rebased on the first one\'s new version',async()=>{
  const q=C.Queue(store(),'u1');const old={type:'expense',amount:20,wallet_id:'cash'};q.push({op:'upd',id:'t',base:'v1',old,patch:{amount:30}});q.push({op:'upd',id:'t',base:'v1',old,patch:{amount:40}});
  const bases=[];await C.sync(q,'u1',env(async o=>{bases.push(o.base);return{updated_at:'v'+(bases.length+1)}}));eq(bases,['v1','v2'])});
test('dependent quick-purchase waits for its expense and is discarded together with it',async()=>{
  const q=C.Queue(store(),'u1');const e=ins('expense',50,'pers');q.push(e);q.push({op:'qi',dep:e.client_id,name:'Shoes',price:50});const seen=[];
  await C.sync(q,'u1',env(async o=>{seen.push(C.opKind(o));return{error:{message:'Insufficient funds',code:'P0001'},status:400}}));eq(seen,['expense']);
  q.discard(e.client_id);eq(q.all().length,0)});
(async()=>{for(const [n,f] of tests){try{await f();pass++;console.log('  ok   '+n)}catch(e){fail++;console.log('  FAIL '+n+'\n       '+e.message)}}
  console.log(`\nunit: ${pass} passed, ${fail} failed`);if(fail)process.exitCode=1})();
