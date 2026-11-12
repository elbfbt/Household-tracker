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
/* what a queued operation IS, so an error is always attributed to the operation that actually failed */
function opKind(o){return o.op==='qi'?'qi':o.op==='del'?'del':o.op==='upd'?'upd':(o.type||'expense')}
function describe(o){const k=opKind(o),src=o.op==='del'||o.op==='upd'?(o.old||{}):o;
  return{qid:o.qid,kind:k,name:k==='qi'?o.name:(src.category||src.type||''),amount:k==='qi'?o.price:(o.op==='upd'&&o.patch&&o.patch.amount!=null?o.patch.amount:src.amount)}}
async function sync(q,uid,env){const res={synced:0,failed:0,conflict:0,stopped:null,errors:[],conflicts:[]};
  for(const id of q.all().map(x=>x.qid)){const o=q.all().find(x=>x.qid===id);if(!o||o.state!=='pending'||o.uid!==uid)continue;
    if(o.dep&&q.all().some(x=>x.qid===o.dep))continue;
    if(!env.online()){res.stopped='network';break}
    // a session lookup that FAILS (throws: offline / flaky network) is not the same as "signed out"
    let su;try{su=await env.sessionUid()}catch(e){res.stopped='network';break}
    if(su!==uid){res.stopped='auth';break}
    let r;try{r=await env.exec(o)}catch(e){r={error:e}}
    if(r.conflict){q.mark(o.qid,'conflict',r.message);res.conflict++;res.conflicts.push({...describe(o),message:r.message||''});continue}
    const k=classify(r.error,r.status);
    if(k==='ok'||k==='duplicate'){q.remove(o.qid);res.synced++;if(o.op==='upd'&&r.updated_at)q.rebase(o.id,r.updated_at);continue}
    if(k==='network'){q.bump(o.qid);res.stopped='network';break}
    if(k==='auth'){res.stopped='auth';break}
    const msg=String((r.error&&r.error.message)||r.error);q.mark(o.qid,'failed',msg);res.errors.push({...describe(o),message:msg});res.failed++}
  return res}
/* ---- Quick Purchases: built-in catalog (key, English, Arabic, emoji, group, suggested price, other spellings) ----
   A built-in item is identified by its KEY and shown in the UI language. A custom item has no key and is ALWAYS
   shown exactly as the user typed it (never translated). The icon is: explicit choice > catalog > closest match > cart. */
