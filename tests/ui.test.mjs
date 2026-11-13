// UI / startup / offline tests in a real (headless) Chromium. The app files are served unchanged from the repository;
// only supabase.min.js is replaced by tests/mock-supabase.js (a fake backend whose latency and failures we control).
//   node tests/ui.test.mjs            (screenshots are written to tests/screenshots/)
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import zlib from 'node:zlib';
import {execFileSync,execSync} from 'node:child_process';
import {test,eq,ok,done,ROOT} from './harness.mjs';
import chromium from '@sparticuz/chromium';import puppeteer from 'puppeteer-core';
const SHOTS=path.join(ROOT,'tests','screenshots');fs.mkdirSync(SHOTS,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- static server ---------- */
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.png':'image/png'};
const srv={noSW:true,dead:false};let OLD='';try{OLD=execSync('git show 7cdc7d7:index.html',{cwd:ROOT,maxBuffer:1e8}).toString()}catch(e){}
const server=http.createServer((q,r)=>{if(srv.dead)return q.socket.destroy();
  let u=decodeURIComponent(q.url.split('?')[0]);if(u==='/')u='/index.html';
  if(u==='/old.html'&&OLD){r.writeHead(200,{'content-type':TYPES['.html']});return r.end(OLD)}                      // the version before this change, for layout comparison
  if(u==='/sw.js'&&srv.noSW){r.writeHead(404);return r.end()}
  const f=u==='/supabase.min.js'?path.join(ROOT,'tests','mock-supabase.js'):path.join(ROOT,u);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end('not found')}
  r.writeHead(200,{'content-type':TYPES[path.extname(f)]||'application/octet-stream','cache-control':'no-store'});r.end(fs.readFileSync(f))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const BASE=`http://localhost:${server.address().port}/`;

/* ---------- browser (bundled Chromium + the shared libraries it needs) ---------- */
const libs=path.join(os.tmpdir(),'ht-chromium-libs');
if(!fs.existsSync(path.join(libs,'lib'))){fs.mkdirSync(libs,{recursive:true});const tar=path.join(libs,'l.tar');
  fs.writeFileSync(tar,zlib.brotliDecompressSync(fs.readFileSync(path.join(ROOT,'node_modules','@sparticuz','chromium','bin','al2023.tar.br'))));execFileSync('tar',['-xf',tar,'-C',libs])}
const browser=await puppeteer.launch({args:[...chromium.args.filter(a=>!/single-process|no-zygote/.test(a)),'--font-render-hinting=none'],executablePath:await chromium.executablePath(),headless:'shell',
  env:{...process.env,LD_LIBRARY_PATH:[path.join(libs,'lib'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});

/* ---------- fake database ---------- */
const O='00000000-0000-4000-8000-00000000000a',M='00000000-0000-4000-8000-00000000000b',H='00000000-0000-4000-8000-0000000000aa';
const WC='00000000-0000-4000-8000-0000000000c1',WB='00000000-0000-4000-8000-0000000000c2',WP='00000000-0000-4000-8000-0000000000c3';
let n=0;const tx=(user_id,type,amount,wallet_id,to_wallet_id,category,min)=>{n++;const at=new Date(Date.now()-min*60000).toISOString();return{id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,client_id:'c'+n,household_id:H,user_id,type,amount,wallet_id,to_wallet_id:to_wallet_id||null,category,note:'',created_at:at,updated_at:at}};
const seed=()=>{n=0;return{users:[{id:O,email:'owner@t.io',password:'secret1',name:'Omar'},{id:M,email:'mona@t.io',password:'secret1',name:'Mona'}],
  households:[{id:H,name:'Home',invite_code:'abcd1234'}],members:[{household_id:H,user_id:O,role:'owner'},{household_id:H,user_id:M,role:'member'}],
  wallets:[{id:WC,household_id:H,name:'Household cash',is_default:true},{id:WB,household_id:H,name:'Bank account'},{id:WP,household_id:H,name:'Personal cash'}],
  quick_items:['Bread:20','Chicken:180','Fish:250','Milk:50','Rice:40','Vegetables:60'].map((x,i)=>({id:'q'+i,household_id:H,name:x.split(':')[0],default_price:+x.split(':')[1],key:x.split(':')[0].toLowerCase(),icon:null})),
  transactions:[tx(O,'income',1000,WB,null,'Add income',600),tx(O,'withdraw',500,WB,WC,'Withdraw cash',500),
    tx(null,'transfer',200,WC,WP,'Transfer',400),      // made by an account that was deleted later  -> id ...003
    tx(null,'expense',190,WP,null,'Fish',300),         // deleted user's purchase: Personal cash is now 10 -> id ...004
    tx(M,'expense',20,WC,null,'Bread',200),tx(O,'expense',60,WC,null,'Vegetables',100)]}};      // Mona's -> ...005, Omar's -> ...006
const T_TRANSFER='00000000-0000-4000-8000-000000000003',T_BREAD='00000000-0000-4000-8000-000000000005',T_VEG='00000000-0000-4000-8000-000000000006';
const session=uid=>JSON.stringify({access_token:'tok',refresh_token:'r',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid}});
const VP={iphone:{width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true},android:{width:360,height:800,deviceScaleFactor:2,isMobile:true,hasTouch:true},ipadl:{width:1180,height:820,deviceScaleFactor:1,isMobile:true,hasTouch:true},ipad:{width:820,height:1180,deviceScaleFactor:1,isMobile:true,hasTouch:true}};

async function open({uid=null,lang='en',vp='iphone',cfg={},url='',inset=0,standalone=false,offline=false}={}){
  const ctx=await browser.createBrowserContext(),page=await ctx.newPage();await page.setViewport(VP[vp]);
  const dialogs=[];page.on('dialog',async d=>{dialogs.push(d.message());await (d.type()==='prompt'?d.accept(d.defaultValue()):d.accept())});
  const errors=[];page.on('pageerror',e=>errors.push(String(e&&e.message||e)));page.on('console',m=>{if(m.type()==='error'&&!/404|Failed to load resource|ERR_/.test(m.text()))errors.push('console: '+m.text())});
  await page.evaluateOnNewDocument((s,uid,lang,cfg,sess,offline)=>{
    Object.defineProperty(Navigator.prototype,'onLine',{configurable:true,get:()=>localStorage.getItem('__offline')!=='1'});
    if(localStorage.getItem('__seeded'))return;localStorage.setItem('__seeded','1');localStorage.setItem('mock_db',s);localStorage.setItem('mock_cfg',JSON.stringify(cfg));
    if(lang!=='en')localStorage.setItem('ht_lang',lang);if(offline)localStorage.setItem('__offline','1');
    if(uid){localStorage.setItem('ht-auth',sess);localStorage.setItem('ht_last_uid',uid)}
  },JSON.stringify(seed()),uid,lang,cfg,uid?session(uid):'',offline);
  if(inset){const c=await page.createCDPSession();await c.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:47,bottom:inset}})}
  
  const api={page,ctx,dialogs,errors,
    go:async(u=url)=>{await page.goto(BASE+u,{waitUntil:'domcontentloaded'})},
    text:sel=>page.$eval(sel,e=>e.textContent.replace(/\u00a0/g,' ').trim()).catch(()=>null),
    has:sel=>page.$(sel).then(x=>!!x),
    wait:(fn,arg,timeout=6000,...more)=>page.waitForFunction(fn,{timeout,polling:20},arg,...more),
    dash:(timeout=6000)=>page.waitForFunction(()=>{const b=document.querySelector('#bal');return b&&/[\d٠-٩]/.test(b.textContent)},{timeout,polling:10}),
    status:(re,timeout=6000)=>page.waitForFunction(s=>{const e=document.querySelector('#ns');return e&&new RegExp(s).test(e.textContent)},{timeout,polling:20},re.source),
    cfg:c=>page.evaluate(c=>{Object.assign(window.__cfg,c);localStorage.setItem('mock_cfg',JSON.stringify(window.__cfg))},c),
    db:()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mock_db'))),
    setDb:fn=>page.evaluate(src=>{const d=JSON.parse(localStorage.getItem('mock_db'));(0,eval)('('+src+')')(d);localStorage.setItem('mock_db',JSON.stringify(d))},fn.toString()),
    net:on=>page.evaluate(on=>{on?localStorage.removeItem('__offline'):localStorage.setItem('__offline','1');dispatchEvent(new Event(on?'online':'offline'))},on),
    toast:()=>page.evaluate(()=>{const t=document.querySelector('#toast');return t&&t.classList.contains('on')?t.textContent:''}),
    queue:uid=>page.evaluate(u=>JSON.parse(localStorage.getItem('ht_q:'+u)||'[]'),uid),
    shot:name=>page.screenshot({path:path.join(SHOTS,name+'.png')}),
    close:()=>ctx.close()};
  return api}
const addExpense=async(p,amount,what,wallet)=>{await p.page.click('[data-t="expense"]');await p.wait(()=>document.querySelector('#sh').classList.contains('on'));
  await p.page.$eval('#amt',(e,v)=>e.value=v,String(amount));await p.page.$eval('#nt',(e,v)=>e.value=v,what);if(wallet)await p.page.select('#wl',wallet);await p.page.click('#sv')};
const noErr=p=>eq(p.errors,[],'page errors:');

try{
console.log('\nStartup');
await test('first-ever launch / logged out: login form appears immediately, without a network round trip',async()=>{
  const p=await open({cfg:{latency:3000}});const t=Date.now();await p.go();await p.wait(()=>!!document.querySelector('#em'),null,1500);
  ok(Date.now()-t<1500);ok(!(await p.has('#bal')));eq((await p.page.evaluate(()=>window.__calls.filter(c=>!c.name.startsWith('auth.')).length)),0,'no data request for a logged-out visitor:');noErr(p);await p.close()});
let warm;
await test('fresh login: shell + skeleton while the household loads, then the dashboard with server data',async()=>{
  warm=await open({cfg:{latency:700}});const p=warm;await p.go();await p.wait(()=>!!document.querySelector('#em'));
  await p.page.type('#em','owner@t.io');await p.page.type('#pw','secret1');await p.page.click('#go');
  await p.wait(()=>!!document.querySelector('#bootsk')&&!document.querySelector('#bootsk').hidden&&!document.querySelector('#em'),null,3000);   // not the old blank "Loading…"
  await p.dash();await p.status(/Online/);eq(await p.text('#bal'),'EGP 730.00');
  ok(JSON.parse(await p.page.evaluate(()=>localStorage.getItem('ht_c'))).uid===O,'cache is stamped with its owner');noErr(p)});
await test('wrong password shows the error and stays on the login form',async()=>{
  const p=await open();await p.go();await p.wait(()=>!!document.querySelector('#em'));await p.page.type('#em','owner@t.io');await p.page.type('#pw','nope');await p.page.click('#go');
  await p.wait(()=>/Invalid login/.test(document.querySelector('#er').textContent));ok(!(await p.page.$eval('#go',e=>e.disabled)));await p.close()});
await test('fast cached startup on a SLOW network: cached dashboard at once, "Updating…" indicator, then fresh data replaces it',async()=>{
  const p=warm;await p.cfg({latency:2500,authDelay:2500});
  await p.setDb(d=>{const t=d.transactions.find(x=>x.category==='Vegetables');t.amount=160});      // the server changed while the app was closed
  const t=Date.now();await p.page.reload({waitUntil:'domcontentloaded'});await p.dash(1500);const ms=Date.now()-t;
  eq(await p.text('#bal'),'EGP 730.00','cached value first:');ok(ms<1000,`dashboard took ${ms} ms`);
  eq(await p.text('#ns'),'Updating…');ok(!(await p.page.evaluate(()=>document.body.innerText.includes('Loading…'))),'no full-screen Loading…');
  ok(await p.has('#nv')&&await p.has('.qc')&&await p.has('.tx'),'cached wallets / quick purchases / recent are on screen');
  console.log(`       (cached dashboard painted ${ms} ms after navigation start; backend latency 2500 ms + session check 2500 ms)`);
  await p.wait(()=>document.querySelector('#bal').textContent.replace(/\u00a0/g,' ').trim()==='EGP 630.00',null,9000);await p.status(/Online/);noErr(p);await p.close()});
await test('offline startup with an EXPIRED access token: cached dashboard (not the login screen); entry is queued, then synced once on reconnect',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);
  await p.cfg({auth:'netfail',down:true});await p.net(false);await p.page.reload({waitUntil:'domcontentloaded'});
  await p.dash(1500);await p.status(/Offline/);ok(!(await p.has('#em')),'must not be thrown to the login screen');eq(await p.text('#bal'),'EGP 730.00');
  await addExpense(p,15,'Tea');await p.status(/Offline · 1 waiting/);eq(await p.text('#bal'),'EGP 715.00');ok((await p.text('#tl')).includes('waiting to sync'));
  await p.cfg({auth:'ok',down:false});await p.net(true);await p.status(/Online/);
  const d=await p.db();eq(d.transactions.filter(x=>x.category==='Tea').length,1);eq((await p.queue(M)).length,0);
  await p.net(false);await p.net(true);await sleep(300);eq((await p.db()).transactions.filter(x=>x.category==='Tea').length,1,'no duplicate after another reconnect:');noErr(p);await p.close()});
