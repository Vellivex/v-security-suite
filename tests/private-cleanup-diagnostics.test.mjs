// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createChatSessionOverride} from '../server/app-access/patch-chat.mjs';
import {createChatInvitationOverride} from '../server/app-access/patch-chat-invitations.mjs';
import {PRIVATE_CLEANUP_BASELINE_SHA256, PRIVATE_CLEANUP_REPLACEMENTS, patchPrivateCleanupDiagnostics, createPrivateCleanupDiagnostics} from '../server/app-access/patch-private-cleanup-diagnostics.mjs';

const read = name => readFileSync(new URL('./fixtures/app-access/' + name, import.meta.url), 'utf8');
const shared = createChatSessionOverride(read('public-session-baseline.mjs'));
const before = {...shared, ...createChatInvitationOverride('private', read('private-ui-baseline.mjs'))};
const moduleSource = 'export default ' + JSON.stringify(before) + ';\n';
const after = createPrivateCleanupDiagnostics(before);
const plain = value => JSON.parse(JSON.stringify(value));
const request = {room:'fixture-room',token:'fixture-capability',role:'host',alreadyCleared:false};
const ok = () => Response.json({ok:true});
function releaseClient(timers = {setTimeout,clearTimeout}) {
  const context = vm.createContext({ChatSession:class {},AbortController,TextDecoder,Response,...timers});
  vm.runInContext(after['/public-session.mjs'].body.replace(/^import .*;\n/gm,'').replaceAll('export ','')+'\nglobalThis.release=release;',context);
  return context.release;
}

test('only the exact Private module and its cleanup details can change', () => {
  assert.equal(createHash('sha256').update(moduleSource).digest('hex'), PRIVATE_CLEANUP_BASELINE_SHA256);
  let restored = patchPrivateCleanupDiagnostics(moduleSource);
  for (const [oldValue,newValue] of [...PRIVATE_CLEANUP_REPLACEMENTS].reverse()) {
    assert.equal(restored.split(newValue).length,2);restored=restored.replace(newValue,oldValue);
  }
  assert.equal(restored,moduleSource);
  assert.deepEqual(Object.keys(after),Object.keys(before));
  for (const path of Object.keys(after)) assert.equal(after[path].type,before[path].type);
  assert.equal(createChatSessionOverride(read('public-session-baseline.mjs'))['/public-session.mjs'].body,shared['/public-session.mjs'].body);
  for(const unexpected of [moduleSource+'\n',patchPrivateCleanupDiagnostics(moduleSource),'export default {};\n',null]) assert.throws(()=>patchPrivateCleanupDiagnostics(unexpected),/audited baseline/);
  assert.throws(()=>createPrivateCleanupDiagnostics({...shared,...createChatInvitationOverride('vkey',read('vkey-app-baseline.mjs'))}),/audited baseline/);
});

test('HTTP diagnostics preserve exact acknowledgement and never retain response content', async () => {
  const release=releaseClient();
  for(const status of [200,204,400,401,403,404,429,500]) {
    let calls=0;
    const result=await release(async()=>{calls++;return new Response(status===204?null:'{"error":"fixture-private-sentinel"}',{status,headers:{'Content-Type':'application/json'}});},request);
    assert.deepEqual(plain(result),{acknowledged:false,diagnostic:{phase:'response',status}});
    assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('sentinel'),false);
  }
  for(const body of [{ok:true,extra:true},{ok:1},{ok:false},{}]) assert.equal((await release(async()=>Response.json(body),request)).acknowledged,false);
  assert.deepEqual(plain(await release(async()=>ok(),request)),{acknowledged:true,diagnostic:{phase:'response',status:200}});
  const malformed=await release(async()=>new Response('<html>fixture-private-sentinel</html>',{headers:{'Content-Type':'text/html'}}),request);
  assert.deepEqual(plain(malformed),{acknowledged:false,diagnostic:{phase:'response',status:200}});
});

