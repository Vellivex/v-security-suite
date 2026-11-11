import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {installOfflineTools} from '../web/offline.js';
import {makeWorker} from '../server/handler.js';import {page,notFound} from '../server/pages.js';
import {createHash} from 'node:crypto';import {offlineRelease} from '../scripts/offline-release.mjs';
const template=await readFile(new URL('../web/sw.js',import.meta.url),'utf8');
const integrity='sha256-'+createHash('sha256').update('source').digest('base64');
const headerWorker=makeWorker(page,notFound,{'/app.js':{body:'source',type:'text/javascript; charset=utf-8'}});
const expectedHeaders=Object.fromEntries(await Promise.all(['/app.js','/apps/vault','/apps/relay','/apps/cipher/vault','/apps/cipher/relay'].map(async path=>[path,Object.fromEntries((await headerWorker.fetch(new Request('https://v.test'+path),{})).headers)])));

function runtime({cached=false,failDownload=false,document=false,damaged=false}={}){
 const events={},calls=[],deleted=[];let response=cached?new Response(damaged?'damaged':'source'):undefined;
 const cache={async match(){return response;},async put(path,value){response=value;}};
 const self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};
 const RequestAtOrigin=class extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-test').replace('__ASSET_MANIFEST__',JSON.stringify([{url:document?'/apps/vault':'/app.js',headers:expectedHeaders[document?'/apps/vault':'/app.js'],...(document?{source:'/offline/vault',type:'text/html; charset=utf-8'}:{}),integrity}])),{self,caches:{async has(){return cached;},async open(){return cache;},async delete(name){deleted.push(name);},async keys(){return ['v-tools-test'];}},Request:RequestAtOrigin,Response,Headers,URL,crypto,btoa,fetch:async request=>{calls.push(request);return new Response('source',{status:failDownload?503:200,headers:{'Content-Type':'text/plain','Content-Security-Policy':"connect-src 'none'",'X-Vellivex-App-Access':'verified'}});}});
 return {events,calls,deleted};
}
test('offline cache miss returns an error without loading replacement network code',async()=>{const r=runtime();let response;r.events.fetch({request:new Request('https://v.test/app.js'),respondWith(promise){response=promise;}});assert.equal((await response).status,503);assert.equal(r.calls.length,0);});
test('offline installation pins asset integrity and removes a partial failed cache',async()=>{const r=runtime({failDownload:true});let work;r.events.install({waitUntil(promise){work=promise;}});await assert.rejects(work);assert.equal(r.calls[0].integrity,integrity);assert.equal(r.calls[0].redirect,'error');assert.equal(r.calls[0].credentials,'same-origin');assert.equal(r.calls[0].referrerPolicy,'no-referrer');assert.deepEqual(r.deleted,['v-tools-test']);});
test('only integrity-checked canonical text becomes the offline HTML document',async()=>{const r=runtime({document:true});let work,response;r.events.install({waitUntil(promise){work=promise;}});await work;assert.equal(r.calls[0].url,'https://v.test/offline/vault');r.events.fetch({request:new Request('https://v.test/apps/vault'),respondWith(promise){response=promise;}});const document=await response;assert.equal(await document.text(),'source');assert.equal(document.headers.get('Content-Type'),'text/html; charset=utf-8');assert.equal(document.headers.get('Content-Security-Policy'),expectedHeaders['/apps/vault']['content-security-policy']);});
function worker(state){const value=new EventTarget();value.state=state;value.change=state=>{value.state=state;value.dispatchEvent(new Event('statechange'));};return value;}
test('first offline installation waits for file checks without racing update()',async()=>{const installing=worker('installing');let updates=0;const pending=installOfflineTools({async register(){return {installing,async update(){updates++;}};}});await Promise.resolve();installing.change('installed');assert.deepEqual(await pending,{waiting:true,unchanged:false});assert.equal(updates,0);});
test('a rejected offline installation reports failure instead of installed success',async()=>{const installing=worker('installing');const pending=installOfflineTools({async register(){return {installing};}});await Promise.resolve();installing.change('redundant');await assert.rejects(pending,/file checks/);});
test('an existing installation waits for its update and reports the waiting worker',async()=>{const installing=worker('installing'),registration={active:worker('activated'),async update(){this.installing=installing;}};const pending=installOfflineTools({async register(){return registration;}});await Promise.resolve();await Promise.resolve();installing.change('installed');assert.deepEqual(await pending,{waiting:true,unchanged:false});});
test('worker-only changes cannot reuse and delete the active release cache',async()=>{
 const manifest=[{url:'/app.js',headers:expectedHeaders['/app.js'],integrity}],old=offlineRelease(manifest,template),next=offlineRelease(manifest,template+'\n// worker-only update');assert.notEqual(old.cacheId,next.cacheId);assert.equal(old.cacheId,offlineRelease(manifest,template).cacheId);
 const names=new Map([[old.cacheId,new Map([['/app.js',new Response('source')]])]]),deleted=[],events={};const self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};class OriginRequest extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}}
 const caches={async has(name){return names.has(name);},async open(name){if(!names.has(name))names.set(name,new Map());const values=names.get(name);return {async match(path){return values.get(path);},async put(path,value){values.set(path,value);}};},async delete(name){deleted.push(name);return names.delete(name);}};
 vm.runInNewContext(next.source,{self,caches,Request:OriginRequest,Response,Headers,URL,crypto,btoa,fetch:async()=>new Response('failed update',{status:503})});let work;events.install({waitUntil(value){work=value;}});await assert.rejects(work);assert.deepEqual(deleted,[next.cacheId]);assert.equal(await names.get(old.cacheId).get('/app.js').text(),'source');
});
test('offline release generation rejects truncated transfer output and incomplete policy',()=>{
 const valid={url:'/app.js',headers:expectedHeaders['/app.js'],integrity};
 for(const manifest of [[],[valid,'--- TRUNCATED --- 4 more items'],[{...valid,headers:{...valid.headers,'content-security-policy':"default-src 'none'; --- TRUNCATED --- 245 chars"}}],[{...valid,headers:{'content-type':'text/javascript'}}],[valid,valid],[{...valid,source:'https://elsewhere.test/app.js'}],[{...valid,integrity:'sha256-incomplete'}]])assert.throws(()=>offlineRelease(manifest,template),/Offline manifest/);
 assert.throws(()=>offlineRelease([valid],template.replace('__ASSET_MANIFEST__','[]')),/template placeholders/);
 assert.throws(()=>offlineRelease([valid],template+'__CACHE_ID__'),/template placeholders/);
});
test('reinstall verifies an existing release without rewriting or deleting its cache',async()=>{const valid=runtime({cached:true,failDownload:true});let work;valid.events.install({waitUntil(value){work=value;}});await work;assert.equal(valid.calls.length,0);assert.deepEqual(valid.deleted,[]);const damaged=runtime({cached:true,damaged:true});damaged.events.install({waitUntil(value){work=value;}});await assert.rejects(work,/integrity/);assert.equal(damaged.calls.length,0);assert.deepEqual(damaged.deleted,[]);});