await test('expired session (refresh token rejected): login screen with a clear message; the unsynced queue is kept',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);
  await p.net(false);await addExpense(p,5,'Gum');await p.status(/1 waiting/);
  await p.cfg({auth:'rejected'});await p.page.evaluate(()=>localStorage.removeItem('__offline'));await p.page.reload({waitUntil:'domcontentloaded'});
  await p.wait(()=>!!document.querySelector('#em'));ok(/session expired/i.test(await p.text('#er')),'msg: '+await p.text('#er'));ok(!(await p.has('#bal')),'dash gone');
  eq((await p.queue(M)).length,1);eq((await p.db()).transactions.filter(x=>x.category==='Gum').length,0);
  await p.cfg({auth:'ok'});await p.page.type('#em','mona@t.io');await p.page.type('#pw','secret1');await p.page.click('#go');   // logging back in syncs it
  await p.dash();await p.wait(()=>JSON.parse(localStorage.getItem('mock_db')).transactions.some(x=>x.category==='Gum'));eq((await p.queue(M)).length,0);noErr(p);await p.close()});
await test('Supabase unavailable (device online): cached dashboard + visible "couldn\'t refresh" notice with the real error, retry works',async()=>{
  const p=await open({uid:O});await p.go();await p.dash();await p.status(/Online/);
  await p.cfg({down:true,auth:'netfail'});await p.page.reload({waitUntil:'domcontentloaded'});await p.dash(1500);
  await p.wait(()=>{const b=document.querySelector('#syb');return b&&!b.hidden&&/Couldn't refresh/.test(b.textContent)&&/Failed to fetch/.test(b.textContent)});eq(await p.text('#ns'),'Saved data');
  await p.cfg({down:false,auth:'ok'});await p.page.click('#syb [data-act="reload"]');await p.status(/Online/);ok(await p.page.$eval('#syb',e=>e.hidden));noErr(p);await p.close()});
await test('Supabase unavailable with a session but NO cache: "Can\'t reach the server" + Try again (no fake dashboard)',async()=>{
  const p=await open({uid:O,cfg:{down:true}});await p.go();await p.wait(()=>/Can't reach the server/.test(document.body.innerText));ok(!(await p.has('#bal')));
  await p.cfg({down:false});await p.page.click('#rt');await p.dash();noErr(p);await p.close()});
await test('session check hangs forever: the cached dashboard stays usable',async()=>{
  const p=await open({uid:O});await p.go();await p.dash();await p.status(/Online/);await p.cfg({auth:'hang',hang:true});
  await p.page.reload({waitUntil:'domcontentloaded'});await p.dash(1500);await p.page.click('[data-t="expense"]');await p.wait(()=>document.querySelector('#sh').classList.contains('on'));noErr(p);await p.close()});
await test('account switch on one device: the next user never sees the previous user\'s cached data or queue',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);await p.net(false);await addExpense(p,7,'Private');await p.status(/1 waiting/);
  await p.page.click('#gear');await p.page.click('#lo');await p.wait(()=>!!document.querySelector('#em'));          // offline logout must really log out
  eq(await p.page.evaluate(()=>localStorage.getItem('ht-auth')),null);eq(await p.page.evaluate(()=>localStorage.getItem('ht_c')),null);
  await p.setDb(d=>{d.users.push({id:'u-new',email:'new@t.io',password:'secret1',name:'New'})});await p.net(true);
  await p.page.type('#em','new@t.io');await p.page.type('#pw','secret1');await p.page.click('#go');
  await p.wait(()=>/Your household/.test(document.body.innerText));ok(!(await p.page.evaluate(()=>document.body.innerText.includes('Private'))));
  eq((await p.queue(M)).length,1,"Mona's entry is still waiting for Mona:");eq((await p.db()).transactions.filter(x=>x.category==='Private').length,0);noErr(p);await p.close()});

console.log('\nDelete + error attribution');
await test('owner deletes a DELETED USER\'s transfer that the wallet cannot cover: succeeds, no "insufficient funds"',async()=>{
  const p=await open({uid:O});await p.go();await p.dash();await p.status(/Online/);await p.page.click('#va');await p.wait(()=>document.querySelectorAll('#hl .tx').length>=6);
  await p.page.click(`#hl [data-d="${T_TRANSFER}"]`);await p.wait(id=>!JSON.parse(localStorage.getItem('mock_db')).transactions.some(t=>t.id===id),T_TRANSFER);
  ok(/Delete this transaction\?/.test(p.dialogs[0])&&/negative balance/.test(p.dialogs[0])&&/Personal cash/.test(p.dialogs[0]),'confirm explains the consequence: '+p.dialogs[0]);
  await p.status(/Online/);eq(await p.toast(),'');eq((await p.queue(O)).length,0);
  await p.page.click('[data-n="home"]');await p.wait(()=>[...document.querySelectorAll('#wb .wc')].some(c=>/Personal cash/.test(c.textContent)&&/-|−/.test(c.textContent)&&c.querySelector('b.neg')));noErr(p);await p.close()});
await test('non-owner: deleted-user rows are labelled "Deleted user" and offer no edit/delete; own rows do',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);await p.page.click('#va');await p.wait(()=>document.querySelectorAll('#hl .tx').length>=6);
  const r=await p.page.evaluate(()=>[...document.querySelectorAll('#hl .tx')].map(e=>({t:e.textContent,d:!!e.querySelector('[data-d]'),e:!!e.querySelector('[data-e]')})));
  const del=r.filter(x=>x.t.includes('Deleted user'));eq(del.length,2);ok(del.every(x=>!x.d&&!x.e));
  ok(r.find(x=>x.t.includes('Bread')).d,'own entry is deletable');ok(!r.find(x=>x.t.includes('Vegetables')).d,"owner's entry is not");
  await p.page.select('#fm','~deleted');await p.wait(()=>document.querySelectorAll('#hl .tx').length===2);noErr(p);await p.close()});
