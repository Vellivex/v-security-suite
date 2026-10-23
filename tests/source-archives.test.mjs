import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,copyFile,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const top=['LICENSE','NOTICE','README.md','SECURITY.md','CONTRIBUTING.md','package.json'];
const release=['VGuard-Setup.txt','VGuard-Test-Report.txt','RELEASE-NOTES.txt','VGuard-0.1.3-Build-Report.json','VGuard-0.1.3-Package-Verification.txt','VGuard-0.1.3-Security-Notes.txt'];
const other=['VGuard-0.1.3-candidate.apk','VGuard-0.1.1-Source-GPL.zip','VGuard-0.1.2-Source-GPL.zip'];
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
