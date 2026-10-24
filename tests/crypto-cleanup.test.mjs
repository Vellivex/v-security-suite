import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../apps/vault/crypto.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const phrase='synthetic cleanup orchard lantern 123';

// Retain only synthetic encoded buffers so failure-path cleanup is observable.
// This checks best-effort array clearing, not secure erasure of browser memory.
function setup({randomFailure=0}={}){
  const encoded=[];let randomCalls=0,keyCalls=0;
  class ObservedEncoder extends TextEncoder{
    encode(text){const bytes=super.encode(text);encoded.push({text,bytes});return bytes;}
  }
  const context={TextEncoder:ObservedEncoder,TextDecoder,Uint8Array,btoa,atob,crypto:{
    getRandomValues(bytes){if(++randomCalls===randomFailure)throw Error('Synthetic randomness failure');bytes.fill(7);return bytes;},
    subtle:{importKey(){keyCalls++;throw Error('Unexpected key work');}}
  }};
  vm.runInNewContext(source+'\nthis.vault={encryptMessage,MAX_PLAINTEXT};',context);
  return {vault:context.vault,encoded,get randomCalls(){return randomCalls;},get keyCalls(){return keyCalls;}};
}

function cleared(t,message){
  const item=t.encoded.find(item=>item.text===message);
  assert.ok(item,'synthetic plaintext was encoded');
  assert.ok(item.bytes.length>0);
  assert.equal(item.bytes.every(byte=>byte===0),true,'temporary encoded plaintext must be cleared on rejection');
}

test('UTF-8 size rejection clears the encoded plaintext before any randomness or key work',async()=>{
  const t=setup(),message='é'.repeat(t.vault.MAX_PLAINTEXT/2+1);
  assert.ok(message.length<=t.vault.MAX_PLAINTEXT);
  await assert.rejects(t.vault.encryptMessage(message,phrase),/128 KiB/);
  assert.equal(t.randomCalls,0);assert.equal(t.keyCalls,0);cleared(t,message);
});

for(const [label,randomFailure] of [['salt',1],['nonce',2]])test(`failed ${label} randomness clears encoded plaintext without key work`,async()=>{
  const t=setup({randomFailure}),message='Synthetic temporary plaintext 🔐';
  await assert.rejects(t.vault.encryptMessage(message,phrase),/Synthetic randomness failure/);
  assert.equal(t.randomCalls,randomFailure);assert.equal(t.keyCalls,0);cleared(t,message);
});