await test('server refuses a delete (stale role): reported as "Delete sync failed … not allowed", never as a funds error',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);
  await p.page.evaluate(()=>{role='owner';paint()});                                             // device believes it may delete; the server decides
  await p.page.click(`#tl [data-d="${T_VEG}"]`);await p.wait(()=>document.querySelector('#toast')&&document.querySelector('#toast').classList.contains('on'));
  const t=await p.toast();ok(/^Delete sync failed \(Vegetables · EGP\s60\.00\): You are not allowed to delete this entry\./.test(t),t);ok((await p.db()).transactions.some(x=>x.id===T_VEG));
  await p.wait(id=>!!document.querySelector(`#tl .tx [data-e="${id}"]`)||[...document.querySelectorAll('#tl .tx')].some(e=>e.textContent.includes('Vegetables')),T_VEG);noErr(p);await p.close()});
await test('delete while offline -> queued; delete after reconnect -> applied once',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);await p.net(false);
  await p.page.click(`#tl [data-d="${T_BREAD}"]`);await p.status(/Offline · 1 waiting/);eq(await p.text('#bal'),'EGP 750.00');ok((await p.db()).transactions.some(x=>x.id===T_BREAD));
  await p.net(true);await p.status(/Online/);ok(!(await p.db()).transactions.some(x=>x.id===T_BREAD));eq(await p.toast(),'');eq(await p.text('#bal'),'EGP 750.00');noErr(p);await p.close()});
await test('delete queued together with an expense that fails: the error is attributed to the EXPENSE, the delete succeeds',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);await p.net(false);
  await addExpense(p,50,'Shoes',WP);                                                              // Personal cash has 10: offline "save anyway"
  ok(p.dialogs.some(d=>/Insufficient funds/.test(d)),'offline warning shown');await p.status(/1 waiting/);
  await p.page.click(`#tl [data-d="${T_BREAD}"]`);await p.status(/2 waiting/);
  await p.net(true);await p.wait(()=>document.querySelector('#toast')&&document.querySelector('#toast').classList.contains('on'));
  const t=await p.toast();ok(/^Expense sync failed \(Shoes · EGP\s50\.00\): Insufficient funds\. Available balance in Personal cash: 10\.00 EGP\./.test(t),'toast: '+t);
  ok(!/Delete/.test(t)&&!/Could not save/.test(t));ok(await p.page.$eval('#toast',e=>e.classList.contains('bad')));
  const d=await p.db();ok(!d.transactions.some(x=>x.id===T_BREAD),'delete was applied');ok(!d.transactions.some(x=>x.category==='Shoes'));
  const q=await p.queue(M);eq(q.map(o=>[o.state,o.category]),[['failed','Shoes']]);
  await p.page.click('#syb [data-act="sync"]');await p.wait(()=>/Needs attention/.test(document.querySelector('#more').textContent));
  const s=await p.text('#more');ok(/Expense · Shoes/.test(s)&&/Expense sync failed: Insufficient funds/.test(s),s);noErr(p);await p.close()});
await test('"Add to Quick Purchases only" never creates a transaction',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);const n0=(await p.db()).transactions.length;
  await p.page.click('[data-t="expense"]');await p.wait(()=>document.querySelector('#sh').classList.contains('on'));await p.page.$eval('#nt',e=>e.value='Tuna');
  await p.page.click('#qa');await p.page.$eval('#qp',e=>e.value='35');await p.page.click('#qo');
  await p.wait(()=>JSON.parse(localStorage.getItem('mock_db')).quick_items.some(q=>q.name==='Tuna'&&q.default_price===35));await p.status(/Online/);
  eq((await p.db()).transactions.length,n0);ok((await p.text('#qi')).includes('Tuna'));noErr(p);await p.close()});

console.log('\nDeleted-user consistency + views');
await test('Home, History, Daily and Stats all keep deleted-user entries and call them "Deleted user"',async()=>{
  const p=await open({uid:O});await p.go();await p.dash();await p.status(/Online/);
  await p.page.click('#va');await p.wait(()=>(document.querySelector('#hl')||{textContent:''}).textContent.split('Deleted user').length===3);
  await p.page.click('[data-n="daily"]');await p.wait(()=>/By person/.test(document.querySelector('#more').textContent)&&/Deleted user/.test(document.querySelector('#more').textContent));
  const d0=await p.page.$eval('#dp',e=>e.value);await p.page.click('#dpv');await p.wait(v=>document.querySelector('#dp')&&document.querySelector('#dp').value<v,d0);   // "previous day" really works
  await p.page.click('[data-n="stats"]');await p.wait(()=>/Biggest purchases/.test(document.querySelector('#more').textContent)&&/Deleted user/.test(document.querySelector('#more').textContent));noErr(p);await p.close()});
