const CACHE_NAME='spm-v2-0-6-firebase-photo-resume';
const APP_SHELL=[
  './','./manifest.webmanifest',
  './icon-192-v15.png','./icon-512-v15.png',
  './applehead.svg','./kkokkoma.svg','./angel.svg'
];
self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  // index와 Firebase 동기화 코드는 항상 네트워크 최신본을 우선합니다.
  if(event.request.mode==='navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/firebase-sync.js')){
    event.respondWith(fetch(event.request,{cache:'no-store'}).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request.mode==='navigate'?'./index.html':event.request,copy));}
      return response;
    }).catch(()=>caches.match(event.request.mode==='navigate'?'./index.html':event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));}
    return response;
  })));
});