const CATALOG=[
['bread','Bread','خبز','🍞','bread',20,'bakery|toast|baladi|عيش|فينو|توست'],
['tomatoes','Tomatoes','طماطم','🍅','veg',15,'tomato|قوطه'],['potatoes','Potatoes','بطاطس','🥔','veg',20,'potato|بطاطا'],['onions','Onions','بصل','🧅','veg',20,'onion'],
['cucumbers','Cucumbers','خيار','🥒','veg',20,'cucumber'],['carrots','Carrots','جزر','🥕','veg',20,'carrot'],['green_peppers','Green Peppers','فلفل أخضر','🫑','veg',30,'green pepper|peppers|pepper|فلفل'],
['eggplant','Eggplant','باذنجان','🍆','veg',20,'eggplants|aubergine|بتنجان'],['zucchini','Zucchini','كوسة','🥒','veg',30,'courgette|كوسا'],['molokhia','Molokhia','ملوخية','🌿','veg',20,'mulukhiyah|molokhiya'],
['lettuce','Lettuce','خس','🥬','veg',15,''],['cabbage','Cabbage','كرنب','🥬','veg',25,'ملفوف'],['garlic','Garlic','ثوم','🧄','veg',30,'توم'],['peas','Peas','بسلة','🫛','veg',50,'pea|بازلاء'],
['green_beans','Green Beans','فاصوليا خضراء','🫛','veg',40,'green bean|فاصوليا'],['spinach','Spinach','سبانخ','🌿','veg',20,''],
['bananas','Bananas','موز','🍌','fruit',35,'banana'],['apples','Apples','تفاح','🍎','fruit',70,'apple'],['oranges','Oranges','برتقال','🍊','fruit',25,'orange'],['mandarins','Mandarins','يوسفي','🍊','fruit',30,'mandarin|tangerine|tangerines|يوسف افندي'],
['mango','Mango','مانجو','🥭','fruit',60,'mangoes|mangos|مانجا|منجه'],['grapes','Grapes','عنب','🍇','fruit',60,'grape'],['guava','Guava','جوافة','🍐','fruit',35,'guavas'],['strawberries','Strawberries','فراولة','🍓','fruit',50,'strawberry'],
['watermelon','Watermelon','بطيخ','🍉','fruit',80,'watermelons'],['cantaloupe','Cantaloupe','شمام','🍈','fruit',50,'melon|كانتلوب'],['peaches','Peaches','خوخ','🍑','fruit',60,'peach'],['pomegranates','Pomegranates','رمان','❤️','fruit',50,'pomegranate'],
['chicken','Chicken','فراخ','🍗','food',180,'poultry|دجاج|فرخه|بانيه'],['meat','Meat','لحمة','🥩','food',300,'beef|lamb|لحم|كفته'],['fish','Fish','سمك','🐟','food',250,'tuna|shrimp|جمبري|تونه|بلطي'],['eggs','Eggs','بيض','🥚','food',60,'egg'],
['milk','Milk','لبن','🥛','food',50,'dairy|حليب'],['cheese','Cheese','جبنة','🧀','food',80,'جبن'],['yogurt','Yogurt','زبادي','🥛','food',15,'yoghurt'],['rice','Rice','رز','🍚','food',40,'ارز'],
['pasta','Pasta','مكرونة','🍝','food',25,'macaroni|noodles|noodle|spaghetti|معكرونه'],['lentils','Lentils','عدس','🫘','food',60,'lentil'],['beans','Beans','فول','🫘','food',20,'fava|foul'],
['cooking_oil','Cooking Oil','زيت','🫗','food',90,'oil'],['sugar','Sugar','سكر','🧂','food',40,''],['flour','Flour','دقيق','🌾','food',30,'طحين'],
// seeded by older versions; kept so they stay translated and keep an icon (not offered in the picker)
['vegetables','Vegetables','خضار','🥬','legacy',60,'vegetable|veg|خضروات'],['fruits','Fruits','فاكهة','🍎','legacy',80,'fruit|فواكه'],['other_groceries','Other groceries','بقالة أخرى','🛒','legacy',50,'groceries|grocery|بقاله']
].map(([key,en,ar,emoji,group,price,alt])=>({key,en,ar,emoji,group,price,alt:alt?alt.split('|'):[]}));
// compare names loosely: case, Arabic diacritics / alef / ta-marbuta / ya variants, leading "al-"
const norm=s=>String(s==null?'':s).toLowerCase().replace(/[\u064B-\u0652\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^a-z0-9\u0621-\u064A]+/g,' ').trim().split(' ').map(w=>w.replace(/^ال(?=..)/,'')).join(' ');
const BYKEY={},EXACT={},WORDS=[];
CATALOG.forEach(c=>{BYKEY[c.key]=c;[c.en,c.ar].forEach(n=>{EXACT[norm(n)]=c});[c.en,c.ar,...c.alt].forEach(n=>WORDS.push([' '+norm(n)+' ',c]))});
WORDS.sort((a,b)=>b[0].length-a[0].length);                      // "green beans" before "beans"
const catByKey=k=>BYKEY[k]||null;
const catByName=n=>EXACT[norm(n)]||null;                         // exact built-in name (either language)
const catGuess=n=>{const s=' '+norm(n)+' ';if(s==='  ')return null;if(EXACT[s.trim()])return EXACT[s.trim()];for(const [w,c] of WORDS)if(s.includes(w))return c;return null};
const QI=[[/coffee|\btea\b|قهوة|شاي/i,'☕'],[/water|juice|soda|drink|مياه|مية|عصير|مشروب/i,'🥤'],[/\bsalt\b|spice|ملح|بهارات|توابل/i,'🧂'],
[/soap|clean|detergent|shampoo|صابون|منظف|نظافة|شامبو/i,'🧼'],[/medic|pharm|دواء|علاج|صيدلية/i,'💊'],[/fuel|petrol|\bgas\b|taxi|uber|\bbus\b|بنزين|مواصلات|تاكسي/i,'🚗'],
[/sweet|candy|chocolate|biscuit|cake|حلويات|شوكولاتة|بسكويت|كيك/i,'🍫'],[/butter|ghee|زبدة|سمنة|سمن/i,'🧈'],[/diaper|baby|حفاضات|بامبرز/i,'🍼'],[/bill|electric|internet|phone|فاتورة|كهرباء|نت|رصيد/i,'🧾']];
/* item = a quick_items row ({name,key,icon}) or just a name. Never returns an empty icon. */
const qicon=x=>{const it=x&&typeof x==='object'?x:{name:x};if(it.icon&&String(it.icon).trim())return String(it.icon).trim();
  const c=(it.key&&BYKEY[it.key])||catGuess(it.name);if(c)return c.emoji;const s=String(it.name||'');for(const [r,e] of QI)if(r.test(s))return e;return'🛒'};
/* which built-in (if any) a stored row is. Rows from before migration 009 have no "key" column at all: there the
   original seeded English names are the built-ins. A row WITH the column and key=null is custom -> never translated. */
const qbuiltin=it=>!it?null:it.key?(BYKEY[it.key]||null):('key' in it?null:(()=>{const c=EXACT[norm(it.name)];return c&&c.en===String(it.name)?c:null})());
const qname=(it,lang)=>{const c=qbuiltin(it);return c?(lang==='ar'?c.ar:c.en):String((it&&it.name)||'')};
/* a transaction's category is stored text; built-in purchases store the catalog's English name -> show it localized */
const catLabel=(cat,lang)=>{if(lang!=='ar')return String(cat||'');const c=EXACT[norm(cat)];return c&&c.en===String(cat)?c.ar:String(cat||'')};
const api={cents,sign,effects,pendingEffects,balances,cairoYmd,addDays,periods,cairoStart,spendDeltas,num,qicon,qname,qbuiltin,catLabel,catByKey,catByName,catGuess,CATALOG,norm,classify,Queue,foreign,sync,opKind,describe,MOVES:['withdraw','deposit','transfer']};
g.Core=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
