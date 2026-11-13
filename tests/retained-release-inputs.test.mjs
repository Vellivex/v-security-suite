// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const script=fileURLToPath(new URL('../scripts/retained_release_inputs.py',import.meta.url));
const runner="import sys,json,runpy; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['verify'](sys.argv[2],json.load(sys.stdin))))";
async function fixture(fn){
  const root=await mkdtemp(join(tmpdir(),'vellivex-retained-'));
  const inputs=[];
  try {
    await mkdir(join(root,'releases'));
    for(const name of ['original.apk','historical-one.zip','historical-two.zip']){
      const data=Buffer.from('fictional test input '+name);
      await writeFile(join(root,'releases',name),data);
      inputs.push({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    }
    const run=()=>spawnSync('python3',['-c',runner,script,root],{input:JSON.stringify(inputs),encoding:'utf8'});
    await fn({root,inputs,run});
  } finally {await rm(root,{recursive:true,force:true});}
}

test('retained original pins agree with existing release checksum and APK metadata',async()=>{
  const r=spawnSync('python3',['-c',"import sys,runpy,json; print(json.dumps(runpy.run_path(sys.argv[1])['RETAINED_INPUTS']))",script],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const pins=JSON.parse(r.stdout);
  assert.deepEqual(pins.map(x=>x.name),['VGuard-0.1.3-candidate.apk','VGuard-0.1.1-Source-GPL.zip','VGuard-0.1.2-Source-GPL.zip']);
  const sums=await readFile(new URL('../releases/SHA256SUMS.txt',import.meta.url),'utf8');
  for(const pin of pins)assert.ok(sums.split('\n').includes(pin.sha256+'  '+pin.name));
  const report=JSON.parse(await readFile(new URL('../releases/VGuard-0.1.3-Build-Report.json',import.meta.url),'utf8'));
  assert.equal(pins[0].bytes,report.bytes);assert.equal(pins[0].sha256,report.sha256);
});

test('all exact retained inputs pass without modifying their bytes',()=>fixture(async({root,inputs,run})=>{
  const before=await Promise.all(inputs.map(x=>readFile(join(root,'releases',x.name))));
  const r=run();assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).passed,true);
  const after=await Promise.all(inputs.map(x=>readFile(join(root,'releases',x.name))));assert.deepEqual(after,before);
}));

test('missing retained input names the restore action and fails before packaging',()=>fixture(async({root,inputs,run})=>{
  await rm(join(root,'releases',inputs[1].name));const r=run();assert.notEqual(r.status,0);
  assert.match(r.stderr,/Missing retained release input: releases\/historical-one.zip/);
  assert.match(r.stderr,/Restore the exact original/);
}));

test('same-size tampering and wrong lengths cannot be repinned implicitly',async()=>{
  for(const delta of [0,-1,1])await fixture(async({root,inputs,run})=>{
    await writeFile(join(root,'releases',inputs[0].name),Buffer.alloc(inputs[0].bytes+delta,120));
    const r=run();assert.notEqual(r.status,0);assert.match(r.stderr,/pinned size|hash mismatch/);
  });
});

test('symbolic files, symbolic release directories and nonregular inputs are refused',async()=>{
  for(const kind of ['file-link','directory-link','directory'])await fixture(async({root,inputs,run})=>{
    const path=join(root,'releases',inputs[0].name);
    if(kind==='directory-link'){
      const real=join(root,'retained');await mkdir(real);
      await rm(join(root,'releases'),{recursive:true});await symlink(real,join(root,'releases'));
    }else{
      await rm(path);
      if(kind==='file-link')await symlink(join(root,'releases',inputs[1].name),path);
      else await mkdir(path);
    }
    const r=run();assert.notEqual(r.status,0);assert.match(r.stderr,/symbolic|regular file|directory/i);
  });
});

test('missing input stops the real build before later validation or output writes',()=>fixture(async({root})=>{
  const scripts=join(root,'scripts');await mkdir(scripts);
  await copyFile(new URL('../scripts/build.sh',import.meta.url),join(scripts,'build.sh'));
  await copyFile(script,join(scripts,'retained_release_inputs.py'));
  const marker=join(root,'downstream-ran');
  await writeFile(join(scripts,'public_identity_check.py'),`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`);
  await mkdir(join(root,'dist'));await writeFile(join(root,'dist','preserved.txt'),'keep existing output');
  const r=spawnSync('bash',[join(scripts,'build.sh')],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Missing retained release input: releases\/VGuard-0\.1\.3-candidate\.apk/);
  await assert.rejects(access(marker));
  assert.equal(await readFile(join(root,'dist','preserved.txt'),'utf8'),'keep existing output');
}));
