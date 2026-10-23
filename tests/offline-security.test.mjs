import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {installOfflineTools} from '../web/offline.js';
import {createHash} from 'node:crypto';import {offlineRelease} from '../scripts/offline-release.mjs';
const template=await readFile(new URL('../web/sw.js',import.meta.url),'utf8');
const integrity='sha256-'+createHash('sha256').update('source').digest('base64');
function runtime({cached=false,failDownload=false,document=false,damaged=false}={}){
 const events={},calls=[],deleted=[];let response=cached?new Response(damaged?'damaged':'source'):undefined;
 const cache={async match(){return response;},async put(path,value){response=value;}};
 const self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};
 const RequestAtOrigin=class extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-test').replace('__ASSET_MANIFEST__',JSON.stringify([{url:document?'/apps/vault':'/app.js',...(document?{source:'/offline/vault',type:'text/html; charset=utf-8'}:{}),integrity}])),{self,caches:{async has(){return cached;},async open(){return cache;},async delete(name){deleted.push(name);},async keys(){return ['v-tools-test'];}},Request:RequestAtOrigin,Response,Headers,URL,crypto,btoa,fetch:async request=>{calls.push(request);return new Response('source',{status:failDownload?503:200,headers:{'Content-Type':'text/plain','Content-Security-Policy':"connect-src 'none'"}});}});
 return {events,calls,deleted};
}
test('offline cache miss returns an error without loading replacement network code',async()=>{const r=runtime();let response;r.events.fetch({request:new Request('https://v.test/app.js'),respondWith(promise){response=promise;}});assert.equal((await response).status,503);assert.equal(r.calls.length,0);});
test('offline installation pins asset integrity and removes a partial failed cache',async()=>{const r=runtime({failDownload:true});let work;r.events.install({waitUntil(promise){work=promise;}});await assert.rejects(work);assert.equal(r.calls[0].integrity,integrity);assert.equal(r.calls[0].redirect,'error');assert.deepEqual(r.deleted,['v-tools-test']);});
test('only integrity-checked canonical text becomes the offline HTML document',async()=>{const r=runtime({document:true});let work,response;r.events.install({waitUntil(promise){work=promise;}});await work;assert.equal(r.calls[0].url,'https://v.test/offline/vault');r.events.fetch({request:new Request('https://v.test/apps/vault'),respondWith(promise){response=promise;}});const document=await response;assert.equal(await document.text(),'source');assert.equal(document.headers.get('Content-Type'),'text/html; charset=utf-8');assert.equal(document.headers.get('Content-Security-Policy'),"connect-src 'none'");});
function worker(state){const value=new EventTarget();value.state=state;value.change=state=>{value.state=state;value.dispatchEvent(new Event('statechange'));};return value;}
test('first offline installation waits for file checks without racing update()',async()=>{const installing=worker('installing');let updates=0;const pending=installOfflineTools({async register(){return {installing,async update(){updates++;}};}});await Promise.resolve();installing.change('installed');assert.deepEqual(await pending,{waiting:true,unchanged:false});assert.equal(updates,0);});
test('a rejected offline installation reports failure instead of installed success',async()=>{const installing=worker('installing');const pending=installOfflineTools({async register(){return {installing};}});await Promise.resolve();installing.change('redundant');await assert.rejects(pending,/file checks/);});
test('an existing installation waits for its update and reports the waiting worker',async()=>{const installing=worker('installing'),registration={active:worker('activated'),async update(){this.installing=installing;}};const pending=installOfflineTools({async register(){return registration;}});await Promise.resolve();await Promise.resolve();installing.change('installed');assert.deepEqual(await pending,{waiting:true,unchanged:false});});
test('worker-only changes cannot reuse and delete the active release cache',async()=>{
 const manifest=[{url:'/app.js',integrity}],old=offlineRelease(manifest,template),next=offlineRelease(manifest,template+'\n// worker-only update');assert.notEqual(old.cacheId,next.cacheId);assert.equal(old.cacheId,offlineRelease(manifest,template).cacheId);
 const names=new Map([[old.cacheId,new Map([['/app.js',new Response('source')]])]]),deleted=[],events={};const self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};class OriginRequest extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}}
 const caches={async has(name){return names.has(name);},async open(name){if(!names.has(name))names.set(name,new Map());const values=names.get(name);return {async match(path){return values.get(path);},async put(path,value){values.set(path,value);}};},async delete(name){deleted.push(name);return names.delete(name);}};
 vm.runInNewContext(next.source,{self,caches,Request:OriginRequest,Response,Headers,URL,crypto,btoa,fetch:async()=>new Response('failed update',{status:503})});let work;events.install({waitUntil(value){work=value;}});await assert.rejects(work);assert.deepEqual(deleted,[next.cacheId]);assert.equal(await names.get(old.cacheId).get('/app.js').text(),'source');
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
  vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-fault').replace('__ASSET_MANIFEST__',JSON.stringify([{url:'/app.js',integrity}])),{self,caches:{async open(){if(fault==='open')throw Error('synthetic storage failure');return cache;}},crypto:testCrypto,URL,Response,btoa,fetch(){network++;throw Error('unexpected network');}});
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
