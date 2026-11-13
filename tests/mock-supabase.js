/* TEST ONLY. A small in-browser stand-in for supabase-js, served instead of supabase.min.js by tests/ui.test.mjs.
   It keeps a fake database in localStorage and mimics the server rules that matter to the UI
   (membership visibility, creator-or-owner edit/delete, funds check on INSERT/UPDATE but not on DELETE = migration 008).
   The REAL rules are tested against a real PostgreSQL in tests/db.test.mjs. window.__cfg controls latency / failures. */
(function(){
const cfg=window.__cfg=Object.assign({latency:0,down:false,auth:'ok',authDelay:0},JSON.parse(localStorage.getItem('mock_cfg')||'{}'));
const calls=window.__calls=[];const t0=performance.now();
const db=()=>JSON.parse(localStorage.getItem('mock_db')||'{"users":[],"households":[],"members":[],"wallets":[],"quick_items":[],"transactions":[]}');
const save=d=>localStorage.setItem('mock_db',JSON.stringify(d));
const uuid=()=>crypto.randomUUID();const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const KEY='ht-auth';let listeners=[];
const stored=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){return null}};
const uid=()=>{const s=stored();return s&&s.user?s.user.id:null};
const emit=(e,s)=>listeners.forEach(f=>{try{f(e,s)}catch(x){console.error(x)}});
const NET={message:'TypeError: Failed to fetch'};
const netFail=()=>({data:null,error:NET,status:0});
async function wire(name){calls.push({name,at:Math.round(performance.now()-t0)});if(cfg.latency)await sleep(cfg.latency);if(cfg.hang)await new Promise(()=>{});return!cfg.down}
const member=(d,h,u)=>d.members.find(m=>m.household_id===h&&m.user_id===u);
const eff=(t,w)=>t.type==='income'?(t.wallet_id===w?+t.amount:0):t.type==='expense'?(t.wallet_id===w?-t.amount:0):(t.wallet_id===w?-t.amount:0)+(t.to_wallet_id===w?+t.amount:0);
const wbal=(d,w)=>Math.round(d.transactions.reduce((a,t)=>a+eff(t,w),0)*100)/100;
function funds(d,oldT,newT){for(const w of new Set([oldT&&oldT.wallet_id,oldT&&oldT.to_wallet_id,newT.wallet_id,newT.to_wallet_id].filter(Boolean))){
  const delta=eff(newT,w)-(oldT?eff(oldT,w):0);if(delta<0&&wbal(d,w)<0){const n=d.wallets.find(x=>x.id===w).name;return{message:`Insufficient funds. Available balance in ${n}: ${(wbal(d,w)-delta).toFixed(2)} EGP.`,code:'P0001'}}}return null}
const sessionOf=u=>({access_token:'tok-'+u.id,refresh_token:'r',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:u.id,email:u.email}});
const auth={
  async getSession(){calls.push({name:'auth.getSession',at:Math.round(performance.now()-t0)});const s=stored();if(!s)return{data:{session:null},error:null};
    if(cfg.authDelay)await sleep(cfg.authDelay);
    if(cfg.auth==='hang')await new Promise(()=>{});
    if(cfg.auth==='netfail')return{data:{session:null},error:{message:'Failed to fetch',status:0,name:'AuthRetryableFetchError'}};   // refresh could not reach the server: session stays stored
    if(cfg.auth==='rejected'||!db().users.find(u=>u.id===s.user.id)){localStorage.removeItem(KEY);emit('SIGNED_OUT',null);return{data:{session:null},error:null}} // refresh token refused
    return{data:{session:s},error:null}},
  onAuthStateChange(f){listeners.push(f);return{data:{subscription:{unsubscribe(){listeners=listeners.filter(x=>x!==f)}}}}},
  async signInWithPassword({email,password}){if(!await wire('auth.signIn'))return{data:{},error:NET};const u=db().users.find(x=>x.email===email&&x.password===password);
    if(!u)return{data:{},error:{message:'Invalid login credentials'}};const s=sessionOf(u);localStorage.setItem(KEY,JSON.stringify(s));emit('SIGNED_IN',s);return{data:{session:s},error:null}},
  async signUp({email,password,options}){if(!await wire('auth.signUp'))return{data:{},error:NET};const d=db(),u={id:uuid(),email,password,name:(options&&options.data&&options.data.name)||email.split('@')[0]};
    d.users.push(u);save(d);const s=sessionOf(u);localStorage.setItem(KEY,JSON.stringify(s));emit('SIGNED_IN',s);return{data:{session:s},error:null}},
  async signOut(){calls.push({name:'auth.signOut'});if(cfg.down)return{error:NET};localStorage.removeItem(KEY);emit('SIGNED_OUT',null);return{error:null}},
  async resend(){return{error:null}},async resetPasswordForEmail(){return{error:null}},async updateUser(){return{error:null}}};
