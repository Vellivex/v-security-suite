import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {page} from '../server/pages.js';import {SessionScope} from '../web/session.js';
const source=(await readFile(new URL('../web/cipher-ui.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function el(){const handlers=new Map();return {value:'',textContent:'',checked:false,dataset:{},files:[],hidden:false,width:1,height:1,async play(){},getContext(){return {clearRect(){}};},addEventListener(t,fn){if(!handlers.has(t))handlers.set(t,[]);handlers.get(t).push(fn);},emit(t,e={}){return Promise.all((handlers.get(t)||[]).map(fn=>fn({target:this,...e})));}};}
function setup(role='vault',overrides={}){const html=page('/apps/cipher/'+role),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]),els=Object.fromEntries(ids.map(id=>[id,el()]));const sensitive=[...html.matchAll(/<(?:input|textarea)\b[^>]*data-cipher-sensitive[^>]*>/g)].map(m=>/\bid="([^"]+)"/.exec(m[0])?.[1]).filter(Boolean);const document=el(),window=el();document.hidden=false;document.getElementById=id=>els[id]||null;document.querySelector=()=>({dataset:{cipherRole:role}});document.querySelectorAll=()=>sensitive.map(id=>els[id]);document.createElement=()=>({click(){}});const nav={onLine:false,serviceWorker:{controller:{}},mediaDevices:{getUserMedia:()=>Promise.reject(Error('No synthetic camera'))}};const calls={generate:0};const context={document,window,navigator:nav,SessionScope:class extends SessionScope{constructor(lock){super(lock,{schedule:()=>1,cancel(){}});}},Collector:class{reset(){}async add(){return {received:1,total:2};}},generateIdentity:async()=>{calls.generate++;return {card:{type:'test'},fingerprint:'synthetic-fingerprint'};},exportIdentity:async()=>'{"synthetic":true}',hardenIdentity:async identity=>identity,importIdentity:async()=>({card:{type:'test'},fingerprint:'synthetic-fingerprint'}),importCard:async()=>({fingerprint:'synthetic-contact'}),inspectTransfer:async()=> 'message',framesFor:async()=>['synthetic-frame'],drawQR(){},decodePixels:()=>null,installOfflineTools:async()=>({unchanged:true}),requestAnimationFrame:()=>1,cancelAnimationFrame(){},URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},Blob,setTimeout:()=>1,...overrides};vm.runInNewContext(source,context);if(els['offline-confirm'])els['offline-confirm'].checked=true;if(els['identity-password'])els['identity-password'].value=els['identity-confirm'].value='synthetic backup password 123';return {els,document,window,nav,calls};}
test('Vault blocks key generation online or without offline confirmation',async()=>{for(const mode of ['online','unconfirmed']){const t=setup();if(mode==='online')t.nav.onLine=true;else t.els['offline-confirm'].checked=false;await t.els['cipher-generate'].emit('click');assert.equal(t.calls.generate,0);assert.match(t.els['cipher-status'].textContent,/disconnect all networks/i);}});
test('late identity generation cannot repopulate a locked or reconnected Vault',async()=>{for(const action of ['lock','online']){const work=deferred(),t=setup('vault',{generateIdentity:()=>work.promise});const pending=t.els['cipher-generate'].emit('click');if(action==='lock')await t.els['cipher-lock'].emit('click');else await t.window.emit('online');work.resolve({card:{type:'test'},fingerprint:'old identity'});await pending;assert.equal(t.els['identity-card'].value,'');assert.equal(t.els['identity-password'].value,'');assert.match(t.els['identity-fingerprint'].textContent,/No identity/);}});
test('late camera permission after lock stops the acquired tracks',async()=>{const work=deferred();let stopped=0;const t=setup('relay');t.nav.mediaDevices.getUserMedia=()=>work.promise;const pending=t.els['scan-start'].emit('click');await t.els['cipher-lock'].emit('click');work.resolve({getTracks:()=>[{stop(){stopped++;}}]});await pending;assert.equal(stopped,1);assert.equal(t.els['scan-video'].srcObject,null);});
test('older camera denial cannot stop or replace a newer active camera session',async()=>{const a=deferred(),b=deferred();let count=0,stopped=0;const t=setup('relay');t.nav.mediaDevices.getUserMedia=()=>++count===1?a.promise:b.promise;const old=t.els['scan-start'].emit('click'),latest=t.els['scan-start'].emit('click');const stream={getTracks:()=>[{stop(){stopped++;}}]};b.resolve(stream);await latest;const status=t.els['cipher-status'].textContent;a.reject(Error('Old camera refusal'));await old;assert.equal(t.els['scan-video'].srcObject,stream);assert.equal(stopped,0);assert.equal(t.els['cipher-status'].textContent,status);await t.els['cipher-lock'].emit('click');assert.equal(stopped,1);});
test('newest transfer file wins and a later rejection cannot restore an old package',async()=>{const a=deferred(),b=deferred(),t=setup('relay');t.els['transfer-file'].files=[{size:100,text:()=>a.promise}];const old=t.els['transfer-file'].emit('change');t.els['transfer-file'].files=[{size:100,text:()=>b.promise}];const latest=t.els['transfer-file'].emit('change');b.resolve('new encrypted package');await latest;a.resolve('old encrypted package');await old;assert.equal(t.els['transfer-input'].value,'new encrypted package');t.els['transfer-file'].files=[{size:100,text:()=>Promise.reject(Error('Synthetic failure'))}];await t.els['transfer-file'].emit('change');assert.equal(t.els['transfer-input'].value,'');});
test('Relay page has no identity password, conversation secret or plaintext input',()=>{const html=page('/apps/cipher/relay');for(const id of ['identity-password','conversation-secret','cipher-plain','cipher-backup'])assert.ok(!html.includes('id="'+id+'"'));});
test('switching from camera scanning to another operation stops the invalidated camera',async()=>{let stopped=0;const t=setup('relay');t.nav.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){stopped++;}}]});await t.els['scan-start'].emit('click');t.els['transfer-input'].value='synthetic transfer';await t.els['relay-qr'].emit('click');assert.equal(stopped,1);assert.equal(t.els['scan-video'].srcObject,null);});
test('a completed incoming QR clears the previously displayed outgoing transfer',async()=>{const t=setup('relay',{Collector:class{reset(){}async add(){return {received:1,total:1,text:'new incoming package'};}}});t.els['transfer-input'].value='old outgoing package';await t.els['relay-qr'].emit('click');assert.notEqual(t.els['qr-frame-text'].value,'');await t.els['scan-frame'].emit('click');assert.equal(t.els['transfer-input'].value,'new incoming package');assert.equal(t.els['qr-frame-text'].value,'');assert.equal(t.els['qr-count'].textContent,'No QR transfer.');});
test('retired decryption cannot mark an undisplayed message as replayed',async()=>{const work=deferred(),sizes=[];let calls=0;const t=setup('vault',{open:async(mine,card,text,secret,tracker)=>{sizes.push(tracker.size);if(++calls===1)await work.promise;tracker.add('synthetic message id');return 'synthetic plaintext';}});await t.els['cipher-generate'].emit('click');t.els['contact-card'].value='synthetic public card';await t.els['cipher-contact'].emit('click');t.els['contact-confirm'].checked=true;const pending=t.els['cipher-decrypt'].emit('click');t.els['cipher-incoming'].value='new package';await t.els['cipher-incoming'].emit('input');work.resolve();await pending;assert.equal(t.els['cipher-result'].value,'');await t.els['cipher-decrypt'].emit('click');assert.deepEqual(sizes,[0,0]);});
test('camera cannot replace inputs while cryptographic work is pending',async()=>{const work=deferred();let requested=0;const t=setup('vault',{generateIdentity:()=>work.promise});t.nav.mediaDevices.getUserMedia=async()=>{requested++;return {getTracks:()=>[{stop(){}}]};};const pending=t.els['cipher-generate'].emit('click');await t.els['scan-start'].emit('click');assert.equal(requested,0);work.resolve({card:{type:'test'},fingerprint:'new identity'});await pending;});
test('camera start retires an older pending transfer file',async()=>{const work=deferred(),t=setup('relay');t.els['transfer-file'].files=[{size:100,text:()=>work.promise}];const pending=t.els['transfer-file'].emit('change');t.nav.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});await t.els['scan-start'].emit('click');work.resolve('retired file');await pending;assert.equal(t.els['transfer-input'].value,'');});
test('stopping camera retires pending decoded frame verification',async()=>{const work=deferred();let loop;const t=setup('relay',{requestAnimationFrame:fn=>{loop=fn;return 1;},decodePixels:()=> 'synthetic frame',Collector:class{reset(){}add(){return work.promise;}}});t.nav.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});Object.assign(t.els['scan-video'],{readyState:2,videoWidth:1,videoHeight:1});t.els['scan-canvas'].getContext=()=>({drawImage(){},getImageData(){return {data:new Uint8ClampedArray(4)};}});await t.els['scan-start'].emit('click');const pending=loop(500);await t.els['scan-stop'].emit('click');work.resolve({received:1,total:1,text:'retired camera transfer'});await pending;assert.equal(t.els['transfer-input'].value,'');assert.equal(t.els['cipher-status'].textContent,'Camera stopped.');});
test('backup selection stops active camera tracks',async()=>{let stopped=0;const t=setup('vault');t.nav.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){stopped++;}}]});await t.els['scan-start'].emit('click');await t.els['cipher-backup'].emit('change');assert.equal(stopped,1);assert.equal(t.els['scan-video'].srcObject,null);});
test('pending plaintext stays unpublished across seven session and camera cancellation boundaries',async()=>{for(const boundary of ['lock','hidden','pagehide','online','unconfirm','backup','stop']){const work=deferred();const t=setup('vault',{open:async(mine,card,text,secret,tracker)=>{await work.promise;tracker.add('synthetic id');return 'must stay hidden';}});await t.els['cipher-generate'].emit('click');t.els['contact-card'].value='synthetic card';await t.els['cipher-contact'].emit('click');t.els['contact-confirm'].checked=true;const pending=t.els['cipher-decrypt'].emit('click');if(boundary==='lock')await t.els['cipher-lock'].emit('click');if(boundary==='hidden'){t.document.hidden=true;await t.document.emit('visibilitychange');}if(boundary==='pagehide')await t.window.emit('pagehide');if(boundary==='online')await t.window.emit('online');if(boundary==='unconfirm'){t.els['offline-confirm'].checked=false;await t.els['offline-confirm'].emit('change');}if(boundary==='backup')await t.els['cipher-backup'].emit('change');if(boundary==='stop')await t.els['scan-stop'].emit('click');work.resolve();await pending;assert.equal(t.els['cipher-result'].value,'',boundary);}});
test('pending backup unlock cannot restore identity after lock, file change or reconnection',async()=>{for(const boundary of ['lock','backup','online']){const work=deferred(),t=setup('vault',{importIdentity:()=>work.promise});t.els['cipher-backup'].files=[{size:100,text:async()=> 'synthetic backup'}];const pending=t.els['cipher-unlock'].emit('click');if(boundary==='lock')await t.els['cipher-lock'].emit('click');if(boundary==='backup')await t.els['cipher-backup'].emit('change');if(boundary==='online')await t.window.emit('online');work.resolve({card:{type:'test'},fingerprint:'retired identity'});await pending;assert.equal(t.els['identity-card'].value,'',boundary);}});
test('revoking contact confirmation cancels pending plaintext and clears prior output',async()=>{const work=deferred(),t=setup('vault',{open:async()=>{await work.promise;return 'revoked-contact plaintext';}});await t.els['cipher-generate'].emit('click');t.els['contact-card'].value='synthetic card';await t.els['cipher-contact'].emit('click');t.els['contact-confirm'].checked=true;const pending=t.els['cipher-decrypt'].emit('click');t.els['contact-confirm'].checked=false;await t.els['contact-confirm'].emit('change');work.resolve();await pending;assert.equal(t.els['cipher-result'].value,'');});
test('editing a pasted frame retires pending verification of the previous frame',async()=>{const work=deferred(),t=setup('relay',{Collector:class{reset(){}add(){return work.promise;}}});t.els['scan-frame-input'].value='old frame';const pending=t.els['scan-frame'].emit('click');t.els['scan-frame-input'].value='new frame';await t.els['scan-frame-input'].emit('input');work.resolve({received:1,total:1,text:'retired transfer'});await pending;assert.equal(t.els['transfer-input'].value,'');});
test('failed encrypted-backup download cannot leave a newly generated identity usable',async()=>{
 for(const failure of ['url','click']){
  const t=setup('vault',failure==='url'?{URL:{createObjectURL(){throw Error('Synthetic backup URL failure');}}}:{});
  if(failure==='click')t.document.createElement=()=>({click(){throw Error('Synthetic backup click failure');}});
  await t.els['cipher-generate'].emit('click');
  assert.equal(t.calls.generate,1);assert.equal(t.els['identity-card'].value,'',failure);assert.match(t.els['cipher-status'].textContent,/No new identity was activated/,failure);
  assert.doesNotMatch(t.els['identity-fingerprint'].textContent,/Your identity fingerprint/,failure);
  t.els['contact-card'].value='synthetic contact';await t.els['cipher-contact'].emit('click');t.els['contact-confirm'].checked=true;
  await t.els['cipher-encrypt'].emit('click');assert.match(t.els['cipher-status'].textContent,/Create or unlock your identity first/,failure);
 }
});
test('successful encrypted-backup request still activates the generated identity',async()=>{
 const t=setup();await t.els['cipher-generate'].emit('click');assert.equal(t.calls.generate,1);
 assert.equal(t.els['identity-card'].value,'{"type":"test"}');assert.match(t.els['identity-fingerprint'].textContent,/Your identity fingerprint/);assert.match(t.els['cipher-status'].textContent,/backup download requested/);
});
test('a lock during the backup download request cannot resurrect the generated identity',async()=>{
 const t=setup();t.document.createElement=()=>({click(){void t.els['cipher-lock'].emit('click');}});
 await t.els['cipher-generate'].emit('click');assert.equal(t.els['identity-card'].value,'');assert.match(t.els['identity-fingerprint'].textContent,/No identity unlocked/);assert.match(t.els['cipher-status'].textContent,/Session locked/);
});
for(const failure of ['create','href','name','click','timer'])test(`Cipher download ${failure} failure releases its object URL`,async()=>{
 const revoked=[];const t=setup('relay',{URL:{createObjectURL:()=> 'blob:synthetic-cipher',revokeObjectURL:url=>revoked.push(url)},...(failure==='timer'?{setTimeout(){throw Error('Synthetic timer failure');}}:{})});
 t.document.createElement=()=>{if(failure==='create')throw Error('Synthetic create failure');return {set href(value){if(failure==='href')throw Error('Synthetic href failure');},set download(value){if(failure==='name')throw Error('Synthetic name failure');},click(){if(failure==='click')throw Error('Synthetic click failure');}};};
 t.els['transfer-input'].value='Synthetic public transfer';await t.els['relay-save'].emit('click');assert.deepEqual(revoked,['blob:synthetic-cipher']);assert.match(t.els['cipher-status'].textContent,/failure/);
});
test('successful Cipher download keeps its URL until the scheduled cleanup',async()=>{
 let cleanup;const revoked=[];const t=setup('relay',{URL:{createObjectURL:()=> 'blob:synthetic-cipher',revokeObjectURL:url=>revoked.push(url)},setTimeout:fn=>{cleanup=fn;return 1;}});t.els['transfer-input'].value='Synthetic public transfer';await t.els['relay-save'].emit('click');assert.deepEqual(revoked,[]);cleanup();assert.deepEqual(revoked,['blob:synthetic-cipher']);
});
test('failed private-key hardening cannot download or activate a generated identity',async()=>{
 const t=setup('vault',{hardenIdentity:async()=>{throw Error('Synthetic key protection failure');}});let downloads=0;t.document.createElement=()=>({click(){downloads++;}});
 await t.els['cipher-generate'].emit('click');assert.equal(downloads,0);assert.equal(t.els['identity-card'].value,'');assert.doesNotMatch(t.els['identity-fingerprint'].textContent,/Your identity/);assert.match(t.els['cipher-status'].textContent,/No new identity was activated/);
});
test('a lock while private-key hardening is pending prevents identity activation and download',async()=>{
 const work=deferred(),started=deferred(),t=setup('vault',{hardenIdentity:()=>{started.resolve();return work.promise;}});let downloads=0;t.document.createElement=()=>({click(){downloads++;}});
 const pending=t.els['cipher-generate'].emit('click');await started.promise;await t.els['cipher-lock'].emit('click');work.resolve({card:{type:'test'},fingerprint:'retired protected identity'});await pending;
 assert.equal(downloads,0);assert.equal(t.els['identity-card'].value,'');assert.match(t.els['cipher-status'].textContent,/Session locked/);
});
test('a newly generated identity is hardened before its backup download and activation',async()=>{
 let hardened=false,downloaded=false;const t=setup('vault',{hardenIdentity:async identity=>{hardened=true;return {...identity,fingerprint:'protected identity'};}});t.document.createElement=()=>({click(){assert.equal(hardened,true);assert.equal(t.els['identity-card'].value,'');downloaded=true;}});
 await t.els['cipher-generate'].emit('click');assert.equal(downloaded,true);assert.match(t.els['identity-fingerprint'].textContent,/protected identity/);
});
test('retired backup file reads cannot start password or identity work after cancellation',async()=>{
 for(const boundary of ['lock','online','backup','hidden','pagehide','restored','unconfirm','edit']){
  const read=deferred();let imports=0;
  const t=setup('vault',{importIdentity:async()=>{imports++;return {card:{type:'test'},fingerprint:'retired identity'};}});
  t.els['cipher-backup'].files=[{size:100,text:()=>read.promise}];
  const pending=t.els['cipher-unlock'].emit('click');
  if(boundary==='lock')await t.els['cipher-lock'].emit('click');
  if(boundary==='online'){t.nav.onLine=true;await t.window.emit('online');}
  if(boundary==='backup'){t.els['cipher-backup'].files=[{size:100,text:async()=> 'new backup'}];await t.els['cipher-backup'].emit('change');}
  if(boundary==='hidden'){t.document.hidden=true;await t.document.emit('visibilitychange');}
  if(boundary==='pagehide')await t.window.emit('pagehide');
  if(boundary==='restored')await t.window.emit('pageshow',{persisted:true});
  if(boundary==='unconfirm'){t.els['offline-confirm'].checked=false;await t.els['offline-confirm'].emit('change');}
  if(boundary==='edit'){t.els['identity-password'].value='new synthetic backup phrase';await t.els['identity-password'].emit('input');}
  const status=t.els['cipher-status'].textContent;
  read.resolve('retired encrypted backup');await pending;
  assert.equal(imports,0,boundary);assert.equal(t.els['identity-card'].value,'',boundary);
  assert.equal(t.els['cipher-status'].textContent,status,boundary);
  if(boundary==='edit')assert.equal(t.els['identity-password'].value,'new synthetic backup phrase');
 }
});
test('an uninterrupted backup file read still unlocks exactly once and clears its passphrase',async()=>{
 const read=deferred();let imports=0;
 const t=setup('vault',{importIdentity:async(text,password)=>{imports++;assert.equal(text,'synthetic encrypted backup');assert.equal(password,'synthetic backup password 123');return {card:{type:'test'},fingerprint:'loaded identity'};}});
 t.els['cipher-backup'].files=[{size:100,text:()=>read.promise}];const pending=t.els['cipher-unlock'].emit('click');
 read.resolve('synthetic encrypted backup');await pending;
 assert.equal(imports,1);assert.match(t.els['identity-fingerprint'].textContent,/loaded identity/);
 assert.equal(t.els['identity-password'].value,'');assert.equal(t.els['identity-confirm'].value,'');
 assert.match(t.els['cipher-status'].textContent,/Identity unlocked locally/);
});
test('retired Relay file reads cannot start transfer inspection or replace newer state',async()=>{
 for(const boundary of ['new-file','edit','lock','camera']){
  const read=deferred(),inspected=[];
  const t=setup('relay',{inspectTransfer:async text=>{inspected.push(text);return 'message';}});
  t.els['transfer-file'].files=[{size:100,text:()=>read.promise}];const pending=t.els['transfer-file'].emit('change');
  if(boundary==='new-file'){t.els['transfer-file'].files=[{size:100,text:async()=> 'new synthetic package'}];await t.els['transfer-file'].emit('change');}
  if(boundary==='edit'){t.els['transfer-input'].value='new pasted package';await t.els['transfer-input'].emit('input');}
  if(boundary==='lock')await t.els['cipher-lock'].emit('click');
  if(boundary==='camera'){t.nav.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});await t.els['scan-start'].emit('click');}
  const status=t.els['cipher-status'].textContent,value=t.els['transfer-input'].value;
  read.resolve('retired synthetic package');await pending;
  assert.deepEqual(inspected,boundary==='new-file'?['new synthetic package']:[],boundary);
  assert.equal(t.els['transfer-input'].value,value,boundary);assert.equal(t.els['cipher-status'].textContent,status,boundary);
  await t.els['cipher-lock'].emit('click');
 }
});