await test('delete account: back to login, token + cache + queue removed from the device; household history keeps the entries',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);await p.page.click('#gear');await p.page.click('#ac');
  await p.page.type('#dc','DELETE');await p.page.click('#dd');await p.wait(()=>!!document.querySelector('#em'));ok(/account was deleted/i.test(await p.text('#er')));
  eq(await p.page.evaluate(()=>[localStorage.getItem('ht-auth'),localStorage.getItem('ht_c'),localStorage.getItem('ht_hh')]),[null,null,null]);
  const d=await p.db();ok(!d.users.some(u=>u.id===M));eq(d.transactions.find(t=>t.id===T_BREAD).user_id,null);eq(d.members.length,1);noErr(p);await p.close();
  const o=await open({uid:O});await o.setDb&&0;await o.go();await o.page.evaluate(id=>{const d=JSON.parse(localStorage.getItem('mock_db'));d.users=d.users.filter(u=>u.id!==id);d.members=d.members.filter(m=>m.user_id!==id);d.transactions.forEach(t=>{if(t.user_id===id)t.user_id=null});localStorage.setItem('mock_db',JSON.stringify(d))},M);
  await o.page.reload({waitUntil:'domcontentloaded'});await o.dash();await o.wait(()=>[...document.querySelectorAll('#tl .tx')].some(e=>/Bread/.test(e.textContent)&&/Deleted user/.test(e.textContent)&&e.querySelector('[data-d]')));await o.close()});
await test('owner who still has members is told why the account cannot be deleted (stays logged in)',async()=>{
  const p=await open({uid:O});await p.go();await p.dash();await p.status(/Online/);await p.page.click('#gear');await p.page.click('#ac');await p.page.type('#dc','DELETE');await p.page.click('#dd');
  await p.wait(()=>/still has other members/.test(document.querySelector('#de').textContent));ok(await p.page.evaluate(()=>!!localStorage.getItem('ht-auth')));await p.close()});

console.log('\nQuick Purchases: names, languages, icons');
const cards=p=>p.page.evaluate(()=>[...document.querySelectorAll('#qi .qc:not(.add)')].map(c=>({icon:c.querySelector('.qe').textContent.trim(),name:c.querySelector('b').textContent,price:c.querySelector('small').textContent.replace(/\u00a0/g,' ')})));
const sheetOn=p=>p.wait(()=>document.querySelector('#sh').classList.contains('on'));
const addQuickOnly=async(p,name,price,icon)=>{await p.page.click('[data-t="expense"]');await sheetOn(p);await p.page.$eval('#nt',(e,v)=>{e.value=v;e.dispatchEvent(new Event('input'))},name);
  await p.page.click('#qa');await p.page.$eval('#qp',(e,v)=>e.value=v,String(price));if(icon)await p.page.click(`#qic [data-e="${icon}"]`);await p.page.click('#qo');
  await p.wait((n,pr)=>JSON.parse(localStorage.getItem('mock_db')).quick_items.some(q=>q.name.toLowerCase()===n.toLowerCase()&&q.default_price===+pr),name,6000,price);await p.status(/Online|متصل/)};
const lang=async(p,to)=>{await p.page.evaluate(l=>localStorage.setItem('ht_lang',l),to);await p.page.reload({waitUntil:'domcontentloaded'});await p.dash();await p.wait(()=>document.querySelectorAll('#qi .qc:not(.add)').length>0)};
const CUSTOM_EN=['Bread basket','Fish food','Milk Chocolate (Mona)','Rice & Vegetables mix','Transfer fee','Kiri'],CUSTOM_AR=['عيش فينو','شاي العروسة','حاجات البيت'];
await test('custom item created in English keeps its exact name after switching to Arabic (built-ins are translated)',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);const d0=await p.db(),bal=await p.text('#bal');
  for(const n of CUSTOM_EN)await addQuickOnly(p,n,12);
  eq((await p.db()).transactions.length,d0.transactions.length,'no transaction created:');eq(await p.text('#bal'),bal,'balance unchanged:');
  let c=await cards(p);for(const n of CUSTOM_EN)ok(c.some(x=>x.name===n),'shown in English: '+n);
  await lang(p,'ar');c=await cards(p);
  for(const n of CUSTOM_EN)ok(c.some(x=>x.name===n),`"${n}" must be unchanged in Arabic, got: ${c.map(x=>x.name).join(' | ')}`);
  for(const n of ['خبز','فراخ','سمك','لبن','رز','خضار'])ok(c.some(x=>x.name===n),'built-in translated: '+n);
  eq(await p.page.evaluate(()=>document.documentElement.dir),'rtl');ok(c.every(x=>x.icon),'every card has an icon');
  eq((await p.db()).quick_items.filter(q=>CUSTOM_EN.includes(q.name)).map(q=>q.key),CUSTOM_EN.map(()=>null),'stored as custom, name untouched:');
  await p.page.evaluate(()=>[...document.querySelectorAll('#qi .qc b')].find(b=>b.textContent==='Bread basket').click());await sheetOn(p);
  eq(await p.text('#st'),'Bread basket','sheet title:');noErr(p);await p.close()});
await test('custom item created in Arabic keeps its exact name after switching to English, and gets a matching icon',async()=>{
  const p=await open({uid:M,lang:'ar'});await p.go();await p.dash();const n0=(await p.db()).transactions.length;
  for(const n of CUSTOM_AR)await addQuickOnly(p,n,15);
  let c=await cards(p);for(const n of CUSTOM_AR)ok(c.some(x=>x.name===n),'shown in Arabic: '+n);
  eq(await p.page.evaluate(()=>[...document.querySelectorAll('#qi .qc b')].find(b=>b.textContent==='عيش فينو').getAttribute('dir')),'auto');
  await lang(p,'en');c=await cards(p);
  for(const n of CUSTOM_AR)ok(c.some(x=>x.name===n),`"${n}" must be unchanged in English, got: ${c.map(x=>x.name).join(' | ')}`);
  eq(c.find(x=>x.name==='عيش فينو').icon,'🍞');eq(c.find(x=>x.name==='شاي العروسة').icon,'☕');eq(c.find(x=>x.name==='حاجات البيت').icon,'🛒','fallback icon:');
  ok(c.some(x=>x.name==='Bread')&&c.some(x=>x.name==='Vegetables'));eq((await p.db()).transactions.length,n0);
  eq((await p.db()).quick_items.filter(q=>CUSTOM_AR.includes(q.name)).length,3);noErr(p);await p.close()});
await test('tapping a Quick Purchase (in Arabic) creates one real expense at its default price; names in Recent / History stay correct',async()=>{
  const p=await open({uid:M,lang:'ar'});await p.go();await p.dash();await addQuickOnly(p,'Bread basket',12);const n0=(await p.db()).transactions.length;
  await p.page.evaluate(()=>[...document.querySelectorAll('#qi .qc b')].find(b=>b.textContent==='خبز').click());await sheetOn(p);
  eq(await p.page.$eval('#amt',e=>e.value),'20');eq(await p.text('#st'),'خبز');await p.page.click('#sv');
  await p.wait(n=>JSON.parse(localStorage.getItem('mock_db')).transactions.length===n+1,n0);
  await p.page.evaluate(()=>[...document.querySelectorAll('#qi .qc b')].find(b=>b.textContent==='Bread basket').click());await sheetOn(p);await p.page.click('#sv');
  await p.wait(n=>JSON.parse(localStorage.getItem('mock_db')).transactions.length===n+2,n0);await p.status(/متصل/);
  const t=(await p.db()).transactions.slice(-2);eq(t.map(x=>[x.type,x.amount,x.category,x.user_id]),[['expense',20,'Bread',M],['expense',12,'Bread basket',M]]);
  await p.wait(()=>[...document.querySelectorAll('#tl .tm b')].some(b=>b.textContent==='Bread basket'));
  const names=await p.page.evaluate(()=>[...document.querySelectorAll('#tl .tm b')].map(b=>b.textContent));ok(names.includes('Bread basket')&&names.includes('خبز'),names.join(' | '));
  await p.page.click('#nv [data-n="hist"]');await p.wait(()=>document.querySelectorAll('#hl .tm b').length>3);
  const h=await p.page.evaluate(()=>[...document.querySelectorAll('#hl .tm b')].map(b=>b.textContent));ok(h.includes('Bread basket')&&h.includes('خبز')&&h.includes('سمك'),h.join(' | '));noErr(p);await p.close()});
