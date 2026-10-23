import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptMessage,decryptMessage,inspectEnvelope,MAX_PLAINTEXT} from '../apps/vault/crypto.js';
const phrase='test-only four random orchard words 123';
test('Unicode and multiline messages round-trip; random envelopes differ',async()=>{const message='Test message 🛡️\n第二行\nZero: \u0000';const a=await encryptMessage(message,phrase),b=await encryptMessage(message,phrase);assert.notEqual(a,b);assert.equal(await decryptMessage(a,phrase),message);});
test('wrong passphrase and modified ciphertext are rejected',async()=>{const encrypted=await encryptMessage('Non-sensitive test text',phrase);await assert.rejects(decryptMessage(encrypted,'a different wrong passphrase'));const obj=JSON.parse(encrypted);const bytes=Uint8Array.from(atob(obj.ciphertext),x=>x.charCodeAt(0));bytes[0]^=1;obj.ciphertext=Buffer.from(bytes).toString('base64');await assert.rejects(decryptMessage(JSON.stringify(obj),phrase));});
test('modified nonce, salt and format rejected',async()=>{const original=JSON.parse(await encryptMessage('A test envelope',phrase));for(const field of ['iv','salt']){const obj={...original};const bytes=Buffer.from(obj[field],'base64');bytes[0]^=1;obj[field]=bytes.toString('base64');await assert.rejects(decryptMessage(JSON.stringify(obj),phrase));}for(const patch of [{iterations:1},{version:2},{cipher:'AES-CBC'},{format:'other'},{kdf:'other'},{extra:true},{iv:'bad'}, {salt:'AAAA'}])assert.throws(()=>inspectEnvelope(JSON.stringify({...original,...patch})));});
test('malformed/oversized envelopes and plaintext rejected before expensive work',async()=>{for(const input of ['null','[]','{}','bad','x'.repeat(200001)])assert.throws(()=>inspectEnvelope(input));await assert.rejects(encryptMessage('message','short'));await assert.rejects(encryptMessage('',phrase));await assert.rejects(encryptMessage('a'.repeat(MAX_PLAINTEXT+1),phrase));});
test('maximum-size message round-trips at the documented boundary',async()=>{const message='a'.repeat(MAX_PLAINTEXT);const encrypted=await encryptMessage(message,phrase);assert.equal(await decryptMessage(encrypted,phrase),message);});
test('unpaired Unicode surrogates cannot silently change messages or alias passphrases',async()=>{const valid=await encryptMessage('Valid synthetic message',phrase);for(const malformed of ['\ud800','\udfff','before\ud800after','\ud800\ud800','\udc00\ud800']){await assert.rejects(encryptMessage(malformed,phrase),/Unicode/);await assert.rejects(encryptMessage('test message',phrase+malformed),/Unicode/);await assert.rejects(decryptMessage(valid,phrase+malformed),/Unicode/);}const message='Valid astral characters 🛡️🧪';assert.equal(await decryptMessage(await encryptMessage(message,phrase+'🧪'),phrase+'🧪'),message);});

test('leading BOM and control characters are preserved exactly after authenticated decryption',async()=>{
 for(const message of ['\ufeffLeading marker','\ufeff\ufefftwo markers','\u0000\r\n\t\ufeff🛡️','\ufeff'])assert.equal(await decryptMessage(await encryptMessage(message,phrase),phrase),message);
});
test('duplicate and escaped duplicate envelope members are rejected without rejecting whitespace or order',async()=>{
 const encrypted=await encryptMessage('Synthetic ambiguity check',phrase),obj=JSON.parse(encrypted);
 for(const prefix of ['"version":999,','"version":1,','"ver\\u0073ion":1,','"ciphertext":"AAAA",'])assert.throws(()=>inspectEnvelope('{'+prefix+encrypted.slice(1)),/duplicate/);
 assert.doesNotThrow(()=>inspectEnvelope(JSON.stringify(Object.fromEntries(Object.entries(obj).reverse()),null,2)));
 assert.equal(await decryptMessage(JSON.stringify(obj,null,2),phrase),'Synthetic ambiguity check');
});
test('seeded malformed envelope mutations stay bounded and cannot pass unchecked',async()=>{
 const original=JSON.parse(await encryptMessage('Synthetic mutation target',phrase));let state=0x6e2c19b5;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
 const fields=['format','version','kdf','iterations','cipher','salt','iv','ciphertext'];
 const invalid=[null,{},[],true,false,0,-1,'',String.fromCharCode(0),'!'.repeat(40),'A'.repeat(200001)];
 for(let i=0;i<2000;i++){const field=fields[rand()%fields.length],obj={...original,[field]:invalid[rand()%invalid.length]};assert.throws(()=>inspectEnvelope(JSON.stringify(obj)));}
 for(let i=0;i<100;i++){const obj={...original};delete obj[fields[rand()%fields.length]];assert.throws(()=>inspectEnvelope(JSON.stringify(obj)));}
});

test('authenticated decryption rejects bit flips, truncation and cross-envelope splicing',async()=>{
 const a=JSON.parse(await encryptMessage('Synthetic authenticated attack target 🛡️',phrase));
 const b=JSON.parse(await encryptMessage('Different independently encrypted message',phrase));
 let rejected=0;const ciphertext=Buffer.from(a.ciphertext,'base64');
 for(let i=0;i<24;i++){const bytes=Buffer.from(ciphertext);bytes[Math.floor(i*bytes.length/24)]^=1<<(i%8);await assert.rejects(decryptMessage(JSON.stringify({...a,ciphertext:bytes.toString('base64')}),phrase));rejected++;}
 for(const field of ['salt','iv','ciphertext']){await assert.rejects(decryptMessage(JSON.stringify({...a,[field]:b[field]}),phrase));rejected++;}
 for(let n=1;n<=8;n++){await assert.rejects(decryptMessage(JSON.stringify({...a,ciphertext:ciphertext.subarray(0,-n).toString('base64')}),phrase));rejected++;}
 assert.equal(rejected,35);
});
test('noncanonical base64 aliases and hostile field types never pass structural validation',async()=>{
 const obj=JSON.parse(await encryptMessage('Synthetic canonical field test',phrase));
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
 const alias=obj.salt.slice(0,-3)+alphabet[alphabet.indexOf(obj.salt.at(-3))+1]+'==';
 assert.deepEqual(Buffer.from(alias,'base64'),Buffer.from(obj.salt,'base64'));
 assert.throws(()=>inspectEnvelope(JSON.stringify({...obj,salt:alias})),/canonical/);
 for(const field of ['salt','iv','ciphertext'])for(const bad of [null,[],{},true,16,' '+obj[field],obj[field]+'\n',obj[field].replace(/=/g,''),obj[field]+'AAAA']){
  if(bad===obj[field]||field==='iv'&&bad===obj[field].replace(/=/g,''))continue;
  // Appending complete ciphertext bytes is structurally valid, but must fail GCM.
  if(field==='ciphertext'&&bad===obj[field]+'AAAA'&&!obj[field].includes('='))continue;
  assert.throws(()=>inspectEnvelope(JSON.stringify({...obj,[field]:bad})));
 }
});
