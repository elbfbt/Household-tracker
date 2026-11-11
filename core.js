/* Shared accounting + offline-queue logic. Used by index.html AND by tests/. One sign convention for everything. */
(function(g){'use strict';
const cents=x=>Math.round(+x*100);
// total balance effect: income +, expense -, withdraw/deposit/transfer 0 (they only MOVE money between wallets)
const sign=t=>t==='income'?1:t==='expense'?-1:0;
function effects(r){const a=cents(r.amount);
  if(r.type==='income')return[[r.wallet_id,a]];
  if(r.type==='expense')return[[r.wallet_id,-a]];
  return[[r.wallet_id,-a],[r.to_wallet_id,a]]}
const live=q=>q.filter(o=>!o.state||o.state==='pending');
function pendingEffects(queue){const out=[];for(const o of live(queue)){if(o.op==='qi')continue;
  if(!o.op)out.push(...effects(o));
  else{effects(o.old).forEach(([w,c])=>out.push([w,-c]));if(o.op==='upd')out.push(...effects({...o.old,...o.patch}))}}
  return out}
function balances(wallets,queue,defId){const m={};wallets.forEach(w=>m[w.id]=cents(w.balance));
  pendingEffects(queue).forEach(([w,c])=>{const k=w||defId;m[k]=(m[k]||0)+c});
  const r={};let t=0;for(const k in m){r[k]=m[k]/100;t+=m[k]}return{wallets:r,total:t/100}}
/* ---- Africa/Cairo day logic ---- */
const TZ='Africa/Cairo';
const cairoYmd=d=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d));
function addDays(ymd,n){const t=new Date(ymd+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10)}
function periods(now){const t=cairoYmd(now),wd=(new Date(t+'T00:00:00Z').getUTCDay()+6)%7;return{today:t,week:addDays(t,-wd),month:t.slice(0,8)+'01'}}
function cairoStart(ymd){const guess=Date.parse(ymd+'T00:00:00Z');
  const off=ms=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(ms)).reduce((a,x)=>(a[x.type]=x.value,a),{});return Date.UTC(+p.year,p.month-1,+p.day,+p.hour,+p.minute,+p.second)-ms};
  let t=guess-off(guess);t=guess-off(t);return new Date(t).toISOString()}
function spendDeltas(queue,now){const P=periods(now),d={today:0,week:0,month:0};
  const add=(r,s)=>{if(r.type!=='expense')return;const y=cairoYmd(r.created_at),c=s*cents(r.amount);if(y>=P.today)d.today+=c;if(y>=P.week)d.week+=c;if(y>=P.month)d.month+=c};
  for(const o of live(queue)){if(o.op==='qi')continue;if(!o.op)add(o,1);else{add(o.old,-1);if(o.op==='upd')add({...o.old,...o.patch},1)}}
  return{today:d.today/100,week:d.week/100,month:d.month/100}}
/* ---- numbers typed on Arabic/English keyboards ---- */
const num=v=>{let x=String(v).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g,'.').replace(/\s/g,'');x=/^\d{1,3}([,،]\d{3})+(\.\d+)?$/.test(x)?x.replace(/[,،]/g,''):x.replace(/[,،]/g,'.');return +x};
/* ---- error classification: nothing is ever dropped because of an error ---- */
function classify(err,status){if(!err)return'ok';
  const m=String(err.message||err),c=String(err.code||''),s=err.status||status||0;
  if(c==='23505')return'duplicate';
  if(c==='42501'||/row-level security|permission denied|immutable|another user/i.test(m))return'permanent';
  if(s===401||c==='PGRST301'||c==='PGRST303'||/jwt|token|not authenticated|not signed in|refresh/i.test(m))return'auth';
  if(/failed to fetch|networkerror|network request failed|load failed|timeout|offline/i.test(m)||(s===0&&!c)||s===408||s===429||s>=500||c==='57014')return'network';
  return'permanent'}