test('unchanged active worker does not claim its cache was reverified',async()=>{const active=worker('activated');const result=await installOfflineTools({async register(){return {active,async update(){}};}});assert.deepEqual(result,{waiting:false,unchanged:true});});

test('post-install cache corruption cannot become executable offline code',async()=>{const r=runtime({cached:true,damaged:true});let pending;r.events.fetch({request:new Request('https://v.test/app.js'),respondWith(value){pending=value;}});const response=await pending;assert.equal(response.status,503);assert.ok(!(await response.text()).includes('damaged'));assert.equal(r.calls.length,0);});

test('corrupted offline HTML is refused and a valid script retains its verified body',async()=>{
 for(const document of [false,true]){const r=runtime({cached:true,damaged:true,document});let pending;r.events.fetch({request:new Request('https://v.test'+(document?'/apps/vault':'/app.js')),respondWith(p){pending=p;}});assert.equal((await pending).status,503);assert.equal(r.calls.length,0);}
 const r=runtime({cached:true});let pending;r.events.fetch({request:new Request('https://v.test/app.js?ignored-query=1'),respondWith(p){pending=p;}});const response=await pending;assert.equal(response.status,200);assert.equal(await response.text(),'source');assert.equal(r.calls.length,0);
});

test('cache open, lookup, clone, body and digest failures all fail closed without network fallback',async()=>{
 for(const fault of ['open','match','clone','body','digest','status']){
  const events={};let network=0;
  const response={ok:fault!=='status',clone(){if(fault==='clone')throw Error('synthetic clone failure');return {async arrayBuffer(){if(fault==='body')throw Error('synthetic body failure');return new TextEncoder().encode('source').buffer;}};}};
  const cache={async match(){if(fault==='match')throw Error('synthetic match failure');return response;}};
  const self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};
  const testCrypto={subtle:{async digest(...args){if(fault==='digest')throw Error('synthetic digest failure');return crypto.subtle.digest(...args);}}};
  vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-fault').replace('__ASSET_MANIFEST__',JSON.stringify([{url:'/app.js',headers:expectedHeaders['/app.js'],integrity}])),{self,caches:{async open(){if(fault==='open')throw Error('synthetic storage failure');return cache;}},crypto:testCrypto,URL,Response,btoa,fetch(){network++;throw Error('unexpected network');}});
  let pending;events.fetch({request:new Request('https://v.test/app.js'),respondWith(p){pending=p;}});
  const result=await pending;assert.equal(result.status,503,fault);assert.equal(result.headers.get('Cache-Control'),'no-store');assert.ok(!(await result.text()).includes('synthetic'));assert.equal(network,0);
 }
});
test('offline worker does not intercept cross-origin, write-method or unknown-path requests',()=>{
 const r=runtime();for(const [url,method] of [['https://other.test/app.js','GET'],['https://v.test/app.js','POST'],['https://v.test/private-report','GET']]){
  let intercepted=false;r.events.fetch({request:new Request(url,{method}),respondWith(){intercepted=true;}});assert.equal(intercepted,false);
 }assert.equal(r.calls.length,0);
});
test('offline activation removes retired tool caches while retaining current and unrelated caches',async()=>{
 const events={},deleted=[];const self={addEventListener(type,fn){events[type]=fn;}};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-current').replace('__ASSET_MANIFEST__','[]'),{self,Response,caches:{async keys(){return ['v-tools-current','v-tools-retired','unrelated-cache'];},async delete(name){deleted.push(name);}}});
 let work;events.activate({waitUntil(p){work=p;}});await work;assert.deepEqual(deleted,['v-tools-retired']);
});

