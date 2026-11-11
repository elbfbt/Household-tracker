const C='ht-v5',SHELL=['./','index.html','core.js','config.js','manifest.json','icon-192.png','icon-180.png'];
const LIBS=['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js','https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all([c.addAll(SHELL),...LIBS.map(u=>fetch(u,{mode:'no-cors'}).then(r=>c.put(u,r)).catch(()=>{}))])));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
const put=(q,r)=>{if(r.ok||r.type==='opaque'){const cp=r.clone();caches.open(C).then(c=>c.put(q,cp))}return r};
self.addEventListener('fetch',e=>{
  const q=e.request,u=new URL(q.url);
  if(q.method!=='GET'||u.hostname.endsWith('supabase.co'))return;
  if(u.origin!==location.origin)return e.respondWith(caches.match(q).then(m=>m||fetch(q).then(r=>put(q,r))));
  e.respondWith(caches.match(q,{ignoreSearch:true}).then(m=>{const n=fetch(q).then(r=>put(q,r)).catch(()=>m||caches.match('index.html'));return m||n}));
});
