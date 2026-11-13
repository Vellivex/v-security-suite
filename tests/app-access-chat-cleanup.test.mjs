// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createChatSessionOverride} from '../server/app-access/patch-chat.mjs';
const baseline=readFileSync(new URL('./fixtures/app-access/public-session-baseline.mjs',import.meta.url),'utf8');
const source=createChatSessionOverride(baseline)['/public-session.mjs'].body;
function clientRelease(timers={setTimeout,clearTimeout}){const context=vm.createContext({ChatSession:class {},AbortController,TextDecoder,Response,...timers});vm.runInContext(source.replace(/^import .*;\n/gm,'').replaceAll('export ','')+'\nglobalThis.release=release;',context);return context.release;}
const release=clientRelease();
const request={room:'fixture-room',token:'fixture-token',role:'host',alreadyCleared:false};
const ok=()=>new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
const check=test;
await check('transient network retry succeeds and preserves authenticated options',async()=>{let calls=0;const r=await release(async(url,opts)=>{assert.equal(url,'/api/rooms/fixture-room');assert.equal(opts.method,'DELETE');assert.equal(opts.headers['X-Room-Token'],request.token);assert.equal(opts.headers['X-Room-Role'],'host');assert.equal(opts.credentials,'same-origin');if(++calls===1)throw TypeError('network');return ok()},request);assert.equal(r.acknowledged,true);assert.equal(calls,2);});
await check('gateway retry succeeds',async()=>{let calls=0;const r=await release(async()=>++calls===1?new Response('Unavailable',{status:503}):ok(),request);assert.equal(r.acknowledged,true);assert.equal(calls,2)});
await check('two failures are final',async()=>{let calls=0;const r=await release(async()=>{calls++;throw Error('network')},request);assert.equal(r.acknowledged,false);assert.equal(calls,2)});
await check('auth validation and throttling errors are not retried',async()=>{for(const status of [400,401,403,404,429]){let calls=0;const r=await release(async()=>{calls++;return new Response('{"error":"unavailable"}',{status,headers:{'Content-Type':'application/json'}})},request);assert.equal(r.acknowledged,false);assert.equal(calls,1)}});
await check('acknowledgement remains exact',async()=>{for(const body of [{ok:true,extra:true},{ok:false},{ok:1},{}]){let calls=0;const r=await release(async()=>{calls++;return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})},request);assert.equal(r.acknowledged,false);assert.equal(calls,1)}});
await check('non-JSON never claims cleanup',async()=>{let calls=0;const r=await release(async()=>{calls++;return new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}})},request);assert.equal(r.acknowledged,false);assert.equal(calls,1)});
await check('already-cleared and missing capability require no network',async()=>{let calls=0;const f=()=>{calls++;throw Error('must not fetch')};assert.equal((await release(f,{...request,alreadyCleared:true})).acknowledged,true);assert.equal((await release(f,{...request,token:null})).acknowledged,false);assert.equal(calls,0)});
await check('same total eight-second deadline aborts pending read',async()=>{const timers=new Map();let id=0,signal;const release=clientRelease({setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:id=>timers.delete(id)});const p=release((u,o)=>{signal=o.signal;return new Promise(()=>{})},request);const timer=[...timers.values()].find(t=>t.ms===8000);assert.ok(timer);timer.fn();assert.equal((await p).acknowledged,false);assert.equal(signal.aborted,true);assert.equal(timers.size,0)});