async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
function deadlineClock(){let id=0;const jobs=new Map();return {jobs,schedule(fn,ms){const key=++id;jobs.set(key,{fn,ms});return key;},cancel(key){jobs.delete(key);},expire(){const pending=[...jobs.values()];jobs.clear();for(const {fn} of pending)fn();}};}
for(const phase of ['register','update','install'])test(`offline ${phase} cannot outlive the total installation deadline`,async()=>{
 const clock=deadlineClock(),never=new Promise(()=>{}),installing=worker('installing');let updates=0;
 const registration={...(phase==='install'?{installing}:{active:worker('activated')}),async update(){updates++;return never;}};
 const pending=installOfflineTools({register:()=>phase==='register'?never:Promise.resolve(registration)},clock);
 await flush();assert.equal(clock.jobs.size,1,'the deadline covers every phase');assert.equal([...clock.jobs.values()][0].ms,30000);
 const rejected=assert.rejects(pending,/timed out/);clock.expire();await rejected;assert.equal(clock.jobs.size,0);assert.equal(updates,phase==='update'?1:0);
});
test('late registration after timeout cannot start an update or claim installation',async()=>{
 const clock=deadlineClock();let resolve,updates=0;const registration=new Promise(r=>resolve=r);
 const pending=installOfflineTools({register:()=>registration},clock);await flush();
 const rejected=assert.rejects(pending,/timed out/);clock.expire();await rejected;
 resolve({active:worker('activated'),async update(){updates++;}});await flush();assert.equal(updates,0);assert.equal(clock.jobs.size,0);
});
test('one deadline covers registration, update and settling and removes its worker listener',async()=>{
 const clock=deadlineClock();let register,update;const registrationWork=new Promise(r=>register=r),updateWork=new Promise(r=>update=r);
 const installing=worker('installing');let listeners=0;const add=installing.addEventListener.bind(installing),remove=installing.removeEventListener.bind(installing);
 installing.addEventListener=(...args)=>{listeners++;add(...args);};installing.removeEventListener=(...args)=>{listeners--;remove(...args);};
 const registration={active:worker('activated'),async update(){await updateWork;this.installing=installing;}};
 const pending=installOfflineTools({register:()=>registrationWork},clock);await flush();const first=[...clock.jobs.keys()][0];
 register(registration);await flush();assert.deepEqual([...clock.jobs.keys()],[first]);update();await flush();assert.deepEqual([...clock.jobs.keys()],[first]);assert.equal(listeners,1);
 const rejected=assert.rejects(pending,/timed out/);clock.expire();await rejected;assert.equal(listeners,0);installing.change('installed');await flush();assert.equal(clock.jobs.size,0);
});
test('late native registration or update rejections after timeout are consumed',async()=>{
 for(const phase of ['register','update']){
  const clock=deadlineClock();let reject;const native=new Promise((_,r)=>reject=r);
  const pending=installOfflineTools({register:()=>phase==='register'?native:Promise.resolve({active:worker('activated'),update:()=>native})},clock);
  await flush();const rejected=assert.rejects(pending,/timed out/);clock.expire();await rejected;
  reject(Error('Late native failure'));await flush();assert.equal(clock.jobs.size,0);
 }
});
test('successful offline completion clears its single deadline and state listener',async()=>{
 const clock=deadlineClock(),installing=worker('installing');let listeners=0;const add=installing.addEventListener.bind(installing),remove=installing.removeEventListener.bind(installing);
 installing.addEventListener=(...args)=>{listeners++;add(...args);};installing.removeEventListener=(...args)=>{listeners--;remove(...args);};
 const pending=installOfflineTools({register:async()=>({installing})},clock);await flush();assert.equal(clock.jobs.size,1);assert.equal(listeners,1);
 installing.change('installed');assert.deepEqual(await pending,{waiting:true,unchanged:false});assert.equal(clock.jobs.size,0);assert.equal(listeners,0);
});

