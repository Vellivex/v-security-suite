import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/site.js',import.meta.url),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function setup({schedule=setTimeout,cancel=clearTimeout,cryptoProvider=crypto}={}){
 const handlers=new Map(),form={data:{message:'Original synthetic report'},resets:0,prevented:0,addEventListener(type,fn){handlers.set(type,fn);},emit(type){return handlers.get(type)?.({preventDefault:()=>{this.prevented++;}});},reset(){this.resets++;this.data={};}},button={},status={},requests=[];
 const document={getElementById(id){return {'feedback-form':form,'feedback-submit':button,'feedback-status':status}[id]||null;}};
 class FormData {constructor(value){this.entries=Object.entries(value.data);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}
 vm.runInNewContext(source,{document,crypto:cryptoProvider,Date,FormData,AbortController,setTimeout:schedule,clearTimeout:cancel,fetch:async(url,options)=>{const work=deferred();requests.push({data:JSON.parse(options.body),signal:options.signal,work});return work.promise;}});
 return {form,button,status,requests,reply(index,patch={}){const sent=requests[index];sent.work.resolve({ok:true,status:201,async json(){return {id:sent.data.id,saved:true,...patch};}});}};
}
test('feedback completion preserves a newer draft instead of clearing unsaved edits',async()=>{
 const t=setup(),first=t.form.emit('submit');t.form.data.message='A newer synthetic draft';t.form.emit('input');t.reply(0);await first;assert.equal(t.form.resets,0);assert.equal(t.form.data.message,'A newer synthetic draft');assert.match(t.status.textContent,/newer edits/);const next=t.form.emit('submit');assert.notEqual(t.requests[0].data.id,t.requests[1].data.id);t.reply(1);await next;assert.equal(t.form.resets,1);
});
test('an uncertain submission retries with the same id until the report changes',async()=>{
 const t=setup(),first=t.form.emit('submit');t.requests[0].work.reject(new Error('Synthetic lost acknowledgement'));await first;const next=t.form.emit('submit');assert.equal(t.requests[0].data.id,t.requests[1].data.id);t.reply(1);await next;assert.equal(t.form.resets,1);
});
test('a conflicting reference rotates the id and keeps the report available to resend',async()=>{
 const t=setup(),first=t.form.emit('submit');t.requests[0].work.resolve({ok:false,status:409,async json(){return {error:'Reference conflict'};}});await first;assert.equal(t.form.resets,0);const next=t.form.emit('submit');assert.notEqual(t.requests[0].data.id,t.requests[1].data.id);t.reply(1);await next;
});
test('duplicate submit events cannot start parallel feedback requests',async()=>{
 const t=setup(),first=t.form.emit('submit');for(let i=0;i<20;i++)await t.form.emit('submit');assert.equal(t.requests.length,1);assert.equal(t.button.disabled,true);t.reply(0);await first;assert.equal(t.button.disabled,false);
});
test('an unrelated success response cannot claim or clear this report',async()=>{
 const t=setup(),first=t.form.emit('submit');t.reply(0,{id:crypto.randomUUID()});await first;assert.equal(t.form.resets,0);assert.match(t.status.textContent,/did not confirm/);
});

function deadlineClock(){let next=0;const jobs=new Map();return {jobs,schedule(fn,ms){const id=++next;jobs.set(id,{fn,ms});return id;},cancel(id){jobs.delete(id);},expire(){const job=jobs.values().next().value;assert.ok(job,'a whole-operation deadline must be scheduled');assert.equal(job.ms,30000);job.fn();}};}
test('stalled feedback fetch times out, preserves draft and retries the same reference',async()=>{
 const clock=deadlineClock(),t=setup(clock),first=t.form.emit('submit');clock.expire();await first;
 assert.equal(t.button.disabled,false);assert.equal(t.form.resets,0);assert.equal(t.form.data.message,'Original synthetic report');assert.match(t.status.textContent,/timed out/);assert.equal(t.requests[0].signal.aborted,true);assert.equal(clock.jobs.size,0);
 const next=t.form.emit('submit');assert.equal(t.requests[0].data.id,t.requests[1].data.id);t.reply(1);await next;assert.equal(t.form.resets,1);assert.equal(clock.jobs.size,0);
});
test('stalled response body times out and its late completion cannot clear or unlock a newer submission',async()=>{
 const clock=deadlineClock(),t=setup(clock),body=deferred(),first=t.form.emit('submit');
 t.requests[0].work.resolve({ok:true,status:201,json:()=>body.promise});await new Promise(setImmediate);clock.expire();await first;
 assert.equal(t.button.disabled,false);assert.equal(t.form.resets,0);assert.equal(t.requests[0].signal.aborted,true);
 t.form.data.message='A newer synthetic report';t.form.emit('input');const next=t.form.emit('submit');const status=t.status.textContent;
 body.resolve({saved:true,id:t.requests[0].data.id});await new Promise(setImmediate);
 assert.equal(t.form.data.message,'A newer synthetic report');assert.equal(t.form.resets,0);assert.equal(t.button.disabled,true);assert.equal(t.status.textContent,status);
 t.reply(1);await next;assert.equal(t.form.resets,1);assert.equal(t.button.disabled,false);assert.equal(clock.jobs.size,0);
});