await test('built-in list: add from the template sheet (localized, with icon, no transaction, no duplicates); remove an item',async()=>{
  const p=await open({uid:M,lang:'ar'});await p.go();await p.dash();const n0=(await p.db()).transactions.length;
  await p.status(/متصل/);await p.page.$eval('#qadd',e=>e.click());await p.wait(()=>document.querySelector('#qs').classList.contains('on'));
  const tp=await p.page.evaluate(()=>[...document.querySelectorAll('#qsl [data-k]')].map(b=>({k:b.dataset.k,icon:b.children[0].textContent.trim(),name:b.children[1].textContent.trim(),off:b.disabled})));
  eq(tp.length,42);ok(tp.every(x=>x.icon&&x.name&&/[\u0600-\u06FF]/.test(x.name)),'every template has an Arabic name and an icon');
  ok(tp.find(x=>x.k==='bread').off&&!tp.find(x=>x.k==='mango').off,'already-added items cannot be added twice');
  await p.page.$eval('#qsl [data-k="mango"]',e=>e.click());await p.wait(()=>JSON.parse(localStorage.getItem('mock_db')).quick_items.some(q=>q.key==='mango'));
  await p.page.$eval('#qsd',e=>e.click());await p.wait(()=>[...document.querySelectorAll('#qi .qc b')].some(b=>b.textContent==='مانجو'));
  const m=(await p.db()).quick_items.filter(q=>q.key==='mango');eq(m.map(q=>[q.name,q.default_price]),[['Mango',60]]);eq((await p.db()).transactions.length,n0);
  eq((await cards(p)).find(x=>x.name==='مانجو').icon,'🥭');
  await lang(p,'en');ok((await cards(p)).some(x=>x.name==='Mango'));
  await addQuickOnly(p,'mango',70);eq((await p.db()).quick_items.filter(q=>/mango/i.test(q.name)).map(q=>[q.name,q.key,q.default_price]),[['Mango','mango',70]],'typing a built-in name updates it instead of duplicating:');
  await p.page.click('#ed');await p.wait(()=>!!document.querySelector('#qi [data-del]'));
  await p.page.evaluate(()=>[...document.querySelectorAll('#qi .qc')].find(c=>c.querySelector('b').textContent==='Mango').querySelector('[data-del]').click());
  await p.wait(()=>!JSON.parse(localStorage.getItem('mock_db')).quick_items.some(q=>q.key==='mango'));eq((await p.db()).transactions.length,n0);noErr(p);await p.close()});
await test('a chosen icon is kept; expense + "add to Quick Purchases" saves one expense and one item at the default price',async()=>{
  const p=await open({uid:M});await p.go();await p.dash();await p.status(/Online/);await addQuickOnly(p,'Gift for mum',100,'🎁');
  eq((await cards(p)).find(x=>x.name==='Gift for mum').icon,'🎁');eq((await p.db()).quick_items.find(q=>q.name==='Gift for mum').icon,'🎁');
  const n0=(await p.db()).transactions.length;await p.page.click('[data-t="expense"]');await sheetOn(p);ok(!(await p.page.$eval('#qa',e=>e.checked)),'off by default');
  await p.page.$eval('#amt',e=>e.value='45');await p.page.$eval('#nt',e=>e.value='Koshary');await p.page.click('#qa');await p.page.$eval('#qp',e=>e.value='40');await p.page.click('#sv');
  await p.wait(()=>JSON.parse(localStorage.getItem('mock_db')).quick_items.some(q=>q.name==='Koshary'));const d=await p.db();
  eq(d.transactions.length,n0+1);eq([d.transactions.at(-1).amount,d.transactions.at(-1).category],[45,'Koshary']);eq(d.quick_items.filter(q=>q.name==='Koshary').map(q=>q.default_price),[40]);noErr(p);await p.close()});
await test('database not yet on migration 009: items still save (older function), starter items are still translated',async()=>{
  const p=await open({uid:M,lang:'ar',cfg:{no009:true}});await p.go();await p.dash();
  await p.setDb(d=>d.quick_items.forEach(q=>{delete q.key;delete q.icon}));await lang(p,'ar');
  await addQuickOnly(p,'Bread basket',12);const c=await cards(p);ok(c.some(x=>x.name==='Bread basket')&&c.some(x=>x.name==='خبز'),c.map(x=>x.name).join(' | '));ok(c.every(x=>x.icon));
  ok(await p.page.evaluate(()=>window.__calls.some(c=>c.name==='rpc upsert_quick_item')),'fell back to the older function');noErr(p);await p.close()});

console.log('\nLayout: bottom navigation, spacing, safe areas, RTL');
const metrics=p=>p.page.evaluate(()=>{const r=s=>{const e=document.querySelector(s);return e?e.getBoundingClientRect():null},nv=r('#nv'),btn=[...document.querySelectorAll('#nv button')].map(b=>b.getBoundingClientRect());
  const secs=[...document.querySelectorAll('#home .sec')].map(e=>Math.round(e.getBoundingClientRect().top+scrollY));
  const mins=sel=>Math.min(...[...document.querySelectorAll(sel)].map(e=>e.getBoundingClientRect().height));
  return{W:innerWidth,H:innerHeight,navTop:nv.top,navBottom:nv.bottom,navLeft:nv.left,navRight:nv.right,btnBottom:Math.max(...btn.map(b=>b.bottom)),btnH:Math.min(...btn.map(b=>b.height)),firstBtnX:btn[0].left,
    overflowX:document.documentElement.scrollWidth-innerWidth,quickTop:secs[0],recentTop:secs[1],pageH:document.documentElement.scrollHeight,
    hero:Math.round(r('.hero').height),wallets:Math.round(r('.wgrid').height),cta:r('.cta').height,chips:mins('.chips2 button'),quick:mins('.qc'),gear:r('#gear').height,walletText:[...document.querySelectorAll('.wc b')].every(b=>b.scrollWidth<=b.clientWidth+1)}});
const lastRowClear=p=>p.page.evaluate(()=>{scrollTo(0,document.documentElement.scrollHeight);const l=[...document.querySelectorAll('#tl .tx')].pop().getBoundingClientRect(),b=[...document.querySelectorAll('#nv button')][0].getBoundingClientRect();const ok=l.bottom<=b.top+0.5;scrollTo(0,0);return ok});
let before=null;
if(OLD)await test('(baseline) measure the previous version on an iPhone-sized screen',async()=>{
  const p=await open({uid:O,inset:34,url:'old.html'});await p.go();await p.dash();await sleep(600);before=await metrics(p);await p.shot('before-iphone');await p.close()});
await test('iPhone (home indicator, 34px inset): bar is flush with the bottom, buttons stay above the indicator, tighter Home',async()=>{
  const p=await open({uid:O,inset:34});await p.go();await p.dash();await p.status(/Online/);const m=await metrics(p);await p.shot('iphone-home');
  eq([m.navLeft,m.W-m.navRight,Math.round(m.H-m.navBottom)],[0,0,0],'nav edges (left,right,bottom gap):');
  ok(m.btnBottom<=m.H-34+0.5,`buttons must end above the home indicator (${m.btnBottom} vs ${m.H-34})`);ok(m.btnH>=48);ok(m.overflowX<=0,'no horizontal scroll');
  ok(m.cta>=48&&m.chips>=44&&m.quick>=44&&m.gear>=44,'touch targets '+JSON.stringify([m.cta,m.chips,m.quick,m.gear]));ok(m.walletText,'wallet amounts fit');ok(await lastRowClear(p),'last row is not hidden behind the bar');
  if(before){console.log(`       before -> after (390x844): "Quick purchases" starts at ${before.quickTop}px -> ${m.quickTop}px, "Recent" at ${before.recentTop}px -> ${m.recentTop}px, page height ${before.pageH}px -> ${m.pageH}px, nav gap below bar ${Math.round(before.H-before.navBottom)}px -> ${Math.round(m.H-m.navBottom)}px`);
    ok(m.quickTop<=before.quickTop-80,'Home is meaningfully tighter');ok(m.recentTop<before.recentTop-120)}
  ok(m.quickTop<m.H-90,'Quick purchases start on the first screen');noErr(p);await p.close()});