for(const path of ['/app.js','/apps/vault','/apps/relay','/apps/cipher/vault','/apps/cipher/relay'])test(`header-only cache tampering cannot change offline policy or MIME for ${path}`,async()=>{
 const events={};let network=0;const headers={...expectedHeaders[path],'content-type':'text/html; charset=iso-8859-1','content-security-policy':"default-src * 'unsafe-inline'; connect-src *",'permissions-policy':'camera=*, microphone=*','cross-origin-opener-policy':'unsafe-none','cross-origin-resource-policy':'cross-origin','referrer-policy':'unsafe-url','x-content-type-options':'','refresh':'0;url=https://attacker.invalid/','content-disposition':'attachment; filename="poison.html"','content-encoding':'gzip'};
 const cached=new Response('source',{status:200,headers}),self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-headers').replace('__ASSET_MANIFEST__',JSON.stringify([{url:path,headers:expectedHeaders[path],integrity}])),{self,caches:{async open(){return {async match(){return cached;}};}},URL,Response,Headers,crypto,btoa,fetch(){network++;throw Error('Unexpected network');}});
 let pending;events.fetch({request:new Request('https://v.test'+path),respondWith(p){pending=p;}});const response=await pending;
 assert.equal(response.status,200);assert.equal(await response.text(),'source');assert.deepEqual(Object.fromEntries(response.headers),expectedHeaders[path]);assert.equal(network,0);
});
for(const headers of [undefined,{}, {'content-type':'text/javascript; charset=utf-8'}])test(`offline header metadata fails closed when ${headers===undefined?'missing':Object.keys(headers).length?'partial':'empty'}`,async()=>{
 const events={},self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};let network=0;
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-headers').replace('__ASSET_MANIFEST__',JSON.stringify([{url:'/app.js',headers,integrity}])),{self,caches:{async open(){return {async match(){return new Response('source');}};}},URL,Response,Headers,crypto,btoa,fetch(){network++;throw Error('Unexpected network');}});
 let pending;events.fetch({request:new Request('https://v.test/app.js'),respondWith(p){pending=p;}});const response=await pending;assert.equal(response.status,503);assert.equal(network,0);
});
test('new offline installation discards transport headers and caches only pinned policy',async()=>{
 const events={},saved=new Map(),self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};class OriginRequest extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}}
 const file={url:'/apps/cipher/vault',source:'/offline/cipher/vault',headers:expectedHeaders['/apps/cipher/vault'],integrity};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-headers').replace('__ASSET_MANIFEST__',JSON.stringify([file])),{self,caches:{async has(){return false;},async open(){return {async put(path,response){saved.set(path,response);}};},async delete(){throw Error('Unexpected delete');}},URL,Request:OriginRequest,Response,Headers,crypto,btoa,fetch:async()=>new Response('source',{headers:{'content-type':'text/plain','content-security-policy':"connect-src *",'refresh':'0;url=https://attacker.invalid/','X-Vellivex-App-Access':'verified'}})});
 let pending;events.install({waitUntil(p){pending=p;}});await pending;const response=saved.get(file.url);assert.equal(await response.text(),'source');assert.deepEqual(Object.fromEntries(response.headers),file.headers);
});
test('new offline installation independently rejects bytes that violate the manifest hash',async()=>{
 const events={},saved=[],deleted=[],self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};class OriginRequest extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}}
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-headers').replace('__ASSET_MANIFEST__',JSON.stringify([{url:'/app.js',headers:expectedHeaders['/app.js'],integrity}])),{self,caches:{async has(){return false;},async open(){return {async put(...args){saved.push(args);}};},async delete(name){deleted.push(name);}},URL,Request:OriginRequest,Response,Headers,crypto,btoa,fetch:async()=>new Response('wrong bytes')});
 let pending;events.install({waitUntil(p){pending=p;}});await assert.rejects(pending,/integrity/);assert.equal(saved.length,0);assert.deepEqual(deleted,['v-tools-headers']);
});

