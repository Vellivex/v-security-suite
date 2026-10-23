// SPDX-License-Identifier: GPL-3.0-or-later
const CACHE='__CACHE_ID__';
const FILES=__ASSET_MANIFEST__;
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  try{
    for(const file of FILES){
      const request=new Request(file.url,{integrity:file.integrity,cache:'reload',redirect:'error'});
      const response=await fetch(request);if(!response.ok)throw Error('Offline asset unavailable');
      await cache.put(file.url,response);
    }
  }catch(error){await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('v-tools-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!FILES.some(file=>file.url===url.pathname))return;
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(response=>response||new Response('Offline files are incomplete. Close V tools and reinstall the offline files online.',{status:503,headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}})));
});