await test('Android-sized phone (no inset): bar sits exactly on the bottom edge, no gap',async()=>{
  const p=await open({uid:O,vp:'android'});await p.go();await p.dash();await p.status(/Online/);const m=await metrics(p);await p.shot('android-home');
  eq([m.navLeft,m.W-m.navRight,Math.round(m.H-m.navBottom)],[0,0,0]);ok(m.H-m.btnBottom<=1,'no dead space under the buttons: '+(m.H-m.btnBottom));ok(m.overflowX<=0);ok(m.walletText);ok(await lastRowClear(p));noErr(p);await p.close()});
await test('installed-PWA conditions (full-screen viewport with notch + home-indicator insets): header, bar and sheet respect the safe areas',async()=>{
  const p=await open({uid:O,inset:34,standalone:true});await p.go();await p.dash();await p.status(/Online/);const m=await metrics(p);
  eq(Math.round(m.H-m.navBottom),0);ok(m.btnBottom<=m.H-34+0.5);ok(await p.page.evaluate(()=>document.querySelector('.top').getBoundingClientRect().top>=47),'header clears the status bar / notch');
  await p.page.click('[data-t="expense"]');await p.wait(()=>document.querySelector('#sh').classList.contains('on'));await sleep(350);
  ok(await p.page.evaluate(()=>{const b=[...document.querySelectorAll('#sh .btn')].filter(x=>!x.hidden).pop().getBoundingClientRect();return b.bottom<=innerHeight-34+0.5}),'sheet buttons clear the home indicator');await p.shot('iphone-sheet');noErr(p);await p.close()});
await test('iPad: bar spans the bottom edge, content uses the width, nothing overflows',async()=>{
  const p=await open({uid:O,vp:'ipad'});await p.go();await p.dash();await p.status(/Online/);const m=await metrics(p);await p.shot('ipad-home');
  eq([m.navLeft,m.W-m.navRight,Math.round(m.H-m.navBottom)],[0,0,0]);ok(m.overflowX<=0);ok(await p.page.evaluate(()=>getComputedStyle(document.querySelector('.wgrid')).gridTemplateColumns.split(' ').length===4));noErr(p);await p.close()});
await test('Arabic / RTL: mirrored navigation and rows, arrow points source → destination in reading order, no overflow',async()=>{
  const p=await open({uid:O,lang:'ar',inset:34});await p.go();await p.dash();await sleep(500);const m=await metrics(p);await p.shot('iphone-rtl');
  eq(await p.page.evaluate(()=>[document.documentElement.dir,document.documentElement.lang]),['rtl','ar']);
  ok(m.firstBtnX>m.W/2,'Home tab is on the right in RTL');eq(Math.round(m.H-m.navBottom),0);ok(m.overflowX<=0);ok(m.walletText);
  const r=await p.page.evaluate(()=>{const t=[...document.querySelectorAll('#tl .tx')].find(e=>e.querySelector('.wl').textContent.includes('←'));const ic=document.querySelector('#tl .tx .ti').getBoundingClientRect(),am=document.querySelector('#tl .tx .ta').getBoundingClientRect();
    return{arrow:!!t,iconRight:ic.left>am.left,nav:document.querySelector('#nv button span').textContent,st:document.querySelector('#ns').textContent,del:document.body.innerText.includes('مستخدم محذوف'),digits:/[٠-٩]/.test(document.querySelector('#bal').textContent)}});
  ok(r.arrow,'transfer shows source ← destination');ok(r.iconRight,'row is mirrored');eq(r.nav,'الرئيسية');ok(r.del,'"Deleted user" is translated');ok(r.digits,'Arabic-Indic digits / currency');
  await p.page.click('#gear');const g=await p.page.evaluate(()=>{const a=document.querySelector('#menu').getBoundingClientRect();return a.left>=0&&a.left<innerWidth/2});ok(g,'settings menu opens on the leading (left) side in RTL');noErr(p);await p.close()});

console.log('\nSheets + wide layout');
await test('sheet: close button on top (always visible), page behind is locked, the sheet scrolls inside the visible screen, position restored on close',async()=>{
  const p=await open({uid:O,inset:34});await p.go();await p.dash();await p.status(/Online/);await p.page.evaluate(()=>window.scrollTo(0,300));const y0=await p.page.evaluate(()=>scrollY);ok(y0>100);
  await p.page.$eval('[data-t="expense"]',e=>e.click());await p.wait(()=>document.querySelector('#sh').classList.contains('on'));await p.page.click('#qa');await sleep(350);
  const m=await p.page.evaluate(()=>{const d=document.querySelector('#sh>div'),x=document.querySelector('#sh [data-x]').getBoundingClientRect(),b=d.getBoundingClientRect();d.scrollTop=9999;
    const x2=document.querySelector('#sh [data-x]').getBoundingClientRect(),last=[...d.querySelectorAll('.btn')].filter(e=>!e.hidden).pop().getBoundingClientRect(),em=[...document.querySelectorAll('#qic button')].map(e=>e.getBoundingClientRect());
    return{locked:getComputedStyle(document.body).position,scrolls:d.scrollHeight>d.clientHeight,st:d.scrollTop,top:b.top,bottom:b.bottom,H:innerHeight,x:[x.top,x.width,x.height],xAfter:x2.top,lastBottom:last.bottom,
      emoRow:new Set(em.map(r=>Math.round(r.top))).size,emoH:new Set(em.map(r=>Math.round(r.height))).size,ox:d.scrollWidth-d.clientWidth}});
  eq(m.locked,'fixed','page behind is locked:');ok(m.top>=47&&m.bottom<=m.H+.5,'sheet inside the screen '+JSON.stringify(m));ok(m.scrolls&&m.st>0,'sheet content scrolls');
  ok(m.x[0]>=m.top&&m.x[1]>=40&&m.x[2]>=40&&Math.abs(m.xAfter-m.x[0])<1,'close button stays at the top while scrolling');ok(m.lastBottom<=m.H-34+.5,'last button reachable above the home indicator');
  eq([m.emoRow,m.emoH,m.ox],[1,1,0],'icon row: one aligned row, equal heights, no sideways overflow:');
  await p.page.evaluate(()=>window.scrollTo(0,0));eq(await p.page.evaluate(()=>document.body.style.top),'-'+y0+'px','background did not move:');
  await p.page.click('#sh [data-x]');await p.wait(()=>!document.querySelector('#sh').classList.contains('on'));eq(await p.page.evaluate(()=>[getComputedStyle(document.body).position,scrollY]),['static',y0]);
  await p.page.$eval('#qadd',e=>e.click());await p.wait(()=>document.querySelector('#qs').classList.contains('on'));ok(await p.has('#qs [data-x]'));await p.page.click('#qs [data-x]');await p.wait(()=>!document.querySelector('#qs').classList.contains('on'));
  noErr(p);await p.close()});
