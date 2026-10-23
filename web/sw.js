// SPDX-License-Identifier: GPL-3.0-or-later
const CACHE='__CACHE_ID__';
const FILES=__ASSET_MANIFEST__;
async function verifiedResponse(response,file){
  if(!response?.ok)throw Error('Offline asset unavailable');
  // Body hashes do not cover response metadata. Only release-pinned headers
  // may set MIME, isolation, permissions or redirects for verified tool bytes.
  const headers=file.headers,required=['content-type','content-security-policy','x-content-type-options','referrer-policy','permissions-policy','x-frame-options','cross-origin-opener-policy','cross-origin-resource-policy','origin-agent-cluster','cache-control','strict-transport-security','x-robots-tag'];
  if(!headers||typeof headers!=='object'||Array.isArray(headers)||required.some(name=>typeof headers[name]!=='string'||!headers[name].trim()))throw Error('Offline response policy is incomplete');
  const bytes=await response.clone().arrayBuffer();
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  if('sha256-'+btoa(String.fromCharCode(...digest))!==file.integrity)throw Error('Offline file failed integrity check');
  return new Response(bytes,{status:200,headers});
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const existed=await caches.has(CACHE);
  const cache=await caches.open(CACHE);
  // A repeated installation of this exact release must never rewrite or delete
  // files that an existing controlled tab may still be using.
  if(existed){
    for(const file of FILES){
      await verifiedResponse(await cache.match(file.url),file);
    }
    return;
  }
  try{
    for(const file of FILES){
      const request=new Request(file.source||file.url,{integrity:file.integrity,cache:'reload',redirect:'error'});
      await cache.put(file.url,await verifiedResponse(await fetch(request),file));
    }
  }catch(error){if(!existed)await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('v-tools-')&&key!==CACHE).map(key=>caches.delete(key))))));
const unavailable=()=>new Response('Offline files failed verification or are incomplete. Save any encrypted files you need, close all Vellivex tool tabs, clear this site’s stored data in browser settings, then reopen online and enable offline use. Clearing site data removes offline files.',{status:503,headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  const file=FILES.find(file=>file.url===url.pathname);if(!file)return;
  event.respondWith((async()=>{
    try{
      const cache=await caches.open(CACHE);
      // Recheck bytes and reconstruct metadata on every read. Never return the
      // cached response object or trust headers left in mutable browser storage.
      return await verifiedResponse(await cache.match(file.url),file);
    }catch{return unavailable();}
  })());
});