/* ---- per-user durable queue ---- */
const rid=()=>(g.crypto&&g.crypto.randomUUID)?g.crypto.randomUUID():'q'+Date.now().toString(36)+Math.random().toString(36).slice(2);
function Queue(store,uid){if(!uid)throw new Error('Queue needs a user id');
  const key='ht_q:'+uid,tkey='ht_trash:'+uid;
  const rd=k=>{try{return JSON.parse(store.getItem(k)||'[]')}catch(e){return[]}};
  const idx=on=>{const ix=rd('ht_qusers'),has=ix.includes(uid);if(on&&!has)store.setItem('ht_qusers',JSON.stringify([...ix,uid]));if(!on&&has)store.setItem('ht_qusers',JSON.stringify(ix.filter(x=>x!==uid)))};
  const wr=a=>{store.setItem(key,JSON.stringify(a));idx(a.length>0)};
  return{all:()=>rd(key),
    push(o){wr([...rd(key),{...o,qid:o.qid||o.client_id||rid(),uid,state:'pending',err:'',tries:0}])},
    mark(qid,state,err){wr(rd(key).map(o=>o.qid===qid?{...o,state,err:err||''}:o))},
    bump(qid){wr(rd(key).map(o=>o.qid===qid?{...o,tries:(o.tries||0)+1}:o))},
    remove(qid){wr(rd(key).filter(o=>o.qid!==qid))},
    discard(qid){const all=rd(key),o=all.find(x=>x.qid===qid);if(o){const gone=all.filter(x=>x.qid===qid||x.dep===qid);store.setItem(tkey,JSON.stringify([...rd(tkey),...gone.map(x=>({...x,discarded_at:new Date().toISOString()}))]));wr(all.filter(x=>!gone.includes(x)))}},
    rebase(id,base){wr(rd(key).map(o=>o.op==='upd'&&o.id===id&&o.state==='pending'?{...o,base}:o))}}}
function foreign(store,uid){let ix=[];try{ix=JSON.parse(store.getItem('ht_qusers')||'[]')}catch(e){}
  return ix.filter(u=>u!==uid).map(u=>{let a=[];try{a=JSON.parse(store.getItem('ht_q:'+u)||'[]')}catch(e){}return{uid:u,count:a.length}}).filter(x=>x.count)}
async function sync(q,uid,env){const res={synced:0,failed:0,conflict:0,stopped:null,errors:[]};
  for(const id of q.all().map(x=>x.qid)){const o=q.all().find(x=>x.qid===id);if(!o||o.state!=='pending'||o.uid!==uid)continue;
    if(o.dep&&q.all().some(x=>x.qid===o.dep))continue;
    if(!env.online()){res.stopped='network';break}
    if(await env.sessionUid()!==uid){res.stopped='auth';break}
    let r;try{r=await env.exec(o)}catch(e){r={error:e}}
    if(r.conflict){q.mark(o.qid,'conflict',r.message);res.conflict++;continue}
    const k=classify(r.error,r.status);
    if(k==='ok'||k==='duplicate'){q.remove(o.qid);res.synced++;if(o.op==='upd'&&r.updated_at)q.rebase(o.id,r.updated_at);continue}
    if(k==='network'){q.bump(o.qid);res.stopped='network';break}
    if(k==='auth'){res.stopped='auth';break}
    const msg=String((r.error&&r.error.message)||r.error);q.mark(o.qid,'failed',msg);res.errors.push(msg);res.failed++}
  return res}
/* ---- Quick Purchase icon: derived from the NAME (no stored image), always returns something ---- */
const QI=[[/bread|bakery|toast|خبز|عيش|توست|فينو|مخبز/i,'🍞'],[/chicken|poultry|فراخ|دجاج|فرخة/i,'🍗'],[/egg|بيض/i,'🥚'],[/fish|tuna|shrimp|سمك|جمبري|تونة/i,'🐟'],
[/milk|dairy|cheese|yogh?urt|لبن|حليب|جبن|زبادي/i,'🥛'],[/\brice\b|pasta|macaroni|noodle|أرز|ارز|\bرز\b|مكرونة|مكرونه/i,'🍚'],[/meat|beef|lamb|كفتة|لحم|لحمة|بانيه/i,'🥩'],
[/vegetable|\bveg\b|tomato|potato|onion|salad|خضار|خضروات|طماطم|بطاطس|بصل|خيار/i,'🥬'],[/fruit|apple|banana|orange|mango|فاكهة|فواكه|تفاح|موز|برتقال|مانجو/i,'🍎'],
[/coffee|\btea\b|قهوة|شاي/i,'☕'],[/water|juice|soda|drink|مياه|مية|عصير|مشروب/i,'🥤'],[/\boil\b|sugar|salt|flour|زيت|سكر|ملح|دقيق/i,'🧂'],
[/soap|clean|detergent|صابون|منظف|نظافة/i,'🧼'],[/medic|pharm|دواء|علاج|صيدلية/i,'💊'],[/fuel|petrol|\bgas\b|taxi|uber|\bbus\b|بنزين|مواصلات|تاكسي/i,'🚗']];
const qicon=n=>{const s=String(n||'');for(const [r,e] of QI)if(r.test(s))return e;return'🛒'};
const api={cents,sign,effects,pendingEffects,balances,cairoYmd,addDays,periods,cairoStart,spendDeltas,num,qicon,classify,Queue,foreign,sync,MOVES:['withdraw','deposit','transfer']};
g.Core=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