await test('iPad landscape (two columns): nothing overlaps the Recent column; Arabic names keep the page alignment',async()=>{
  const p=await open({uid:O,vp:'ipadl'});await p.go();await p.dash();await p.status(/Online/);
  await p.setDb(d=>{d.transactions[d.transactions.length-1].category='صلصه'});await p.page.reload({waitUntil:'domcontentloaded'});await p.dash();await p.status(/Online/);await p.wait(()=>[...document.querySelectorAll('#tl .tm b')].some(b=>b.textContent==='صلصه'));
  const m=await p.page.evaluate(()=>{const r=e=>e.getBoundingClientRect(),left=r(document.querySelector('.cols>div')),tiles=[...document.querySelectorAll('.wgrid .wc')].map(r),rec=r(document.querySelector('#tl')),bg=r(document.querySelector('.hdbg')),h=r(document.querySelector('.cols>div+div h2'));
    const ar=[...document.querySelectorAll('#tl .tm b')].find(b=>b.textContent==='صلصه'),en=[...document.querySelectorAll('#tl .tm b')].find(b=>b.textContent!=='صلصه');
    return{over:tiles.filter(t=>t.right>left.right+.5).length,gap:rec.left-Math.max(...tiles.map(t=>t.right)),band:bg.bottom<=h.top,align:[getComputedStyle(ar).textAlign,getComputedStyle(en).textAlign],ox:document.documentElement.scrollWidth-innerWidth}});
  eq(m.over,0,'wallet tiles inside their column:');ok(m.gap>=16,'gap to Recent '+m.gap);ok(m.band,'header band ends above the Recent heading');eq(m.align,['left','left']);ok(m.ox<=0);await p.shot('ipad-landscape');noErr(p);await p.close()});

console.log('\nPush notifications (OneSignal)');
/* cdn.onesignal.com is answered with a small stand-in that records how the app drives the SDK (the real SDK needs the real site address) */
const STUB=`(()=>{const L=window.__os=Object.assign({init:[],calls:[],perm:false,opted:false,native:'default',sub:'aaaaaaaa-0000-4000-8000-000000000001'},JSON.parse(localStorage.getItem('__os')||'{}'));const ev={addEventListener(){}};
 const OneSignal={init:async o=>{L.init.push(o)},login:async id=>{L.calls.push('login:'+id);L.ext=id},logout:async()=>{L.calls.push('logout');L.ext=null},Notifications:{get permission(){return L.perm},get permissionNative(){return L.native},isPushSupported:()=>!L.unsupported,
   requestPermission:async()=>{L.calls.push('requestPermission');if(L.deny){L.native='denied'}else{L.perm=true;L.native='granted'}},addEventListener(){}},
  User:{setLanguage:l=>{L.lang=l},PushSubscription:{get id(){return L.sub},get optedIn(){return L.opted},optIn:async()=>{L.calls.push('optIn');L.opted=true},optOut:async()=>{L.calls.push('optOut');L.opted=false},addEventListener(){}}}};
 const run=f=>Promise.resolve().then(()=>f(OneSignal));const q=window.OneSignalDeferred||[];window.OneSignalDeferred={push:run};q.forEach(run)})()`;
const withSdk=async(p,mode)=>{await p.page.setRequestInterception(true);p.page.on('request',r=>{if(/onesignal\.com/.test(r.url())){mode==='block'?r.abort():r.respond({status:200,contentType:'text/javascript',body:STUB})}else r.continue()})};
const menu=async p=>{await p.page.click('#gear');await p.wait(()=>!document.querySelector('#menu').hidden)};
await test('SDK loads after the app, initialises once with the App ID, Safari ID and its own worker scope; no JavaScript errors',async()=>{
  const p=await open({uid:O});await withSdk(p);await p.go();await p.dash();await p.status(/Online/);await p.wait(()=>window.__os&&window.__os.init.length===1);
  const o=await p.page.evaluate(()=>{const o=window.__os.init[0];return{appId:o.appId,safari:o.safari_web_id,path:o.serviceWorkerPath,scope:o.serviceWorkerParam.scope,bell:o.notifyButton.enable,keys:Object.keys(o).sort()}});
  eq(o,{appId:'80a0910d-f366-4e2a-9a97-ca1fb05b0fd4',safari:'web.onesignal.auto.4cbbb6e8-691d-4369-88f4-1bdd9ac43935',path:'push/onesignal/OneSignalSDKWorker.js',scope:'/push/onesignal/',bell:true,
    keys:['allowLocalhostAsSecureOrigin','appId','notifyButton','safari_web_id','serviceWorkerParam','serviceWorkerPath']});
  eq(await p.text('#bal'),'EGP 730.00');noErr(p);await p.close()});
await test('permission flow from the settings menu: prompt → subscribed → can be turned off again; nothing is asked before the tap',async()=>{
  const p=await open({uid:O});await withSdk(p);await p.go();await p.dash();await p.wait(()=>window.__os&&window.__os.init.length===1);
  eq(await p.page.evaluate(()=>window.__os.calls.filter(c=>!c.startsWith('login'))),[],'no prompt on load:');await menu(p);await p.wait(()=>!document.querySelector('#pn').hidden);eq(await p.text('#pn'),'Turn on notifications');
  await p.page.click('#pn');await p.wait(()=>window.__os.opted);eq(await p.page.evaluate(()=>window.__os.calls.filter(c=>!c.startsWith('login'))),['requestPermission','optIn']);ok(/are on/.test(await p.toast()));
  await menu(p);eq(await p.text('#pn'),'Notifications: On');await p.page.click('#pn');await p.wait(()=>!window.__os.opted);ok(/are off/.test(await p.toast()));noErr(p);await p.close()});
await test('permission refused → clear message, no subscription; Arabic labels',async()=>{
  const p=await open({uid:O,lang:'ar'});await withSdk(p);await p.go();await p.dash();await p.wait(()=>window.__os&&window.__os.init.length===1);await p.page.evaluate(()=>{window.__os.deny=true});
  eq(await p.page.evaluate(()=>window.__os.init[0].notifyButton.position),'bottom-left');
  await menu(p);await p.wait(()=>!document.querySelector('#pn').hidden);eq(await p.text('#pn'),'تفعيل الإشعارات');await p.page.click('#pn');await p.wait(()=>window.__os.native==='denied');
  await p.wait(()=>/محظورة/.test(document.querySelector('#toast').textContent));ok(!(await p.page.evaluate(()=>window.__os.opted)));await menu(p);eq(await p.text('#pn'),'الإشعارات: محظورة');noErr(p);await p.close()});
await test('OneSignal unreachable (offline / blocked): the app is unaffected and the menu entry stays hidden',async()=>{
  const p=await open({uid:O});await withSdk(p,'block');await p.go();await p.dash();await p.status(/Online/);await sleep(400);
  await menu(p);ok(await p.page.$eval('#pn',e=>e.hidden));ok(await p.page.evaluate(()=>window.HTPush.state()===null));
  await p.page.click('#menu #ac');await p.wait(()=>!document.querySelector('#more').hidden);noErr(p);await p.close()});

console.log('\nHousehold transaction notifications (client side)');
const subscribed=p=>p.page.evaluateOnNewDocument(()=>{if(!localStorage.getItem('__os'))localStorage.setItem('__os',JSON.stringify({perm:true,opted:true,native:'granted'}))});
const SUB='aaaaaaaa-0000-4000-8000-000000000001';
const fnCalls=p=>p.page.evaluate(()=>window.__calls.filter(c=>c.name==='fn notify-transactions').length);
await test('login identity: OneSignal external id = Supabase user id, and the device is registered to that user in the database',async()=>{
  const p=await open({uid:M,lang:'ar'});await subscribed(p);await withSdk(p);await p.go();await p.dash();
  await p.wait(s=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).some(d=>d.subscription_id===s),SUB);
  eq(await p.page.evaluate(()=>[window.__os.calls.filter(c=>c.startsWith('login')),window.__os.lang]),[['login:'+M],'ar']);
  eq((await p.db()).push_devices,[{subscription_id:SUB,user_id:M,lang:'ar'}]);eq(await fnCalls(p),0,'nothing is sent just by opening the app:');noErr(p);await p.close()});
await test('a device that has not allowed notifications is not registered',async()=>{
  const p=await open({uid:M});await withSdk(p);await p.go();await p.dash();await p.wait(()=>window.__os&&window.__os.calls.some(c=>c.startsWith('login')));await sleep(300);
  eq((await p.db()).push_devices||[],[]);await menu(p);await p.wait(()=>!document.querySelector('#pn').hidden);await p.page.click('#pn');
  await p.wait(s=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).some(d=>d.subscription_id===s),SUB);
  await menu(p);await p.page.click('#pn');await p.wait(()=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).length===0);noErr(p);await p.close()});
