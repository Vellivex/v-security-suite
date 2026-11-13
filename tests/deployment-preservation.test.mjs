import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validatePreservedDeployment, packPreservedWorker} from '../server/app-access/package-live.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const js = 'application/javascript+module';
const bytes = {'app-access-entry.mjs': 'import original from "./index.mjs"; export default withAppAccess(original);', 'index.mjs': 'export const publishedAPK="VGuard-0.1.4";', 'app-access/core.mjs': 'old guarded handler', 'VGuard-0.1.4.apk': Buffer.from([0,255,1,2])};
const fixture = () => {
  const modules = Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, {sha256: hash(value), type: name.endsWith('.apk') ? 'application/octet-stream' : js}]));
  const metadata = {main_module: 'app-access-entry.mjs', compatibility_date: '2026-10-27', compatibility_flags: [], bindings: [{name:'APP_ACCESS', type:'service', service:'vellivex-accounts'}, {name:'DB', type:'d1', id:'retained-database'}]};
  return {service:'vellivex-site-migration', expectedVersion:'722cbb78-db57-4275-9ad6-3713f91788d6', currentVersion:'722cbb78-db57-4275-9ad6-3713f91788d6', baselineMetadata:metadata, candidateMetadata:structuredClone(metadata), baselineModules:modules, candidateModules:structuredClone(modules), reviewedChanges:{}};
};
const changedFixture = () => {
  const data = fixture();
  data.candidateModules['app-access/core.mjs'].sha256 = hash('bounded guarded handler');
  data.reviewedChanges['app-access/core.mjs'] = {beforeSha256: data.baselineModules['app-access/core.mjs'].sha256, afterSha256: data.candidateModules['app-access/core.mjs'].sha256};
  return data;
};

test('preserved repair accepts exact metadata and reviewed one-module bytes', () => {
  const evidence=validatePreservedDeployment(changedFixture());
  assert.equal(evidence.moduleCount,4); assert.equal(evidence.bindingCount,2);
  assert.deepEqual(evidence.changedModules,['app-access/core.mjs']);
});

test('historical bare index entry regression and stale version stop before packaging', () => {
  const entry=fixture(); entry.candidateMetadata.main_module='index.mjs';
  assert.throws(()=>validatePreservedDeployment(entry), /main module/);
  const stale=fixture(); stale.currentVersion='adaa3132-f5cb-4294-be0f-6db1624f1da7';
  assert.throws(()=>validatePreservedDeployment(stale), /expected live version/);
});

test('missing binding, changed database, lost flag and unknown metadata changes fail', () => {
  for(const mutate of [d=>d.candidateMetadata.bindings.pop(),d=>d.candidateMetadata.bindings[1].id='other',d=>d.candidateMetadata.compatibility_flags.push('nodejs_compat'),d=>d.candidateMetadata.new_assets='replacement']) {
    const data=fixture(); mutate(data); assert.throws(()=>validatePreservedDeployment(data), /metadata must be preserved/);
  }
});

test('lost wrapper, extra module, changed MIME or old generic APK module fail', () => {
  for(const mutate of [d=>delete d.candidateModules['app-access-entry.mjs'],d=>d.candidateModules['unexpected.mjs']={sha256:hash('extra'),type:js},d=>d.candidateModules['index.mjs'].type='text/plain',d=>d.candidateModules['index.mjs'].sha256=hash('export const publishedAPK="VGuard-0.1.3";')]) {
    const data=fixture(); mutate(data); assert.throws(()=>validatePreservedDeployment(data), /preserved|MIME|Unreviewed/);
  }
});

test('wrong before or after review hash, redundant approval and binary replacements fail', () => {
  for(const field of ['beforeSha256','afterSha256']) {
    const data=changedFixture(); data.reviewedChanges['app-access/core.mjs'][field]=hash('wrong'); assert.throws(()=>validatePreservedDeployment(data), /Unreviewed/);
  }
  const redundant=fixture(); redundant.reviewedChanges['index.mjs']={beforeSha256:hash(bytes['index.mjs']),afterSha256:hash(bytes['index.mjs'])};
  assert.throws(()=>validatePreservedDeployment(redundant), /match exactly/);
  const binary=fixture(); binary.candidateModules['VGuard-0.1.4.apk'].sha256=hash('replacement'); binary.reviewedChanges['VGuard-0.1.4.apk']={beforeSha256:hash(bytes['VGuard-0.1.4.apk']),afterSha256:hash('replacement')};
  assert.throws(()=>validatePreservedDeployment(binary), /Binary release/);
});

test('unwrapped services retain their captured main rather than inventing a gate', () => {
  const data=fixture(); data.service='vellivex-email-events';
  data.baselineMetadata.main_module='index.mjs';data.candidateMetadata.main_module='index.mjs';
  assert.equal(validatePreservedDeployment(data).mainModule,'index.mjs');
});

test('complete repair package keeps binary bytes, metadata and exact inventory', async () => {
  const root=await mkdtemp(join(tmpdir(),'vellivex-preserved-test-'));
  try {
    const baselineDir=join(root,'baseline'),candidateDir=join(root,'candidate'),outputDir=join(root,'output');
    for(const directory of [baselineDir,candidateDir]) for(const [name,value] of Object.entries(bytes)) {await mkdir(join(directory,name,'..'),{recursive:true});await writeFile(join(directory,name),value);}
    await writeFile(join(candidateDir,'app-access/core.mjs'),'bounded guarded handler');
    const data={...changedFixture(),baselineDir,candidateDir,outputDir};
    const result=await packPreservedWorker(data);
    assert.equal(result.protocol,'vellivex.preserved-repair.v1');
    assert.deepEqual(await readFile(join(outputDir,'modules/VGuard-0.1.4.apk')),bytes['VGuard-0.1.4.apk']);
    assert.deepEqual(JSON.parse(await readFile(join(outputDir,'upload-metadata.json'),'utf8')),data.candidateMetadata);
    await assert.rejects(packPreservedWorker(data), /already exists/);
    await writeFile(join(candidateDir,'index.mjs'),'generic old APK bytes');
    await assert.rejects(packPreservedWorker({...data,outputDir:join(root,'rejected')}), /Baseline hash mismatch/);
    await assert.rejects(access(join(root,'rejected')));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('invalid metadata or inventory is rejected instead of assuming empty bindings', () => {
  for(const mutate of [d=>delete d.baselineMetadata.compatibility_flags,d=>delete d.baselineMetadata.bindings,d=>d.baselineMetadata.bindings.push(d.baselineMetadata.bindings[0]),d=>delete d.baselineModules['index.mjs'].type,d=>d.candidateModules['../escape']={sha256:hash('escape'),type:js}]) {
    const data=fixture();mutate(data);assert.throws(()=>validatePreservedDeployment(data));
  }
});
