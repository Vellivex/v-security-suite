import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/site.js',import.meta.url),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function setup(){
 const handlers=new Map(),form={data:{message:'Original synthetic report'},resets:0,addEventListener(type,fn){handlers.set(type,fn);},emit(type){return handlers.get(type)?.({preventDefault(){}});},reset(){this.resets++;this.data={};}},button={},status={},requests=[];
 const document={getElementById(id){return {'feedback-form':form,'feedback-submit':button,'feedback-status':status}[id]||null;}};
 class FormData {constructor(value){this.entries=Object.entries(value.data);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}
 vm.runInNewContext(source,{document,crypto,Date,FormData,fetch:async(url,options)=>{const work=deferred();requests.push({data:JSON.parse(options.body),work});return work.promise;}});
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