await test('online entry: the notify function is called only after the entry is saved, with no parameters; one notification',async()=>{
  const p=await open({uid:M});await subscribed(p);await withSdk(p);await p.go();await p.dash();await p.status(/Online/);const n0=(await p.db()).transactions.length;
  await addExpense(p,5,'Gum');await p.wait(n=>JSON.parse(localStorage.getItem('mock_db')).transactions.length===n+1,n0);await p.wait(()=>(JSON.parse(localStorage.getItem('mock_db')).pushes||[]).length===1);
  const d=await p.db(),t=d.transactions.at(-1);eq(d.pushes,[{tx:t.id,body:{},to:[SUB]}]);
  const order=await p.page.evaluate(()=>window.__calls.map(c=>c.name).filter(n=>n==='insert transactions'||n==='fn notify-transactions'));eq(order,['insert transactions','fn notify-transactions']);noErr(p);await p.close()});
await test('offline entry: nothing is sent while it only exists on the phone; after it syncs exactly one notification; later syncs / reloads add none',async()=>{
  const p=await open({uid:M});await subscribed(p);await withSdk(p);await p.go();await p.dash();await p.status(/Online/);const n0=(await p.db()).transactions.length;
  await p.net(false);await p.status(/Offline/);await addExpense(p,7,'Offline tea');await p.wait(()=>[...document.querySelectorAll('#tl .tm b')].some(b=>b.textContent==='Offline tea'));await sleep(400);
  eq([await fnCalls(p),((await p.db()).pushes||[]).length,(await p.db()).transactions.length],[0,0,n0],'offline: no call, no notification, nothing on the server:');
  await p.net(true);await p.wait(n=>JSON.parse(localStorage.getItem('mock_db')).transactions.length===n+1,n0);await p.wait(()=>(JSON.parse(localStorage.getItem('mock_db')).pushes||[]).length===1);
  await p.page.evaluate(()=>localStorage.removeItem('__offline'));await p.page.reload({waitUntil:'domcontentloaded'});await p.dash();await p.status(/Online/);await sleep(400);
  const d=await p.db();eq([d.transactions.length,d.pushes.length,d.outbox.filter(o=>o.status==='pending').length],[n0+1,1,0]);noErr(p);await p.close()});
await test('entry rejected by the server: no notification; notify function failing: the entry stays saved and no error is shown',async()=>{
  const p=await open({uid:M,cfg:{pushFail:true}});await subscribed(p);await withSdk(p);await p.go();await p.dash();await p.status(/Online/);const n0=(await p.db()).transactions.length;
  await addExpense(p,99999,'Too much',WP);await p.wait(()=>/Insufficient funds/.test(document.querySelector('#toast')?.textContent||''));eq([await fnCalls(p),(await p.db()).transactions.length],[0,n0]);
  await sleep(4800);await addExpense(p,5,'Gum');await p.wait(n=>JSON.parse(localStorage.getItem('mock_db')).transactions.length===n+1,n0);await p.wait(()=>window.__calls.some(c=>c.name==='fn notify-transactions'));await sleep(300);
  eq(await p.toast(),'','no error toast for a notification problem:');eq(((await p.db()).pushes||[]).length,0);ok((await p.text('#tl')).includes('Gum'));
  eq(p.errors.filter(e=>!/notifications:/.test(e)),[]);await p.close()});
await test('log out, then another account logs in on the same phone: device is released, then belongs to the new account only',async()=>{
  const p=await open({uid:M});await subscribed(p);await withSdk(p);await p.go();await p.dash();await p.wait(s=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).length===1);
  await menu(p);await p.page.click('#lo');await p.wait(()=>!!document.querySelector('#em'));
  eq((await p.db()).push_devices,[],'device row removed at log-out:');
  await p.wait(()=>window.__os&&window.__os.init.length===1);eq(await p.page.evaluate(()=>[window.__os.calls.at(-1),window.__os.ext]),['logout',null],'logged out: no identity:');
  await p.page.type('#em','owner@t.io');await p.page.type('#pw','secret1');await p.page.click('#go');await p.dash();
  await p.wait(s=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).length===1);eq((await p.db()).push_devices,[{subscription_id:SUB,user_id:O,lang:'en'}]);
  eq(await p.page.evaluate(()=>[window.__os.calls.filter(c=>c.startsWith('login')).at(-1),window.__os.ext]),['login:'+O,O]);noErr(p);await p.close()});
await test('log-out order: the server forgets the device BEFORE the session ends, then OneSignal forgets the user; offline log-out switches push off locally',async()=>{
  const p=await open({uid:M});await subscribed(p);await withSdk(p);await p.go();await p.dash();await p.wait(s=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).length===1);
  await p.page.evaluate(()=>{const o=window.__os,keep=k=>sessionStorage.setItem('__seq',(sessionStorage.getItem('__seq')||'')+k+',');const lo=o.calls.push.bind(o.calls);o.calls.push=x=>{keep('os:'+x);return lo(x)};const c=window.__calls,cp=c.push.bind(c);c.push=x=>{keep(x.name);return cp(x)}});
  await menu(p);await p.page.click('#lo');await p.wait(()=>!!document.querySelector('#em'));
  const seq=(await p.page.evaluate(()=>sessionStorage.getItem('__seq'))).split(',').filter(x=>/unregister|os:logout|signOut/.test(x));eq(seq,['rpc unregister_push_device','os:logout','auth.signOut']);await p.close();
  const q=await open({uid:M});await subscribed(q);await withSdk(q);await q.go();await q.dash();await q.wait(s=>(JSON.parse(localStorage.getItem('mock_db')).push_devices||[]).length===1);
  await q.net(false);await q.status(/Offline/);await menu(q);await q.page.click('#lo');await q.wait(()=>localStorage.getItem('ht_push_reopt')==='1',null,9000);
  eq(await q.page.evaluate(()=>localStorage.getItem('ht_push_reopt')),'1');await q.close()});

console.log('\nPWA / service worker');
await test('service worker precaches the shell (incl. supabase lib); the app starts with the server unreachable',async()=>{
  srv.noSW=false;const p=await open({uid:O});await p.go();await p.dash();await p.status(/Online/);
  await p.page.evaluate(()=>navigator.serviceWorker.ready);
  await p.wait(()=>caches.keys().then(async k=>{if(!k.includes('ht-v10'))return false;const c=await caches.open('ht-v10');return!!(await c.match('supabase.min.js'))&&!!(await c.match('index.html'))&&!!(await c.match('core.js'))}),null,8000);
  await p.wait(()=>!!navigator.serviceWorker.controller,null,8000);
  // the app's worker is still the one controlling the page; the push worker lives in its own scope and is never cached by it
  const sw=await p.page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();const w=await fetch('push/onesignal/OneSignalSDKWorker.js');const c=await caches.open('ht-v10');await new Promise(r=>setTimeout(r,200));
    return{script:new URL(navigator.serviceWorker.controller.scriptURL).pathname,scope:new URL(r.scope).pathname,worker:w.ok&&/importScripts\("https:\/\/cdn\.onesignal\.com\/sdks\/web\/v16\/OneSignalSDK\.sw\.js"\)/.test(await w.text()),
      cached:(await c.keys()).filter(q=>/onesignal/i.test(q.url)).length,manifest:await (await fetch('manifest.json')).json()}});
  eq([sw.script,sw.scope,sw.worker,sw.cached],['/sw.js','/',true,0]);eq([sw.manifest.display,sw.manifest.start_url,sw.manifest.icons.length],['standalone','./',2],'installability unchanged:');
  srv.dead=true;await p.cfg({down:true,auth:'netfail'});await p.net(false);
  await p.page.reload({waitUntil:'domcontentloaded'});await p.dash(3000);await p.status(/Offline/);eq(await p.text('#bal'),'EGP 730.00');noErr(p);
  srv.dead=false;srv.noSW=true;await p.close()});
}catch(e){console.error(e);process.exitCode=1}
finally{done('ui');await browser.close();server.close()}
