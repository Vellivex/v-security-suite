import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Validate the release information served by the assembled Worker, rather than
// trusting source-side metadata alone. This is not APK signature verification.
export async function validateReleaseBinding(worker,origin){
 const response=await worker.fetch(new Request(origin+'/downloads/VGuard-0.1.3-Build-Report.json'),{});
 assert.equal(response.status,200,'Build report must be downloadable');
 const report=await response.json(),artifact='VGuard-0.1.3-candidate.apk';
 assert.equal(report?.artifact,artifact,'Build report artifact must match the downloaded release');
 assert.ok(Number.isSafeInteger(report.bytes)&&report.bytes>0,'Build report bytes must be a positive safe integer');
 assert.match(report.sha256,/^[0-9a-f]{64}$/,'Build report digest must be canonical SHA-256');
 const download=await worker.fetch(new Request(origin+'/downloads/'+artifact),{});
 assert.equal(download.status,200,'APK artifact must be downloadable');
 const bytes=new Uint8Array(await download.arrayBuffer());
 assert.equal(bytes.byteLength,report.bytes,'APK byte length must match the build report size');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),report.sha256,'APK digest must match the build report digest');
 const guard=await worker.fetch(new Request(origin+'/apps/guard'),{});
 assert.ok((await guard.text()).includes(report.sha256),'Guard page must show the build report digest');
 return report;
}