class Query{constructor(t){this.t=t;this.f=[];this.op='select';this.ord=[]}
  select(c){this.cols=c||'*';if(this.op!=='select')this.ret=true;return this}
  eq(k,v){this.f.push(r=>String(r[k])===String(v));this.eqs=Object.assign(this.eqs||{},{[k]:v});return this}
  is(k,v){this.f.push(r=>(r[k]??null)===v);return this}
  gte(k,v){this.f.push(r=>r[k]>=v);return this}lt(k,v){this.f.push(r=>r[k]<v);return this}
  or(s){const m=/%(.*?)%/.exec(s),q=m?m[1].toLowerCase():'';this.f.push(r=>(r.category||'').toLowerCase().includes(q)||(r.note||'').toLowerCase().includes(q));return this}
  order(k,o){this.ord.push([k,!o||o.ascending!==false]);return this}limit(n){this.lim=n;return this}range(a,b){this.rng=[a,b];return this}
  update(p){this.op='update';this.patch=p;return this}delete(){this.op='delete';return this}
  upsert(row){this.op='insert';this.row=row;return this}
  then(a,b){return this.run().then(a,b)}
  async run(){if(!await wire(this.op+' '+this.t))return netFail();const d=db(),me=uid();if(!me)return{data:null,error:{message:'JWT expired',code:'PGRST301'},status:401};
    const vis=r=>this.t==='members'||this.t==='transactions'||this.t==='wallets'||this.t==='quick_items'?!!member(d,r.household_id,me):true;
    const name=u=>{const x=d.users.find(y=>y.id===u);return x&&member(d,(d.members.find(m=>m.user_id===me)||{}).household_id,u)?{name:x.name}:null};
    if(this.op==='insert'){const r=this.row;if(d.transactions.some(x=>x.client_id===r.client_id))return{data:null,error:null,status:201};
      if(!member(d,r.household_id,me)||r.user_id!==me)return{data:null,error:{message:'new row violates row-level security policy',code:'42501'},status:403};
      const now=new Date().toISOString(),row={id:uuid(),...r,updated_at:now};d.transactions.push(row);const e=funds(d,null,row);if(e)return{data:null,error:e,status:400};(d.outbox=d.outbox||[]).push({tx:row.id,household_id:row.household_id,status:'pending'});save(d);return{data:null,error:null,status:201}}
    let rows=d[this.t].filter(vis).filter(r=>this.f.every(f=>f(r)));
    if(this.op==='delete'){if(this.t!=='quick_items')rows=rows.filter(r=>r.user_id===me||member(d,r.household_id,me).role==='owner');d[this.t]=d[this.t].filter(r=>!rows.includes(r));save(d);return{data:rows.map(r=>({id:r.id})),error:null,status:200}}
    if(this.op==='update'){if(this.t==='quick_items'){rows.forEach(r=>Object.assign(r,this.patch));save(d);return{data:rows,error:null,status:200}}
      rows=rows.filter(r=>r.user_id===me||member(d,r.household_id,me).role==='owner');const out=[];
      for(const r of rows){const old={...r};Object.assign(r,this.patch,{updated_at:new Date(Date.now()+1).toISOString()});const e=funds(d,old,r);if(e)return{data:null,error:e,status:400};out.push({id:r.id,updated_at:r.updated_at})}
      save(d);return{data:out,error:null,status:200}}
    for(const [k,asc] of [...this.ord].reverse())rows.sort((x,y)=>(x[k]>y[k]?1:x[k]<y[k]?-1:0)*(asc?1:-1));
    if(this.rng)rows=rows.slice(this.rng[0],this.rng[1]+1);if(this.lim)rows=rows.slice(0,this.lim);
    rows=rows.map(r=>{const o={...r};if(/profiles\(/.test(this.cols||''))o.profiles=r.user_id?name(r.user_id):null;if(/households\(/.test(this.cols||''))o.households=d.households.find(h=>h.id===r.household_id)||null;return o});
    return{data:rows,error:null,status:200}}}
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(new Date());
const RPC={
  household_summary(d,me,{h}){const t=d.transactions.filter(x=>x.household_id===h),ex=t.filter(x=>x.type==='expense').reduce((a,x)=>a+ +x.amount,0);
    return{balance:t.reduce((a,x)=>a+(x.type==='income'?+x.amount:x.type==='expense'?-x.amount:0),0),today:ex,week:ex,month:ex}},
  wallet_balances(d,me,{h}){return d.wallets.filter(w=>w.household_id===h).map(w=>({id:w.id,name:w.name,balance:wbal(d,w.id)}))},
  range_stats(d,me,{h}){const t=d.transactions.filter(x=>x.household_id===h&&x.type==='expense'),nm=x=>{const u=d.users.find(y=>y.id===x.user_id);return u?u.name:'Deleted user'};
    const grp=f=>Object.values(t.reduce((m,x)=>{const k=f(x);m[k]=m[k]||{name:k,total:0,n:0};m[k].total+=+x.amount;m[k].n++;return m},{}));
    return{income:d.transactions.filter(x=>x.household_id===h&&x.type==='income').reduce((a,x)=>a+ +x.amount,0),expenses:t.reduce((a,x)=>a+ +x.amount,0),count:t.length,by_cat:grp(x=>x.category),by_member:grp(nm),
      daily:t.length?[{d:today(),total:t.reduce((a,x)=>a+ +x.amount,0)}]:[],top:t.slice().sort((a,b)=>b.amount-a.amount).slice(0,5).map(x=>({category:x.category,amount:x.amount,pname:nm(x),wname:(d.wallets.find(w=>w.id===x.wallet_id)||{}).name,created_at:x.created_at}))}},
  save_quick_item(d,me,{h,n,p,k,ic}){if(JSON.parse(localStorage.getItem('mock_cfg')||'{}').no009)return{__err:{message:'Could not find the function public.save_quick_item(h, ic, k, n, p) in the schema cache',code:'PGRST202'},__status:404};
    const nm=String(n||'').trim();let q=(k&&d.quick_items.find(x=>x.household_id===h&&x.key===k))||d.quick_items.find(x=>x.household_id===h&&x.name.trim().toLowerCase()===nm.toLowerCase());
    if(q){q.default_price=p;q.key=q.key||k||null;q.icon=ic||q.icon||null}else d.quick_items.push({id:uuid(),household_id:h,name:nm,default_price:p,key:k||null,icon:ic||null});return{created:!q}},
  upsert_quick_item(d,me,{h,n,p}){const q=d.quick_items.find(x=>x.household_id===h&&x.name.toLowerCase()===n.trim().toLowerCase());if(q)q.default_price=p;else d.quick_items.push({id:uuid(),household_id:h,name:n.trim(),default_price:p});return{created:!q}},
  create_household(d,me,{hname}){const h=uuid();d.households.push({id:h,name:hname,invite_code:h.slice(0,8)});d.members.push({household_id:h,user_id:me,role:'owner'});
    ['Household cash','Bank account','Personal cash'].forEach((n,i)=>d.wallets.push({id:uuid(),household_id:h,name:n,is_default:!i}));return h},
  join_household(d,me,{code}){const h=d.households.find(x=>x.invite_code===code.trim().toLowerCase());if(!h)throw{message:'invalid invitation code'};if(!member(d,h.id,me))d.members.push({household_id:h.id,user_id:me,role:'member'});return h.id},
  delete_my_account(d,me){if(d.members.some(m=>m.user_id===me&&m.role==='owner'&&d.members.some(o=>o.household_id===m.household_id&&o.user_id!==me)))throw{message:'You own a household that still has other members. Remove them, or delete the household (Household > Delete Household), before deleting your account.'};
    d.users=d.users.filter(u=>u.id!==me);d.members=d.members.filter(m=>m.user_id!==me);d.transactions.forEach(t=>{if(t.user_id===me)t.user_id=null});return null},
  register_push_device(d,me,{sub,lng}){d.push_devices=(d.push_devices||[]).filter(x=>x.subscription_id!==sub);d.push_devices.push({subscription_id:sub,user_id:me,lang:lng||'en'});return null},
  unregister_push_device(d,me,{sub}){d.push_devices=(d.push_devices||[]).filter(x=>!(x.subscription_id===sub&&x.user_id===me));return null},
  remove_member(d,me,{h,uid:u}){d.members=d.members.filter(m=>!(m.household_id===h&&m.user_id===u));return null}};
window.supabase={createClient(){return{auth,from:t=>new Query(t),
  /* Edge Function stand-in: like the real one it takes no parameters, claims each pending outbox row of the caller's household once, and "sends" to the devices of that household's members */
  functions:{invoke:async(n,o)=>{if(!await wire('fn '+n))return{data:null,error:{message:'Failed to send a request to the Edge Function'}};const d=db(),me=uid();if(!me)return{data:null,error:{message:'not signed in'}};
    if(JSON.parse(localStorage.getItem('mock_cfg')||'{}').pushFail)return{data:null,error:{message:'Edge Function returned a non-2xx status code'}};
    const hs=d.members.filter(m=>m.user_id===me).map(m=>m.household_id);let c=0;(d.outbox||[]).forEach(x=>{if(x.status==='pending'&&hs.includes(x.household_id)){x.status='sent';c++;
      (d.pushes=d.pushes||[]).push({tx:x.tx,body:o&&o.body,to:(d.push_devices||[]).filter(p=>p.user_id!==(d.transactions.find(t=>t.id===x.tx)||{}).user_id&&d.members.some(m=>m.household_id===x.household_id&&m.user_id===p.user_id)).map(p=>p.subscription_id).sort()})}});save(d);return{data:{claimed:c},error:null}}},
  rpc(n,a){return{then(x,y){return(async()=>{if(!await wire('rpc '+n))return netFail();const d=db(),me=uid();if(!me)return{data:null,error:{message:'JWT expired',code:'PGRST301'},status:401};
    try{const r=RPC[n](d,me,a||{});if(r&&r.__err)return{data:null,error:r.__err,status:r.__status};save(d);return{data:r,error:null,status:200}}catch(e){return{data:null,error:e,status:400}}})().then(x,y)}}},
  channel(){const c={on(){return c},subscribe(f){setTimeout(()=>f&&f('SUBSCRIBED'),5);return c}};return c},removeChannel(){}}}};
})();