test('secure UUID fallback sets v4 bits and preserves uncertain retry until edits',async()=>{
 let calls=0;const provider={getRandomValues(bytes){assert.equal(bytes.byteLength,16);const offset=16*calls++;for(let i=0;i<16;i++)bytes[i]=offset+i;return bytes;}};
 const t=setup({cryptoProvider:provider}),first=t.form.emit('submit');
 assert.equal(t.requests[0].data.id,'00010203-0405-4607-8809-0a0b0c0d0e0f');assert.equal(calls,1);
 t.requests[0].work.reject(new Error('Synthetic lost acknowledgement'));await first;
 const retry=t.form.emit('submit');assert.equal(t.requests[1].data.id,t.requests[0].data.id);assert.equal(calls,1);
 t.requests[1].work.reject(new Error('Synthetic retry interrupted'));await retry;
 t.form.data.message='A changed synthetic report';t.form.emit('input');const changed=t.form.emit('submit');
 assert.equal(calls,2);assert.notEqual(t.requests[2].data.id,t.requests[0].data.id);assert.match(t.requests[2].data.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);t.reply(2);await changed;
});
test('fallback UUID references rotate after conflict and after an acknowledged report',async()=>{
 const t=setup({cryptoProvider:{getRandomValues:crypto.getRandomValues.bind(crypto)}}),first=t.form.emit('submit');
 t.requests[0].work.resolve({ok:false,status:409,async json(){return {error:'Reference conflict'};}});await first;
 const retry=t.form.emit('submit');assert.notEqual(t.requests[1].data.id,t.requests[0].data.id);t.reply(1);await retry;
 t.form.data.message='Another synthetic report';const next=t.form.emit('submit');assert.notEqual(t.requests[2].data.id,t.requests[1].data.id);t.reply(2);await next;
});
test('missing or throwing secure randomness prevents native submit and network writes',async()=>{
 for(const cryptoProvider of [null,{}, {randomUUID(){throw new Error('Synthetic provider failure');}}, {getRandomValues(){throw new Error('Synthetic provider failure');}}]){
  const t=setup({cryptoProvider});await t.form.emit('submit');assert.equal(t.form.prevented,1);assert.equal(t.requests.length,0);assert.equal(t.form.resets,0);assert.equal(t.form.data.message,'Original synthetic report');assert.match(t.status.textContent,/secure randomness.*unavailable/i);assert.equal(t.button.disabled,false);
 }
});
test('secure randomness failure after edits keeps the new draft and permits a safe retry',async()=>{
 let fail=false;const provider={getRandomValues(bytes){if(fail)throw new Error('Synthetic provider failure');return crypto.getRandomValues(bytes);}},t=setup({cryptoProvider:provider}),first=t.form.emit('submit');
 t.requests[0].work.reject(new Error('Synthetic lost acknowledgement'));await first;
 t.form.data.message='A newer synthetic draft';t.form.emit('input');fail=true;await t.form.emit('submit');assert.equal(t.requests.length,1);assert.equal(t.form.data.message,'A newer synthetic draft');assert.match(t.status.textContent,/secure randomness.*unavailable/i);
 fail=false;const retry=t.form.emit('submit');assert.notEqual(t.requests[1].data.id,t.requests[0].data.id);t.reply(1);await retry;assert.equal(t.form.resets,1);
});
