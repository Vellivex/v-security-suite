import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {SessionScope} from '../web/session.js';
const source=(await readFile(new URL('../web/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function element(value=''){const handlers=new Map();return {value,disabled:false,hidden:false,required:false,textContent:'',dataset:{},files:[],addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);},emit(type,event={}){return Promise.all((handlers.get(type)||[]).map(fn=>fn({preventDefault(){},target:this,...event})));}};}
function setup(kind='vault',overrides={}){
 const ids=['app-status','clear-session','result','copy-result','offline-enable'];
 if(kind==='vault')ids.push('vault-form','vault-mode','message','passphrase','passphrase-confirm','vault-submit','result-label','download-result','confirm-wrap','message-label');
 else ids.push('relay-form','relay-package','relay-file','share-package','download-package');
 const els=Object.fromEntries(ids.map(id=>[id,element()]));if(kind==='vault'){els['vault-mode'].value='encrypt';els.message.value='Original synthetic draft';els.passphrase.value=els['passphrase-confirm'].value='a synthetic passphrase 123';}
 const document=element();document.hidden=false;document.getElementById=id=>els[id]||null;
 document.querySelectorAll=selector=>selector==='[data-sensitive]'?['message','passphrase','passphrase-confirm','relay-package','result'].filter(id=>els[id]).map(id=>els[id]):[];
 const window=element(),cryptoWork=deferred(),copyWork=deferred();
 const context={document,window,crypto,URL,Blob,setTimeout:()=>1,SessionScope:class extends SessionScope{constructor(onLock){super(onLock,{schedule:()=>1,cancel:()=>{}});}},encryptMessage:()=>cryptoWork.promise,decryptMessage:()=>cryptoWork.promise,inspectEnvelope:()=>({}),navigator:{clipboard:{writeText:()=>copyWork.promise}},...overrides};
 vm.runInNewContext(source,context);return {els,document,window,cryptoWork,copyWork};
}
test('editing a draft while crypto is pending preserves new input and suppresses old result',async()=>{const t=setup();const pending=t.els['vault-form'].emit('submit');t.els.message.value='A new synthetic draft';await t.els.message.emit('input');t.cryptoWork.resolve('old encrypted result');await pending;assert.equal(t.els.message.value,'A new synthetic draft');assert.equal(t.els.result.value,'');assert.equal(t.els['vault-submit'].disabled,false);});
test('a crypto result cannot repopulate the page after hiding it',async()=>{const t=setup();const pending=t.els['vault-form'].emit('submit');t.document.hidden=true;await t.document.emit('visibilitychange');t.cryptoWork.resolve('sensitive old result');await pending;assert.equal(t.els.result.value,'');assert.equal(t.els.message.value,'');assert.equal(t.els.passphrase.value,'');assert.match(t.els['app-status'].textContent,/locked/);});
test('a file read completing after clear cannot restore its package',async()=>{const fileRead=deferred(),t=setup('relay');t.els['relay-file'].files=[{size:100,text:()=>fileRead.promise}];const pending=t.els['relay-file'].emit('change');await t.els['clear-session'].emit('click');fileRead.resolve('old synthetic ciphertext');await pending;assert.equal(t.els['relay-package'].value,'');assert.equal(t.els.result.value,'');assert.equal(t.els['share-package'].disabled,true);});
test('clipboard completion cannot replace the locked status',async()=>{const t=setup();t.els.result.value='synthetic copied value';const pending=t.els['copy-result'].emit('click');await t.els['clear-session'].emit('click');const locked=t.els['app-status'].textContent;t.copyWork.resolve();await pending;assert.equal(t.els['app-status'].textContent,locked);});
test('edit, clear and repeated submit cannot multiply unfinished crypto jobs',async()=>{let calls=0;const work=deferred(),t=setup('vault',{encryptMessage:()=>{calls++;return work.promise;}});const first=t.els['vault-form'].emit('submit');for(let i=0;i<30;i++){t.els.message.value='edited '+i;await t.els.message.emit('input');await t.els['clear-session'].emit('click');await t.els['vault-form'].emit('submit');assert.equal(t.els['vault-submit'].disabled,true);}assert.equal(calls,1);work.resolve('stale result');await first;assert.equal(t.els.result.value,'');assert.equal(t.els['vault-submit'].disabled,false);});

test('seeded lock/edit/mode/restore schedules never publish a retired crypto result',async()=>{
 let seed=0x191023;const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 for(let i=0;i<120;i++){
  const t=setup(),pending=t.els['vault-form'].emit('submit');
  const action=next()%4;
  if(action===0){t.document.hidden=true;await t.document.emit('visibilitychange');}
  else if(action===1)await t.window.emit('pageshow',{persisted:true});
  else if(action===2){t.els['vault-mode'].value='decrypt';await t.els['vault-mode'].emit('change');}
  else{t.els.message.value='New retained draft '+i;await t.els.message.emit('input');}
  assert.equal(t.els['vault-submit'].disabled,true);
  t.cryptoWork.resolve('Must never return to the page');await pending;
  assert.equal(t.els.result.value,'');assert.equal(t.els['vault-submit'].disabled,false);
  assert.equal(t.els.message.value,action===3?'New retained draft '+i:'');
 }
});

test('crypto rejection leaves the draft available and restores controls without stale output',async()=>{
 const t=setup('vault',{encryptMessage:()=>Promise.reject(Error('Synthetic key derivation refused'))});
 await t.els['vault-form'].emit('submit');assert.equal(t.els.message.value,'Original synthetic draft');assert.equal(t.els.result.value,'');assert.equal(t.els.passphrase.value,'');assert.equal(t.els['vault-submit'].disabled,false);assert.match(t.els['app-status'].textContent,/refused/);
});
test('late crypto rejection after locking cannot clear a newer passphrase or replace locked status',async()=>{
 let reject;const failure=new Promise((_,r)=>{reject=r;});const t=setup('vault',{encryptMessage:()=>failure});const pending=t.els['vault-form'].emit('submit');
 await t.els['clear-session'].emit('click');const status=t.els['app-status'].textContent;t.els.message.value='New draft';t.els.passphrase.value='New synthetic phrase';await t.els.passphrase.emit('input');reject(Error('Late failure'));await pending;
 assert.equal(t.els.passphrase.value,'New synthetic phrase');assert.equal(t.els.message.value,'New draft');assert.equal(t.els.result.value,'');assert.equal(t.els['app-status'].textContent,status);assert.equal(t.els['vault-submit'].disabled,false);
});
test('a rejected file read removes earlier transfer state and cannot enable sharing',async()=>{
 const t=setup('relay');t.els.result.value='previous package';t.els['relay-package'].value='previous package';t.els['relay-file'].files=[{size:100,text:()=>Promise.reject(Error('Synthetic file read failed'))}];await t.els['relay-file'].emit('change');
 assert.equal(t.els.result.value,'');assert.equal(t.els['relay-package'].value,'');assert.equal(t.els['download-package'].disabled,true);assert.equal(t.els['share-package'].disabled,true);assert.match(t.els['app-status'].textContent,/failed/);
});
test('out-of-order file reads cannot replace the newest selected package',async()=>{
 const a=deferred(),b=deferred(),t=setup('relay');t.els['relay-file'].files=[{size:100,text:()=>a.promise}];const old=t.els['relay-file'].emit('change');t.els['relay-file'].files=[{size:100,text:()=>b.promise}];const latest=t.els['relay-file'].emit('change');
 b.resolve('Newest synthetic envelope');await latest;a.resolve('Old synthetic envelope');await old;assert.equal(t.els['relay-package'].value,'Newest synthetic envelope');assert.equal(t.els.result.value,'');assert.equal(t.els['share-package'].disabled,true);
});
test('late share rejection cannot replace a cleared session status',async()=>{
 let reject;const share=new Promise((_,r)=>{reject=r;});const t=setup('relay',{navigator:{share:()=>share}});t.els.result.value='synthetic package';const pending=t.els['share-package'].emit('click');await t.els['clear-session'].emit('click');const status=t.els['app-status'].textContent;reject(Error('Synthetic sharing failure'));await pending;assert.equal(t.els['app-status'].textContent,status);assert.equal(t.els.result.value,'');
});

for(const kind of ['vault','relay'])for(const outcome of ['success','failure'])test(`${kind}: offline ${outcome} cannot replace locked status`,async()=>{
 let resolve,reject;const pendingWork=new Promise((a,b)=>{resolve=a;reject=b;});
 const t=setup(kind,{installOfflineTools:()=>pendingWork});const pending=t.els['offline-enable'].emit('click');
 await t.els['clear-session'].emit('click');const status=t.els['app-status'].textContent;
 if(outcome==='success')resolve({waiting:true});else reject(Error('Late offline failure'));
 await pending;assert.equal(t.els['app-status'].textContent,status);assert.equal(t.els['offline-enable'].textContent,'');
});

for(const kind of ['vault','relay'])test(`${kind}: current offline completion still reports installation`,async()=>{
 const t=setup(kind,{installOfflineTools:async()=>({waiting:true})});await t.els['offline-enable'].emit('click');
 assert.match(t.els['app-status'].textContent,/installed with integrity checks/);assert.equal(t.els['offline-enable'].textContent,'Check offline files for updates');
});

for(const kind of ['vault','relay'])test(`${kind}: repeated offline clicks and lock cannot multiply unfinished installation jobs`,async()=>{
 let calls=0;const work=deferred(),t=setup(kind,{installOfflineTools:()=>{calls++;return work.promise;}});
 const first=t.els['offline-enable'].emit('click');assert.equal(t.els['offline-enable'].disabled,true);
 for(let i=0;i<12;i++){await t.els['clear-session'].emit('click');await t.els['offline-enable'].emit('click');}
 assert.equal(calls,1);const status=t.els['app-status'].textContent;work.resolve({waiting:true});await first;
 assert.equal(t.els['app-status'].textContent,status);assert.equal(t.els['offline-enable'].disabled,false);
 await t.els['offline-enable'].emit('click');assert.equal(calls,2);assert.equal(t.els['offline-enable'].disabled,false);
});
for(const kind of ['vault','relay'])test(`${kind}: offline failure releases its button for a deliberate retry`,async()=>{
 let calls=0;const t=setup(kind,{installOfflineTools:()=>{calls++;return Promise.reject(Error('Synthetic install failure'));}});
 await t.els['offline-enable'].emit('click');assert.equal(t.els['offline-enable'].disabled,false);assert.match(t.els['app-status'].textContent,/install failure/);
 await t.els['offline-enable'].emit('click');assert.equal(calls,2);assert.equal(t.els['offline-enable'].disabled,false);
});