function accessRuntime({online=true,network=async()=>new Response('live tool',{headers:{'X-Vellivex-App-Access':'verified'}}),cached='source',path='/apps/vault'}={}){
 const events={},calls=[],writes=[],deleted=[],timers=new Map();let timerId=0;
 const self={location:{origin:'https://v.test'},navigator:{onLine:online},addEventListener(type,fn){events[type]=fn;}};
 class OriginRequest extends Request{constructor(input,options){super(typeof input==='string'?new URL(input,self.location.origin):input,options);}}
 const file={url:path,source:path.replace('/apps/','/offline/'),headers:expectedHeaders[path],integrity};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-access').replace('__ASSET_MANIFEST__',JSON.stringify([file])),{
  self,URL,Request:OriginRequest,Response,Headers,crypto,btoa,AbortController,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
  caches:{async has(){return false;},async open(){return {async match(){return cached===undefined?undefined:new Response(cached);},async put(url,response){writes.push({url,response});}};},async delete(name){deleted.push(name);}},
  async fetch(request){calls.push(request);return network(request);}
 });
 return {calls,writes,deleted,timers,async navigate(){const request=new Request('https://v.test'+path);Object.defineProperty(request,'mode',{value:'navigate'});let pending;events.fetch({request,respondWith(value){pending=value;}});return pending;},async install(){let pending;events.install({waitUntil(value){pending=value;}});return pending;}};
}
for(const path of ['/apps/vault','/apps/relay','/apps/cipher/vault','/apps/cipher/relay'])test(`online ${path} navigation checks access before returning pinned offline HTML`,async()=>{
 const r=accessRuntime({path});const response=await r.navigate();
 assert.equal(response.status,200);assert.equal(await response.text(),'source');assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,'https://v.test'+path);
 assert.equal(r.calls[0].credentials,'same-origin');assert.equal(r.calls[0].cache,'no-store');assert.equal(r.calls[0].redirect,'manual');assert.equal(r.calls[0].referrerPolicy,'no-referrer');
 assert.equal(response.headers.get('Content-Security-Policy'),expectedHeaders[path]['content-security-policy']);assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'none'/);assert.equal(r.writes.length,0);assert.equal(r.timers.size,0);
});
test('expired app login returns fresh gate HTML and never caches it over the offline tool',async()=>{
 const r=accessRuntime({network:async()=>new Response('<p>Sign in</p>',{headers:{'X-Vellivex-App-Access':'required','Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=86400'}})});
 const response=await r.navigate();assert.equal(response.status,200);assert.equal(await response.text(),'<p>Sign in</p>');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(r.writes.length,0);assert.deepEqual(r.deleted,[]);
});
for(const status of [401,403,429,500,503])test(`online HTTP ${status} cannot fall back to a cached signed-in tool`,async()=>{
 const r=accessRuntime({network:async()=>new Response('denied',{status,headers:{'X-Vellivex-App-Access':'verified'}})});
 const response=await r.navigate();assert.equal(response.status,503);assert.match(await response.text(),/could not check your sign-in/);assert.equal(r.writes.length,0);assert.deepEqual(r.deleted,[]);
});
for(const fault of ['no marker','unknown marker','redirect','network failure','gate without HTML'])test(`online ${fault} fails closed without deleting an existing offline installation`,async()=>{
 const r=accessRuntime({network:async()=>{
  if(fault==='network failure')throw TypeError('network unavailable');
  if(fault==='redirect')return new Response(null,{status:302,headers:{Location:'https://other.test/access'}});
  return new Response('untrusted',{headers:{...(fault==='unknown marker'?{'X-Vellivex-App-Access':'unknown'}:fault==='gate without HTML'?{'X-Vellivex-App-Access':'required'}:{})}});
 }});const response=await r.navigate();assert.equal(response.status,503);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(r.writes.length,0);assert.deepEqual(r.deleted,[]);assert.equal(r.timers.size,0);
});
test('a stalled online access check is aborted and never returns cached tool HTML',async()=>{
 const r=accessRuntime({network:request=>new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError'))))});
 const pending=r.navigate();assert.equal(r.timers.size,1);const timer=[...r.timers.values()][0];assert.equal(timer.ms,10000);timer.fn();const response=await pending;assert.equal(response.status,503);assert.equal(r.timers.size,0);
});
test('explicit offline mode retains verified pinned tools without attempting account requests',async()=>{
 const r=accessRuntime({online:false});const response=await r.navigate();assert.equal(response.status,200);assert.equal(await response.text(),'source');assert.equal(r.calls.length,0);assert.equal(r.writes.length,0);assert.deepEqual(r.deleted,[]);
});
test('explicit offline mode still rejects a tampered cached document',async()=>{
 const r=accessRuntime({online:false,cached:'tampered'});const response=await r.navigate();assert.equal(response.status,503);assert.equal(r.calls.length,0);
});
for(const marker of [undefined,'required','unexpected'])test(`new offline HTML installation rejects ${marker??'missing'} app-access admission even for the expected body hash`,async()=>{
 const r=accessRuntime({network:async()=>new Response('source',{headers:marker?{'X-Vellivex-App-Access':marker}:{}})});await assert.rejects(r.install(),/Sign in/);assert.equal(r.calls[0].credentials,'same-origin');assert.equal(r.calls[0].url,'https://v.test/offline/vault');assert.equal(r.writes.length,0);assert.deepEqual(r.deleted,['v-tools-access']);
});
test('a newly verified offline installation stores only pinned bytes and excludes access metadata',async()=>{
 const r=accessRuntime({network:async()=>new Response('source',{headers:{'X-Vellivex-App-Access':'verified','Content-Type':'text/plain','Set-Cookie':'secret=never-cache'}})});await r.install();assert.equal(r.writes.length,1);const response=r.writes[0].response;assert.equal(await response.text(),'source');assert.equal(response.headers.get('X-Vellivex-App-Access'),null);assert.equal(response.headers.get('Set-Cookie'),null);assert.deepEqual(Object.fromEntries(response.headers),expectedHeaders['/apps/vault']);
});
test('a repeated installation of the exact verified release preserves offline HTML without an online session',async()=>{
 const r=runtime({cached:true,document:true,failDownload:true});let work;r.events.install({waitUntil(value){work=value;}});await work;assert.equal(r.calls.length,0);assert.deepEqual(r.deleted,[]);
});
test('a denied later document removes the entire new partial installation and retains the older release',async()=>{
 const events={},current='v-tools-new-access',older='v-tools-old-access',stores=new Map([[older,new Map([['/apps/vault',new Response('older verified source')]])]]),deleted=[];
 const manifest=['/apps/vault','/apps/relay'].map(url=>({url,source:url.replace('/apps/','/offline/'),headers:expectedHeaders[url],integrity}));
 const self={location:{origin:'https://v.test'},addEventListener(type,listener){events[type]=listener;}};
 class OriginRequest extends Request{constructor(input,options){super(new URL(input,self.location.origin),options);}}
 vm.runInNewContext(template.replace('__CACHE_ID__',current).replace('__ASSET_MANIFEST__',JSON.stringify(manifest)),{self,URL,Request:OriginRequest,Response,Headers,crypto,btoa,caches:{async has(name){return stores.has(name);},async open(name){if(!stores.has(name))stores.set(name,new Map());return {async put(path,response){stores.get(name).set(path,response);}};},async delete(name){deleted.push(name);return stores.delete(name);}},fetch:async request=>new Response('source',{headers:{'X-Vellivex-App-Access':request.url.endsWith('/vault')?'verified':'required'}})});
 let pending;events.install({waitUntil(value){pending=value;}});await assert.rejects(pending,/Sign in/);assert.deepEqual(deleted,[current]);assert.equal(stores.has(current),false);assert.equal(await stores.get(older).get('/apps/vault').text(),'older verified source');
});
