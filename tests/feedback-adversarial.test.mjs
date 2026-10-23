import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {feedback,makeWorker} from '../server/handler.js';
import {page,notFound} from '../server/pages.js';
const schema=await readFile(new URL('../drizzle/0000_beta_feedback.sql',import.meta.url),'utf8');
const origin='https://vellivex.test',secret='synthetic-private-test-secret-at-least-32';
const base={product:'Website',kind:'test',os:'Desktop',message:'Original synthetic feedback for attack testing.',safe:'on',elapsed:3000,website:''};
function request(data,ip='192.0.2.10'){return new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json','cf-connecting-ip':ip},body:JSON.stringify(data)});}
function database(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(schema);
  return {sqlite,DB:{prepare(sql){return {bind(...values){return {async first(){return sqlite.prepare(sql).get(...values);},async run(){const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)}};}};}};}}};
}
test('actual SQLite rejects a concurrent feedback burst above the network limit',async()=>{
  const {sqlite,DB}=database();try{const results=await Promise.all(Array.from({length:40},()=>feedback(request({...base,id:crypto.randomUUID()}),{DB,FEEDBACK_RATE_SECRET:secret})));assert.equal(results.filter(r=>r.status===201).length,10);assert.equal(results.filter(r=>r.status===429).length,30);assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,10);}finally{sqlite.close();}
});
test('midnight does not reset the hourly feedback limit or break an identical retry',async()=>{
  const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret},before=new Date('2026-10-23T23:59:50Z'),after=new Date('2026-10-24T00:00:10Z'),saved={...base,id:crypto.randomUUID()};
  try{assert.equal((await feedback(request(saved),env,before)).status,201);for(let i=1;i<10;i++)assert.equal((await feedback(request({...base,id:crypto.randomUUID()}),env,before)).status,201);assert.equal((await feedback(request({...base,id:crypto.randomUUID()}),env,after)).status,429);assert.equal((await feedback(request(saved),env,after)).status,200);}finally{sqlite.close();}
});
test('retry conflicts cannot overwrite or falsely confirm changed private feedback',async()=>{
  const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret},data={...base,id:crypto.randomUUID()};
  try{assert.equal((await feedback(request(data),env)).status,201);const changed=await feedback(request({...data,message:'New synthetic report that must not be lost.'}),env);assert.equal(changed.status,409);assert.equal((await changed.json()).saved,undefined);assert.equal(sqlite.prepare('SELECT message FROM feedback').get().message,data.message);const foreign=await feedback(request(data,'192.0.2.11'),env);assert.equal(foreign.status,409);assert.ok(!(await foreign.text()).includes(data.message));}finally{sqlite.close();}
});
test('simultaneous identical submissions reconcile to exactly one SQLite row',async()=>{
  const {sqlite,DB}=database(),data={...base,id:crypto.randomUUID()},env={DB,FEEDBACK_RATE_SECRET:secret};
  try{const results=await Promise.all(Array.from({length:12},()=>feedback(request(data),env)));for(const result of results){assert.ok([200,201].includes(result.status));assert.deepEqual(await result.json(),{id:data.id,saved:true});}assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,1);}finally{sqlite.close();}
});
test('SQL and HTML attack text stays literal and cannot create a public read route',async()=>{
  const {sqlite,DB}=database(),message="Synthetic <script>alert(1)</script> '); DROP TABLE feedback; --",data={...base,message,id:crypto.randomUUID()};
  try{const response=await feedback(request(data),{DB,FEEDBACK_RATE_SECRET:secret});assert.equal(response.status,201);assert.equal(sqlite.prepare('SELECT message FROM feedback').get().message,message);const worker=makeWorker(page,notFound,{});for(const method of ['GET','HEAD','OPTIONS','DELETE']){const read=await worker.fetch(new Request(origin+'/api/feedback',{method}),{DB,FEEDBACK_RATE_SECRET:secret});assert.equal(read.status,405);assert.ok(!(await read.text()).includes(message));}}finally{sqlite.close();}
});
test('crafted slash/backslash URLs cannot escape the site through redirects',async()=>{
  const worker=makeWorker(page,notFound,{});for(const path of ['//attacker.test/','///attacker.test/','/\\attacker.test/','/normal/?next=https://attacker.test']){const response=await worker.fetch(new Request(origin+path),{});if(response.status===308)assert.equal(new URL(response.headers.get('Location'),origin).origin,origin);}const secure=await worker.fetch(new Request('http://vellivex.test/apps/vault'),{});assert.equal(secure.status,308);assert.equal(secure.headers.get('Location'),origin+'/apps/vault');
});
test('chunked oversize, invalid UTF-8, misleading MIME and newline UUID are rejected',async()=>{
  let cancelled=false;const chunks=Array.from({length:4},()=>new Uint8Array(8000).fill(32));const body=new ReadableStream({pull(controller){if(chunks.length)controller.enqueue(chunks.shift());else controller.close();},cancel(){cancelled=true;}});
  const streamed=new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body,duplex:'half'});assert.equal((await feedback(streamed,{})).status,413);assert.equal(cancelled,true);
  const invalid=new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body:new Uint8Array([255,255])});assert.equal((await feedback(invalid,{})).status,400);
  const mime=new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/jsonp'},body:JSON.stringify({...base,id:crypto.randomUUID()})});assert.equal((await feedback(mime,{})).status,415);assert.equal((await feedback(request({...base,id:crypto.randomUUID()+'\n'}),{})).status,400);
});

test('identical concurrent retries reconcile even when the first fills quota slot ten',async()=>{
 const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret};try{
 for(let i=0;i<9;i++)assert.equal((await feedback(request({...base,id:crypto.randomUUID()}),env)).status,201);
 const data={...base,id:crypto.randomUUID()},results=await Promise.all(Array.from({length:5},()=>feedback(request(data),env)));
 for(const result of results){assert.ok([200,201].includes(result.status));assert.deepEqual(await result.json(),{id:data.id,saved:true});}
 assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,10);
 }finally{sqlite.close();}
});

test('500-request local burst remains atomic and never exposes feedback content',async()=>{
 const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret};
 try{const results=await Promise.all(Array.from({length:500},()=>feedback(request({...base,id:crypto.randomUUID()}),env)));
 assert.equal(results.filter(r=>r.status===201).length,10);assert.equal(results.filter(r=>r.status===429).length,490);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,10);
 for(const response of results)assert.ok(!(await response.text()).includes(base.message));
 }finally{sqlite.close();}
});
test('foreign, opaque and suffix-confusion origins fail before database access',async()=>{
 const env={FEEDBACK_RATE_SECRET:secret,DB:{prepare(){throw Error('origin reached database');}}};
 for(const bad of [null,'null','https://vellivex.test.attacker.test','http://vellivex.test','https://attacker.test',origin+', https://attacker.test']){
 const headers={'content-type':'application/json'};if(bad!==null)headers.origin=bad;
 const response=await feedback(new Request(origin+'/api/feedback',{method:'POST',headers,body:JSON.stringify({...base,id:crypto.randomUUID()})}),env);assert.equal(response.status,403);
 }
});
