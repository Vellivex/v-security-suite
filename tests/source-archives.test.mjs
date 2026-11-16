import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,copyFile,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';

const top=['AGENTS.md','LICENSE','NOTICE','README.md','SECURITY.md','CONTRIBUTING.md','package.json'];
const release=['VGuard-Setup.txt','VGuard-Test-Report.txt','RELEASE-NOTES.txt','VGuard-0.1.3-Build-Report.json','VGuard-0.1.3-Package-Verification.txt','VGuard-0.1.3-Security-Notes.txt'];
const other=['VGuard-0.1.3-candidate.apk','VGuard-0.1.1-Source-GPL.zip','VGuard-0.1.2-Source-GPL.zip'];
const android = 'apps/messenger/android';
const gradleWrapper = `${android}/gradle/wrapper/gradle-wrapper.jar`;
const gradleWrapperFile = new URL(`../${gradleWrapper}`, import.meta.url);

async function addReviewedFile(root, path, contents) {
 const manifestPath = join(root, 'scripts/source-manifest.json');
 const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
 const destination = join(root, path);
 await mkdir(dirname(destination), {recursive: true});
 await writeFile(destination, contents);
 manifest.push(path);
 await writeFile(manifestPath, JSON.stringify(manifest));
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'vellivex-source-'));
 for(const dir of ['scripts','apps/vguard','web','server','tests','docs','.github','drizzle','releases'])await mkdir(join(root,dir),{recursive:true});
 const paths=[...top,...release.map(x=>'releases/'+x),'apps/vguard/safe.java','docs/review.md','scripts/source-archives.py','scripts/source-manifest.json'];
 for(const path of paths)await writeFile(join(root,path),path.endsWith('.json')?'{}':'synthetic public source');
 for(const name of other)await writeFile(join(root,'releases',name),'synthetic artifact');
 await copyFile(new URL('../scripts/source-archives.py',import.meta.url),join(root,'scripts/source-archives.py'));
 await writeFile(join(root,'scripts/source-manifest.json'),JSON.stringify(paths));
 return {root,run:()=>spawnSync('python3',[join(root,'scripts/source-archives.py')],{encoding:'utf8'})};
}
async function checked(fn){const t=await fixture();try{await fn(t);}finally{await rm(t.root,{recursive:true,force:true});}}
test('source archive retains reviewed public files and omits ignored build/signing directories',()=>checked(async t=>{
 for(const dir of ['apps/vguard/build','apps/vguard/.local-signing']){await mkdir(join(t.root,dir),{recursive:true});await writeFile(join(t.root,dir,'ignored.pem'),'synthetic ignored private material');}
 const r=t.run();assert.equal(r.status,0,r.stderr);
 const zip=spawnSync('python3',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist()))',join(t.root,'releases/V-Security-Source.zip')],{encoding:'utf8'});
 assert.match(zip.stdout,/docs\/review.md/);assert.doesNotMatch(zip.stdout,/ignored.pem|\.local-signing|\/build\//);
}));
test('source archive refuses external file and directory symlinks, including explicit top-level inputs',async()=>{
 for(const name of ['docs/review.md','docs/linked','LICENSE'])await checked(async t=>{
  const outside=await mkdtemp(join(tmpdir(),'vellivex-outside-'));
  try{const target=join(outside,'synthetic-secret.txt');await writeFile(target,'synthetic private bytes');await rm(join(t.root,name),{force:true});await symlink(name==='docs/linked'?outside:target,join(t.root,name));
   const r=t.run();assert.notEqual(r.status,0,`${name} must fail closed`);assert.match(r.stderr,/symlink/i);
  }finally{await rm(outside,{recursive:true,force:true});}
 });
});
test('source archive refuses private key and database suffixes regardless of case',async()=>{
 for(const name of ['identity.pem','signing.key','SIGNING.P12','feedback.sqlite','records.DB'])await checked(async t=>{
  await writeFile(join(t.root,'docs',name),'synthetic private bytes');const manifestPath=join(t.root,'scripts/source-manifest.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.push('docs/'+name);await writeFile(manifestPath,JSON.stringify(manifest));const r=t.run();assert.notEqual(r.status,0,`${name} must not publish`);
 });
});
test('source archive refuses unreviewed paths and missing manifest entries',async()=>{
 await checked(async t=>{await writeFile(join(t.root,'docs','unexpected.txt'),'synthetic data');assert.notEqual(t.run().status,0,'new files need explicit source review');});
 await checked(async t=>{await rm(join(t.root,'docs/review.md'));assert.notEqual(t.run().status,0,'a missing reviewed file must fail');});
});

test('source archive packages reviewed Messenger source and omits local runtime directories', () => checked(async t => {
 const reviewed = [
  'apps/messenger/NOTICE', `${android}/.gitattributes`, `${android}/gradle.properties`,
  `${android}/gradle/wrapper/gradle-wrapper.properties`, `${android}/gradlew`, `${android}/gradlew.bat`,
  `${android}/app/build.gradle.kts`, `${android}/app/src/main/Example.kt`,
 ];
 for (const path of reviewed) await addReviewedFile(t.root, path, 'synthetic public source');
 await addReviewedFile(t.root, gradleWrapper, await readFile(gradleWrapperFile));
 const runtimeFiles = ['.gradle/cache.bin', '.kotlin/session', '.venv/bin/python', '.runtime/auth.db'];
 for (const path of runtimeFiles) {
  const local = join(t.root, android, path);
  await mkdir(dirname(local), {recursive: true});
  await writeFile(local, 'synthetic ignored runtime bytes');
 }

 const result = t.run();
 assert.equal(result.status, 0, result.stderr);
 const archive = spawnSync('python3', ['-c', [
  'import json, sys, zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as bundle:',
  '    print(json.dumps({entry.filename: entry.external_attr >> 16 for entry in bundle.infolist()}))',
 ].join('\n'), join(t.root, 'releases/V-Security-Source.zip')], {encoding: 'utf8'});
 assert.equal(archive.status, 0, archive.stderr);
 const entries = JSON.parse(archive.stdout);
 for (const path of [...reviewed, gradleWrapper]) {
  assert.equal(entries[`v-security-suite/${path}`], path === `${android}/gradlew` ? 0o755 : 0o644, path);
 }
 for (const path of runtimeFiles) assert.ok(!(`v-security-suite/${android}/${path}` in entries), path);
}));

test('source archive refuses a modified wrapper and other JARs even when reviewed', async () => {
 const wrapper = await readFile(gradleWrapperFile);
 const tampered = Buffer.from(wrapper);
 tampered[tampered.length - 1] ^= 1;
 await checked(async t => {
  await addReviewedFile(t.root, gradleWrapper, tampered);
  const result = t.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Gradle wrapper SHA-256 mismatch/);
  await assert.rejects(readFile(join(t.root, 'releases/V-Security-Source.zip')), {code: 'ENOENT'});
 });
 await checked(async t => {
  await addReviewedFile(t.root, `${android}/gradle-wrapper.jar`, wrapper);
  const result = t.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unapproved source file type/);
 });
});

test('source archive refuses local properties and binary files disguised as Messenger source', async () => {
 for (const [path, contents, error] of [
  [`${android}/app/LOCAL.PROPERTIES`, 'sdk.dir=/private/path', /Private\/runtime input is forbidden/],
  [`${android}/app/src/main/Private.kt`, Buffer.from([0, 1, 2]), /Unexpected binary Messenger input/],
 ]) await checked(async t => {
  await addReviewedFile(t.root, path, contents);
  const result = t.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, error);
 });
});
