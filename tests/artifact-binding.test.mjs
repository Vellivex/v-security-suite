import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeWorker} from '../server/handler.js';
import {validateReleaseBinding} from '../scripts/artifact-binding.mjs';
const origin='https://artifact-binding.vellivex.test',artifact='VGuard-0.1.3-candidate.apk';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=Uint8Array.from([0x50,0x4b,3,4,0,1,2,3]);
function fixture({bytes=original,report={artifact,bytes:original.length,sha256:digest(original)}}={}){
 const sums=digest(bytes)+'  '+artifact+'\n';
 const worker=makeWorker(path=>path==='/apps/guard'?'<p>'+report.sha256+'</p>':undefined,()=>'',{
  ['/downloads/'+artifact]:{body:Buffer.from(bytes).toString('base64'),base64:true,type:'application/vnd.android.package-archive'},
  '/downloads/VGuard-0.1.3-Build-Report.json':{body:JSON.stringify(report),type:'application/json'},
  '/downloads/SHA256SUMS.txt':{body:sums,type:'text/plain'}
 });
 return worker;
}
test('assembled download bytes match their build report digest and size',async()=>{
 const report=await validateReleaseBinding(fixture(),origin);assert.equal(report.sha256,digest(original));
});
test('re-checksummed artifact mutation cannot inherit an unchanged published build report',async()=>{
 const changed=Uint8Array.from(original);changed[changed.length-1]^=1;const worker=fixture({bytes:changed});
 // Reproduces the old gap: download checksums agree with the changed file while
 // the page still advertises the original build report's digest.
 const downloaded=new Uint8Array(await (await worker.fetch(new Request(origin+'/downloads/'+artifact),{})).arrayBuffer());
 const checksum=await (await worker.fetch(new Request(origin+'/downloads/SHA256SUMS.txt'),{})).text();assert.ok(checksum.startsWith(digest(downloaded)+'  '));
 await assert.rejects(validateReleaseBinding(worker,origin),/digest/i);
});
test('build report byte length must agree even when the digest is correct',async()=>{
 const worker=fixture({report:{artifact,bytes:original.length+1,sha256:digest(original)}});
 await assert.rejects(validateReleaseBinding(worker,origin),/size|length|bytes/i);
});
test('build report cannot name a different release artifact',async()=>{
 const worker=fixture({report:{artifact:'different.apk',bytes:original.length,sha256:digest(original)}});
 await assert.rejects(validateReleaseBinding(worker,origin),/artifact/i);
});