test('network failures and retry outcomes remain bounded and contain no native errors or capabilities', async () => {
  const release=releaseClient();let calls=0;
  const failed=await release(async(url,options)=>{calls++;assert.equal(options.method,'DELETE');assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-Room-Token'],request.token);assert.equal(options.headers['X-Room-Role'],request.role);assert.equal(options.keepalive,true);assert.equal(options.referrerPolicy,'no-referrer');throw new Error('fixture-private-sentinel '+url);},request);
  assert.equal(calls,2);assert.deepEqual(plain(failed),{acknowledged:false,diagnostic:{phase:'network'}});
  calls=0;
  const recovered=await release(async()=>{if(++calls===1)throw new Error('fixture-private-sentinel');return ok();},request);
  assert.equal(calls,2);assert.deepEqual(plain(recovered),{acknowledged:true,diagnostic:{phase:'response',status:200}});
  calls=0;
  const gateway=await release(async()=>new Response('fixture-private-sentinel',{status:++calls===1?502:503,headers:{'Content-Type':'text/plain'}}),request);
  assert.equal(calls,2);assert.deepEqual(plain(gateway),{acknowledged:false,diagnostic:{phase:'response',status:503}});
});

test('the original eight-second deadline reports only its phase and an already-received status', async () => {
  for(const receivedHeaders of [false,true]) {
    const timers=new Map();let id=0,signal;
    const release=releaseClient({setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
    const pending=release((_url,options)=>{signal=options.signal;return receivedHeaders?new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}}):new Promise(()=>{});},request);
    await Promise.resolve();await Promise.resolve();
    const deadline=[...timers.values()].find(t=>t.ms===8000);assert.ok(deadline);deadline.fn();
    const result=await pending;
    assert.deepEqual(plain(result),{acknowledged:false,diagnostic:{phase:'deadline',...(receivedHeaders?{status:200}:{})}});
    assert.equal(signal.aborted,true);assert.equal(timers.size,0);
  }
});

test('already-confirmed and missing-capability paths still make no request', async () => {
  let calls=0;const release=releaseClient(),fetcher=()=>{calls++;throw Error('unexpected');};
  assert.deepEqual(plain(await release(fetcher,{...request,alreadyCleared:true})),{acknowledged:true});
  assert.deepEqual(plain(await release(fetcher,{...request,token:null})),{acknowledged:false});assert.equal(calls,0);
});

function privateUI(cleanup) {
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,hidden:false,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},replaceChildren(){},append(){}});return nodes.get(id);};
  const document={hidden:false,getElementById:node,addEventListener(){}};
  const window={location:new URL('https://private.vellivex.com/live'),history:{replaceState(){}},addEventListener(){}};
  node('mode').value='chat';
  const context=vm.createContext({document,window,URL,URLSearchParams,TextEncoder,privateChatSession(){},privateVoiceCall(){},readInvitation(){}});
  vm.runInContext(after['/live/ui/live-ui.mjs'].body.replace(/^import .*;\n/gm,'').replace('export function mountLiveUI','function mountLiveUI')+'\nglobalThis.mount=mountLiveUI;globalThis.help=cleanupHelp;',context);
  const sessions=[];
  const handle=context.mount(document,window,{chatFactory:async()=>{const session={create:async()=>{},finish(){},cleanup};sessions.push(session);return session;}});
  return {node,context,handle,sessions,start:async()=>{node('consent').checked=true;await node('start').listeners.click();}};
}

test('Private displays cleanup status only in details and keeps the warning, local clearing and gates', async () => {
  const ui=privateUI(Promise.resolve({acknowledged:false,diagnostic:{phase:'response',status:403,body:'fixture-private-sentinel'}}));
  await ui.start();ui.node('message').value='fixture-private-sentinel';ui.node('invitation').value='fixture-private-sentinel';ui.node('code').textContent='fixture-private-sentinel';
  await ui.handle.end();
  assert.equal(ui.node('status').textContent,'Session cleared on this device. Server cleanup could not be confirmed.');
  assert.match(ui.node('connection-help').textContent,/\nCleanup check: HTTP 403\.$/);
  assert.equal(ui.node('connection-help').textContent.includes('sentinel'),false);
  assert.equal(ui.node('message').value,'');assert.equal(ui.node('invitation').value,'');assert.equal(ui.node('code').textContent,'');
  assert.equal(ui.node('confirm').disabled,true);assert.equal(ui.node('mic').disabled,true);assert.equal(ui.node('sound').disabled,true);
  await ui.start();assert.equal(ui.node('connection-help').textContent.includes('Cleanup check'),false);
});

test('Private renders only allowlisted phases and integer HTTP statuses', () => {
  const {context}=privateUI(Promise.resolve());
  assert.equal(context.help({diagnostic:{phase:'network',error:'fixture-private-sentinel'}}),'Cleanup check: network request failed.');
  assert.equal(context.help({diagnostic:{phase:'deadline',status:503}}),'Cleanup check: eight-second deadline reached. HTTP 503.');
  for(const diagnostic of [null,{phase:'fixture-private-sentinel',status:403},{phase:'response',status:'fixture-private-sentinel'},{phase:'response',status:999},{phase:'response',status:200.5}])assert.equal(context.help({diagnostic}).includes('sentinel'),false);
  assert.equal(context.help({diagnostic:{phase:'response',status:'403'}}),'Cleanup check: response status unavailable.');
});

test('late cleanup cannot overwrite a new session and unnecessary cleanup adds no diagnostic', async () => {
  let resolve;const ui=privateUI(new Promise(r=>resolve=r));await ui.start();const ended=ui.handle.end();await ui.start();
  const details=ui.node('connection-help').textContent,status=ui.node('status').textContent;
  resolve({acknowledged:false,diagnostic:{phase:'response',status:403}});await ended;
  assert.equal(ui.node('connection-help').textContent,details);assert.equal(ui.node('status').textContent,status);
  const none=privateUI(Promise.resolve({required:false,acknowledged:false}));await none.start();await none.handle.end();
  assert.equal(none.node('status').textContent,'Session cleared on this device.');assert.equal(none.node('connection-help').textContent.includes('Cleanup check'),false);
});
