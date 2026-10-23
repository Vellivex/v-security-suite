// SPDX-License-Identifier: GPL-3.0-or-later
const CACHE='__CACHE_ID__';
const FILES=__ASSET_MANIFEST__;
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const existed=await caches.has(CACHE);
  const cache=await caches.open(CACHE);
  // A repeated installation of this exact release must never rewrite or delete
  // files that an existing controlled tab may still be using.
  if(existed){
    for(const file of FILES){
      const saved=await cache.match(file.url);
      if(!saved?.ok)throw Error('Installed offline files are incomplete');
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',await saved.clone().arrayBuffer()));
      if('sha256-'+btoa(String.fromCharCode(...digest))!==file.integrity)throw Error('Installed offline file failed integrity check');
    }
    return;
  }
  try{
    for(const file of FILES){
      const request=new Request(file.source||file.url,{integrity:file.integrity,cache:'reload',redirect:'error'});
      const response=await fetch(request);if(!response.ok)throw Error('Offline asset unavailable');
      if(file.type){
        const headers=new Headers(response.headers);headers.set('Content-Type',file.type);
        await cache.put(file.url,new Response(await response.arrayBuffer(),{status:200,headers}));
      }else await cache.put(file.url,response);
    }
  }catch(error){if(!existed)await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('v-tools-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!FILES.some(file=>file.url===url.pathname))return;
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(response=>response||new Response('Offline files are incomplete. Save any encrypted files you need, close all Vellivex tool tabs, clear this site’s stored data in browser settings, then reopen online and enable offline use. Clearing site data removes offline files.',{status:503,headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}})));
});
