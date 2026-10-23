import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, writeFile, mkdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const repo=resolve(import.meta.dirname,'..'),script=join(repo,'scripts/verify-vguard-release.py');
const sha=data=>createHash('sha256').update(data).digest('hex');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'vguard-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp(join(repo,'apps/vguard/app'),join(root,'apps/vguard/app'),{recursive:true});
 await cp(join(repo,'apps/vguard/validation'),join(root,'apps/vguard/validation'),{recursive:true});
 return root;
}
function run(root,...args){return spawnSync('python3',[script,'--root',root,...args],{encoding:'utf8'});}
async function alterJson(root,name,edit){const path=join(root,'apps/vguard/validation',name),json=JSON.parse(await readFile(path,'utf8'));edit(json);await writeFile(path,JSON.stringify(json));}
function refused(result,pattern){assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,pattern);}
async function rewriteManifestAndPin(root,change){
 const path=join(root,'apps/vguard/app/src/main/AndroidManifest.xml');await writeFile(path,change(await readFile(path,'utf8')));
 const pinPath=join(root,'apps/vguard/validation/Candidate-Source-Fingerprints.json'),pin=JSON.parse(await readFile(pinPath,'utf8'));
 pin.source_sha256['app/src/main/AndroidManifest.xml']=sha(await readFile(path));
 const combined=createHash('sha256');
 for(const name of Object.keys(pin.source_sha256).sort()){combined.update(name+'\0');combined.update(await readFile(join(root,'apps/vguard',name)));}
 pin.source_fingerprint_sha256=combined.digest('hex');await writeFile(pinPath,JSON.stringify(pin));
 await alterJson(root,'Package-Build.json',report=>{report.source_fingerprint_sha256=pin.source_fingerprint_sha256;});
}

test('native source-only verification states that no APK/signature was checked',async t=>{
 const root=await fixture(t),result=run(root);assert.equal(result.status,0,result.stderr);
 const receipt=JSON.parse(result.stdout);assert.equal(receipt.source_inputs,14);assert.equal(receipt.apk_hash_verified,false);assert.equal(receipt.fresh_sdk_verification,false);assert.match(receipt.scope,/no APK available/);
});
test('changed native source cannot reuse a previous release fingerprint',async t=>{
 const root=await fixture(t);await writeFile(join(root,'apps/vguard/app/src/main/java/app/vguard/firewall/RuleStore.java'),'changed source');refused(run(root),/Changed, missing or unlisted/);
});
test('unlisted native inputs cannot silently enter a release',async t=>{
 const root=await fixture(t);await writeFile(join(root,'apps/vguard/app/src/main/res/values/unreviewed.xml'),'<resources/>');refused(run(root),/Changed, missing or unlisted/);
});
test('missing native inputs cannot silently disappear from a release',async t=>{
 const root=await fixture(t);await rm(join(root,'apps/vguard/app/src/main/java/app/vguard/firewall/ExportTarget.java'));refused(run(root),/Changed, missing or unlisted/);
});
test('symbolic native inputs cannot reference files outside the source',async t=>{
 const root=await fixture(t);await symlink('/etc/hosts',join(root,'apps/vguard/app/injected-link'));refused(run(root),/Symbolic native input/);
});
test('inconsistent release metadata is refused before artifact use',async t=>{
 const root=await fixture(t);await alterJson(root,'Package-Build.json',report=>{report.sha256='0'.repeat(64);});refused(run(root),/metadata disagree/);
});
test('a changed official signing identity cannot be accepted as the same release',async t=>{
 const root=await fixture(t);await alterJson(root,'Package-Build.json',report=>{report.signing_certificate_sha256='0'.repeat(64);});refused(run(root),/signing identity changed/);
});
test('duplicate metadata fields cannot hide a conflicting release digest',async t=>{
 const root=await fixture(t),path=join(root,'apps/vguard/validation/Package-Build.json');await writeFile(path,(await readFile(path,'utf8')).replace('{','{"sha256":"'+ '0'.repeat(64)+'",'));refused(run(root),/Duplicate JSON field/);
});
test('coherently repinned native Internet permission still violates release policy',async t=>{
 const root=await fixture(t);await rewriteManifestAndPin(root,text=>text.replace('<application','<uses-permission android:name="android.permission.INTERNET"/><application'));refused(run(root),/Unexpected or duplicate native permission/);
});
test('coherently repinned exported service cannot drop its signature permission',async t=>{
 const root=await fixture(t);await rewriteManifestAndPin(root,text=>text.replace('android.permission.BIND_VPN_SERVICE','android.permission.INTERNET'));refused(run(root),/VPN service permission protection changed/);
});
test('modified APK bytes are rejected instead of trusting historical signature booleans',async t=>{
 const root=await fixture(t);await mkdir(join(root,'releases'));await writeFile(join(root,'releases/VGuard-0.1.3-candidate.apk'),'not the signed candidate');refused(run(root),/APK bytes\/hash mismatch/);
});
test('required binary verification cannot fall back to a source-only pass',async t=>{
 const root=await fixture(t);refused(run(root,'--require-apk'),/Required APK missing/);
});
