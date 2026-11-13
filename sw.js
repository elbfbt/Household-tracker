const C='ht-v11',SHELL=['./','index.html','core.js','config.js','manifest.json','icon-192.png','icon-180.png'];
// optional files: a missing/unreachable one must never make the whole install (= offline support) fail
const OPT=['supabase.min.js','icon-512.png'];
const LIBS=['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js','https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all([c.addAll(SHELL),...OPT.map(u=>c.add(u).catch(()=>{})),...LIBS.map(u=>fetch(u,{mode:'no-cors'}).then(r=>c.put(u,r)).catch(()=>{}))])));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
const put=(q,r)=>{if(r.ok||r.type==='opaque'){const cp=r.clone();caches.open(C).then(c=>c.put(q,cp))}return r};
self.addEventListener('fetch',e=>{
  const q=e.request,u=new URL(q.url);
  // never touch or cache the API, or anything belonging to OneSignal push (its SDK, API and its own worker in /push/):
  // those must always come fresh from the network. Push itself is handled by push/onesignal/OneSignalSDKWorker.js.
  if(q.method!=='GET'||u.hostname.endsWith('supabase.co')||/(^|\.)onesignal\.com$/.test(u.hostname)||(u.origin===location.origin&&u.pathname.includes('/push/onesignal/')))return;
  if(u.origin!==location.origin)return e.respondWith(caches.match(q).then(m=>m||fetch(q).then(r=>put(q,r))));
  // same origin: answer from the cache at once (instant start, works offline) and refresh the cache in the background.
  // Only a failed page NAVIGATION falls back to the cached app; a missing script must fail as a script, not as HTML.
  e.respondWith(caches.match(q,{ignoreSearch:true}).then(m=>{const n=fetch(q).then(r=>put(q,r)).catch(x=>{if(m)return m;if(q.mode==='navigate')return caches.match('index.html');throw x});if(m){e.waitUntil(n.catch(()=>{}));return m}return n}));
});
