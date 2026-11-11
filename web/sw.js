// SPDX-License-Identifier: GPL-3.0-or-later
const CACHE='__CACHE_ID__';
const FILES=__ASSET_MANIFEST__;
const ACCESS_HEADER='X-Vellivex-App-Access';
const isDocument=file=>file.headers?.['content-type']?.split(';')[0].trim().toLowerCase()==='text/html';
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
let installation=null;
function installPinnedFiles(){
  if(installation)return installation;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  installation=(async()=>{
  const existed=await caches.has(CACHE);
  const cache=await caches.open(CACHE);
  // A repeated installation of this exact release must never rewrite or delete
  // files that an existing controlled tab may still be using.
  if(existed){
    for(const file of FILES){
      await verifiedResponse(await cache.match(file.url),file);
      if(controller.signal.aborted)throw Error('Offline verification timed out');
    }
    return;
  }
  try{
    for(const file of FILES){
      const request=new Request(file.source||file.url,{integrity:file.integrity,cache:'reload',redirect:'error',credentials:'same-origin',referrerPolicy:'no-referrer',signal:controller.signal});
      const response=await fetch(request);
      if(isDocument(file)&&response.headers.get(ACCESS_HEADER)!=='verified')throw Error('Sign in before enabling offline use.');
      const verified=await verifiedResponse(response,file);
      if(controller.signal.aborted)throw Error('Offline verification timed out');
      await cache.put(file.url,verified);
    }
  }catch(error){if(!existed)await caches.delete(CACHE);throw error;}
  })().finally(()=>{clearTimeout(timer);installation=null;});
  return installation;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  // Updating an older controller must not depend on an app cookie: otherwise
  // anonymous users remain trapped behind the old cache-first controller.
  // Fresh offline installations still finish all authenticated file checks.
  if(!self.registration?.active)await installPinnedFiles();
  await self.skipWaiting?.();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  // Never erase a previous working offline release during a control upgrade.
  // Existing pages are not reloaded; their next navigation uses the new gate.
  await self.clients?.claim();
})()));
self.addEventListener('message',event=>{
  if(event.data?.type==='VELLIVEX_APP_ACCESS_POLICY'&&event.ports?.[0])event.ports[0].postMessage({version:'email-gate-v2'});
});
async function cachedFile(file){
  const available=await caches.keys();
  const names=[...available.filter(name=>name===CACHE),...available.filter(name=>name.startsWith('v-tools-')&&name!==CACHE)];
  for(const name of names){
    // Reconstruct pinned metadata and verify current release bytes even when
    // using an older cache. Mutable cache headers never establish trust.
    try{return await verifiedResponse(await (await caches.open(name)).match(file.url),file);}catch{}
  }
  throw Error('No verified offline copy');
}
const unavailable=()=>new Response('Offline files failed verification or are incomplete. Save any encrypted files you need, close all Vellivex tool tabs, clear this site’s stored data in browser settings, then reopen online and enable offline use. Clearing site data removes offline files.',{status:503,headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
const accessUnavailable=()=>new Response('Vellivex could not check your sign-in. Reconnect and try again. Your saved offline files have not been changed.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
const refreshing=()=>new Response('Offline files are being verified for this release. Keep this tab online, then reload. Your saved files have not been changed.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
async function documentAdmission(request){
  // A previously verified installation remains usable in explicit offline mode.
  // Online failures never silently turn into signed-in access or erase local data.
  if(self.navigator?.onLine===false)return null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(new Request(request,{credentials:'same-origin',cache:'no-store',redirect:'manual',referrerPolicy:'no-referrer',signal:controller.signal}));
    if(response.status!==200)return accessUnavailable();
    const access=response.headers.get(ACCESS_HEADER);
    if(access==='required'&&response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()==='text/html'){
      const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');
      return new Response(response.body,{status:200,headers});
    }
    try{response.body?.cancel().catch(()=>{});}catch{}
    return access==='verified'?null:accessUnavailable();
  }catch{return accessUnavailable();}
  finally{clearTimeout(timer);}
}
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  const file=FILES.find(file=>file.url===url.pathname);if(!file)return;
  event.respondWith((async()=>{
    if(isDocument(file)&&(event.request.mode==='navigate'||event.request.destination==='document')){
      const admission=await documentAdmission(event.request);if(admission)return admission;
      if(self.navigator?.onLine!==false){
        // Refresh in the background after admission. A slow asset must never
        // block a usable pinned legacy document or force a page reload.
        let cached;try{cached=await cachedFile(file);}catch{}
        event.waitUntil?.(installPinnedFiles().catch(()=>{}));
        return cached||refreshing();
      }
    }
    try{
      // Recheck bytes and reconstruct metadata on every read. Never return the
      // cached response object or trust headers left in mutable browser storage.
      return await cachedFile(file);
    }catch{return unavailable();}
  })());
});
