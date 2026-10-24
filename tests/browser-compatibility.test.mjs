import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const vaultURL=new URL('../apps/vault/crypto.js',import.meta.url).href;
const cipherURL=new URL('../apps/cipher/protocol.js',import.meta.url).href;
const setup=`
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const disableNewBuiltins=()=>{
  Object.hasOwn=undefined;
  Array.prototype.at=undefined;
  String.prototype.isWellFormed=undefined;
};
`;
function isolated(source){
  const result=spawnSync(process.execPath,['--input-type=module','--eval',setup+source],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr||result.stdout);
}

test('VVault validates and unlocks real envelopes without newer convenience builtins',()=>isolated(`
disableNewBuiltins();
const {encryptMessage,decryptMessage,inspectEnvelope}=await import(${JSON.stringify(vaultURL)});
const phrase='synthetic compatibility orchard 🧪',plain='\\ufeffCafé 🔐\\n<b>plain text</b>\\u0000';
const encrypted=await encryptMessage(plain,phrase),value=JSON.parse(encrypted);
assert.equal(inspectEnvelope(encrypted).iv.length,12);
assert.equal(await decryptMessage(encrypted,phrase),plain);
await assert.rejects(decryptMessage(encrypted,'incorrect compatibility phrase'),/Unable to unlock/);
assert.throws(()=>inspectEnvelope(JSON.stringify({...value,extra:true})),/Unsupported/);
const {ciphertext,...missing}=value;
assert.throws(()=>inspectEnvelope(JSON.stringify({...missing,hasOwnProperty:'untrusted'})),/Unsupported/);
assert.throws(()=>inspectEnvelope('{"ver\\\\u0073ion":1,'+encrypted.slice(1)),/duplicate/);
for(const malformed of ['\\ud800','\\udfff','before\\ud800after','\\ud800\\ud800','\\udc00\\ud800']){
  await assert.rejects(encryptMessage(malformed,phrase),/Unicode/);
  await assert.rejects(encryptMessage('synthetic',phrase+malformed),/Unicode/);
}
`));

test('V Cipher parsing retains nested duplicate and shape checks without Array.at or Object.hasOwn',()=>isolated(`
disableNewBuiltins();
const {parse,generateIdentity,importCard,inspectTransfer}=await import(${JSON.stringify(cipherURL)});
assert.deepEqual(parse('{"outer":{"value":1},"items":[{"x":2}]}'),{outer:{value:1},items:[{x:2}]});
for(const text of ['{"a":{"x":1,"x":2}}','{"a":{"x":1,"\\\\u0078":2}}','['.repeat(10)+'0'+']'.repeat(10)])assert.throws(()=>parse(text),/Invalid/);
const identity=await generateIdentity(),card=JSON.stringify(identity.card);
assert.equal((await importCard(card)).fingerprint,identity.fingerprint);
assert.equal(await inspectTransfer(card),'contact');
await assert.rejects(importCard(JSON.stringify({...identity.card,extra:true})),/Invalid/);
await assert.rejects(importCard(JSON.stringify({...identity.card,enc:{...identity.card.enc,d:'private'}})),/Invalid/);
`));

test('V Cipher backup and authenticated Unicode messaging work without String.isWellFormed',()=>isolated(`
const {generateIdentity,exportIdentity,importIdentity,seal,open}=await import(${JSON.stringify(cipherURL)});
const alice=await generateIdentity(),bob=await generateIdentity();
disableNewBuiltins();
const phrase='synthetic backup maple lantern 🧪',secret='synthetic conversation river quartz',plain='\\ufeffCafé 🔐\\n<b>plain text</b>\\u0000';
const backup=await exportIdentity(alice,phrase),restored=await importIdentity(backup,phrase);
assert.equal(restored.fingerprint,alice.fingerprint);
assert.equal(restored.dec.extractable,false);
assert.equal(restored.sign.extractable,false);
const message=await seal(restored,JSON.stringify(bob.card),plain,secret);
assert.equal(await open(bob,JSON.stringify(alice.card),message,secret),plain);
await assert.rejects(open(bob,JSON.stringify(alice.card),message,'incorrect conversation phrase'),/Unable to unlock/);
await assert.rejects(importIdentity(backup,'incorrect compatibility backup phrase'),/Backup could not/);
const altered=JSON.parse(message),bytes=Buffer.from(altered.cipher,'base64');bytes[0]^=1;altered.cipher=bytes.toString('base64');
await assert.rejects(open(bob,JSON.stringify(alice.card),JSON.stringify(altered),secret),/signature/);
for(const malformed of ['\\ud800','\\udfff','before\\ud800after','\\ud800\\ud800','\\udc00\\ud800']){
  await assert.rejects(exportIdentity(alice,phrase+malformed),/well-formed/);
  await assert.rejects(importIdentity(backup,phrase+malformed),/well-formed/);
  await assert.rejects(seal(alice,JSON.stringify(bob.card),malformed,secret),/well-formed/);
  await assert.rejects(seal(alice,JSON.stringify(bob.card),'synthetic',secret+malformed),/Unicode/);
}
`));
