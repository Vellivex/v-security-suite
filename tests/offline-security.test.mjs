import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const template=await readFile(new URL('../web/sw.js',import.meta.url),'utf8');
function runtime({cached=false,failDownload=false}={}){
 const events={},calls=[],deleted=[];let response=cached?new Response('cached verified file'):undefined;
 const cache={async match(){return response;},async put(path,value){response=value;}};
 const self={location:{origin:'https://v.test'},addEventListener(type,fn){events[type]=fn;}};
 const RequestAtOrigin=class extends Request{constructor(url,options){super(new URL(url,self.location.origin),options);}};
 vm.runInNewContext(template.replace('__CACHE_ID__','v-tools-test').replace('__ASSET_MANIFEST__',JSON.stringify([{url:'/app.js',integrity:'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='}])),{self,caches:{async open(){return cache;},async delete(name){deleted.push(name);},async keys(){return ['v-tools-test'];}},Request:RequestAtOrigin,Response,URL,fetch:async request=>{calls.push(request);return new Response('source',{status:failDownload?503:200});}});
 return {events,calls,deleted};
}
test('offline cache miss returns an error without loading replacement network code',async()=>{const r=runtime();let response;r.events.fetch({request:new Request('https://v.test/app.js'),respondWith(promise){response=promise;}});assert.equal((await response).status,503);assert.equal(r.calls.length,0);});
test('offline installation pins asset integrity and removes a partial failed cache',async()=>{const r=runtime({failDownload:true});let work;r.events.install({waitUntil(promise){work=promise;}});await assert.rejects(work);assert.equal(r.calls[0].integrity,'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');assert.equal(r.calls[0].redirect,'error');assert.deepEqual(r.deleted,['v-tools-test']);});
