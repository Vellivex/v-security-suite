// SPDX-License-Identifier: GPL-3.0-or-later
import {readFile,mkdtemp,cp,rm,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const [pinned,promoted,modules,signedApk] = process.argv.slice(2);
if (!signedApk) throw Error('Expected pre-promotion module, promoted module, production modules directory and signed Alpha10 APK.');
const work = await mkdtemp(join(tmpdir(),'vellivex-test-final-guide-'));
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const url = 'https://www.vellivex.com';
const path = '/downloads/Vellivex-Messenger-0.1.0-alpha10-universal.apk';
const env = {MESSENGER_RELEASES:{async head(){},async get(){}}};
const ctx = {waitUntil(p){p.catch(()=>{});}};
const get = (app,path,method='GET',environment=env) => app.fetch(new Request(url+path,{method}),environment,ctx);
const snapshot = async r => [r.status,[...r.headers],digest(Buffer.from(await r.arrayBuffer()))];
try {
  const sources = await Promise.all([pinned,promoted].map(file=>readFile(file,'utf8')));
  const moduleDigests = sources.map(s=>digest(Buffer.from(s)));
  assert.deepEqual(moduleDigests,[
    'f32d4242afb97710d99d99f5c7d99e682be7e44c5d805d0f879c984eca829484',
    '74c0ff6b43bf665ed10adeb8754913699901fdfdc0618e0e91fecd67e0f308dd',
  ]);
  const withoutCopy = s => s.replace(/function messengerDownloadButton\(\)[\s\S]*?\/\/ Android verifies/, '// Android verifies')
    .replace(/function messengerSetup\(downloadAvailable\)[\s\S]*?function catalogue\(/, 'function catalogue(');
  assert.equal(withoutCopy(sources[1]),withoutCopy(sources[0]),'Only release presentation functions may change');
  const apps=[];
  for(const [i,file] of [pinned,promoted].entries()){
    const dir=join(work,String(i));await cp(modules,dir,{recursive:true});await cp(file,join(dir,'phone-shop.mjs'));
    apps.push((await import(pathToFileURL(join(dir,'app-access-entry.mjs')))).default);
  }
  const [before,after]=apps;
  async function streamHash(stream){
    const h=createHash('sha256');
    for await(const chunk of stream)h.update(chunk);
    return h.digest('hex');
  }
  const apkSize=(await stat(signedApk)).size;
  const expected='c994d9243e2c9b9e4ffaade600096682991e16ce27f9e9648e5181f96ad52c65';
  const apkName='Vellivex-Messenger-0.1.0-alpha10-universal.apk';
  assert.equal(await streamHash(createReadStream(signedApk)),expected);
  const meta={key:apkName,version:'7e5de6f2f7e98cb60dc7b067953557cb',etag:'63734860e1a6e52ec91a805cada32148',
    size:111798288,httpMetadata:{contentType:'application/vnd.android.package-archive'},
    checksums:{sha256:Uint8Array.from(Buffer.from(expected,'hex')).buffer},customMetadata:{sha256:expected}};
  assert.equal(apkSize,meta.size);
  const available={MESSENGER_RELEASES:{
    async head(k){assert.equal(k,apkName);return meta;},
    async get(k,options){
      assert.equal(k,apkName);assert.equal(options.onlyIf.etagMatches,meta.etag);
      const r=options.range;
      const file=r?createReadStream(signedApk,{start:r.offset,end:r.offset+r.length-1}):createReadStream(signedApk);
      return {...meta,...(r?{range:r}:{}),body:Readable.toWeb(file)};
    },
  }};
  for(const worker of apps){
    const full=await get(worker,path,'GET',available);
    assert.equal(full.status,200);assert.equal(full.headers.get('Content-Length'),String(apkSize));
    assert.equal(full.headers.get('X-Content-SHA256'),expected);
    assert.equal(await streamHash(full.body),expected);
    const range=await worker.fetch(new Request(url+path,{headers:{Range:'bytes=55-115'}}),available,ctx);
    assert.equal(range.status,206);assert.equal(await streamHash(range.body),await streamHash(createReadStream(signedApk,{start:55,end:115})));
  }
  for(const p of ['/invite','/invite/manual','/.well-known/assetlinks.json','/privacy','/phones','/beta','/security','/phones-promotion.css',path,path+'/',path.replace('alpha10','alpha09'),'/downloads/Vellivex-Messenger-0.1.0-alpha08-arm64.apk']) {
    for(const method of ['GET','HEAD']) assert.deepEqual(await snapshot(await get(before,p,method)),await snapshot(await get(after,p,method)),p);
  }
  const changedHome = await (await get(after,'/')).text(), oldHome = await(await get(before,'/')).text();
  const hero=/<section id="vellivex-messenger-hero"[\s\S]*?<\/section>/;
  assert.equal(changedHome.replace(hero,'[hero]'),oldHome.replace(hero,'[hero]'));
  const guide=await(await get(after,'/messenger')).text();
  for(const text of [changedHome.match(hero)[0],guide]){
    assert.ok(text.includes('Alpha10 · Android 8.0+ (ARM64 or x86-64) · For invited testers'));
    assert.equal((text.match(/class="messenger-download"/g)||[]).length,1);
    assert.ok(text.includes('href="'+path+'">Download Alpha10 APK</a>'));
    assert.doesNotMatch(text,/Download Alpha09 APK/);
  }
  assert.match(guide,/update to Alpha10 and open your profile/);
  assert.match(guide,/An older screenshot keeps its original link/);
  assert.match(guide,/If an older QR code opens a list of Matrix apps/);
  assert.match(guide,/Copy contact ID/);
  assert.match(guide,/earlier Alpha09 test on two Android 15 emulators/);
  assert.match(guide,/If your camera opens the Vellivex page, tap <strong>Open in Vellivex<\/strong>/);
  assert.match(guide,/tapping Open in Vellivex in Chrome opened the signed Alpha10 app at sign-in after both a fresh install and an update from Alpha09/);
  assert.match(guide,/Message history warning/);
  assert.match(guide,/updates with an active session still need physical testing/);
  assert.ok(!(await(await get(after,'/messenger','GET',{})).text()).includes('Download Alpha10 APK'));
  assert.equal(await(await get(after,'/messenger','HEAD')).text(),'');
  console.log('Passed both exact signed APK reads, both range reads, guide and homepage checks, and all 24 unchanged GET/HEAD responses.');
} finally {await rm(work,{recursive:true,force:true});}
