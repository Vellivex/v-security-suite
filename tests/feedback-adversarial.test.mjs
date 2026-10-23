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

test('duplicate and escaped duplicate report fields are rejected before persistence',async()=>{const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret},data={...base,id:crypto.randomUUID()},original=JSON.stringify(data);try{for(const field of ['message','\\u006dessage','id','product']){const text=original.slice(0,-1)+','+JSON.stringify(field).replace('\\\\u006d','\\u006d')+':'+JSON.stringify(data[field==='\\u006dessage'?'message':field])+'}';const req=new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body:text});assert.equal((await feedback(req,env)).status,400,field);}assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,0);}finally{sqlite.close();}});
test('ill-formed Unicode cannot be silently rewritten by feedback storage',async()=>{const {sqlite,DB}=database();try{const response=await feedback(request({...base,id:crypto.randomUUID(),message:'Synthetic report with invalid surrogate \ud800 inside'}),{DB,FEEDBACK_RATE_SECRET:secret});assert.equal(response.status,400);assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,0);}finally{sqlite.close();}});
test('unknown and prototype-shaped feedback fields never reach persistence',async()=>{const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret};try{for(const key of ['is_admin','is_test','created_at','rate_key','__proto__','constructor']){const data={...base,id:crypto.randomUUID(),[key]:key==='__proto__'?{polluted:true}:'attacker value'};assert.equal((await feedback(request(data),env)).status,400);}assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,0);assert.equal({}.polluted,undefined);}finally{sqlite.close();}});
test('hostile paths and queries do not reflect scripts or expose private files',async()=>{const worker=makeWorker(page,notFound,{}),marker='SYNTHETIC_XSS_PROBE',attack='<script>'+marker+'</script>';for(const path of ['/.env','/.git/config','/.openai/hosting.json','/server/handler.js','/api/reports','/api/feedback/12345678','/%2e%2e/.env','/downloads/%2e%2e/.env','/'+encodeURIComponent(attack)]){const response=await worker.fetch(new Request(origin+path),{});assert.equal(response.status,404,path);assert.ok(!(await response.text()).includes(marker));}for(const path of ['/','/feedback','/source']){const response=await worker.fetch(new Request(origin+path+'?q='+encodeURIComponent(attack)),{});assert.equal(response.status,200);assert.ok(!(await response.text()).includes(marker));}});
test('error and API responses keep browser isolation and refuse permissive CORS',async()=>{const worker=makeWorker(page,notFound,{}),requests=[new Request(origin+'/missing'),new Request(origin+'/api/feedback'),new Request(origin+'/api/feedback',{method:'OPTIONS',headers:{origin:'https://attacker.test','access-control-request-method':'POST'}}),request({...base,id:crypto.randomUUID(),safe:''}),request({...base,id:crypto.randomUUID()})];for(const req of requests){const response=await worker.fetch(req,{});assert.ok(response.status>=400);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);assert.equal(response.headers.get('X-Frame-Options'),'DENY');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);}});
test('strict feedback parsing preserves legitimate escaped text, Unicode and idempotent retry',async()=>{const {sqlite,DB}=database(),env={DB,FEEDBACK_RATE_SECRET:secret},message='Synthetic literal ,"message": "value" with braces {} and Unicode 🛡 café.\nSecond line.',data={...base,id:crypto.randomUUID(),message};try{assert.equal((await feedback(request(data),env)).status,201);assert.equal((await feedback(request(data),env)).status,200);assert.equal(sqlite.prepare('SELECT message FROM feedback').get().message,message);assert.equal(sqlite.prepare('SELECT count(*) n FROM feedback').get().n,1);}finally{sqlite.close();}});

test('stalled feedback bodies time out without waiting for a stuck cancellation',async t=>{t.mock.timers.enable({apis:['setTimeout']});let controller,cancelled=false;const body=new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;return new Promise(()=>{});}}),req=new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body,duplex:'half'});let response;const pending=feedback(req,{}).then(r=>{response=r;});try{t.mock.timers.tick(10001);await new Promise(setImmediate);assert.equal(response?.status,408);assert.equal(cancelled,true);assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);await pending;}finally{if(!cancelled)controller.close();}});
test('periodic body chunks cannot extend the total feedback read deadline',async t=>{t.mock.timers.enable({apis:['setTimeout']});let controller,cancelled=false;const body=new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;}}),req=new Request(origin+'/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body,duplex:'half'});let response;const pending=feedback(req,{}).then(r=>{response=r;});try{for(let i=0;i<3;i++){controller.enqueue(new TextEncoder().encode(' '));await new Promise(setImmediate);t.mock.timers.tick(3500);}await new Promise(setImmediate);assert.equal(response?.status,408);assert.equal(cancelled,true);await pending;}finally{if(!cancelled)controller.close();}});
