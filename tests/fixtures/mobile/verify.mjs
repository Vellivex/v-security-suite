// Public fictional fixtures only. This is a fixture check, not device evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {decryptMessage,inspectEnvelope} from '../../../apps/vault/crypto.js';

const read=name=>readFile(new URL(name,import.meta.url));
const names=['README.md','expected.json','malformed.json','tampered-ciphertext.vvault.json','valid.vvault.json','verify-independent.py','verify.mjs'];
const lines=(await read('SHA256SUMS.txt')).toString('utf8').trim().split('\n');
assert.equal(lines.length,names.length,'Checksum list must cover exactly the reviewed fixture pack');
const listed=[];
for(const line of lines){
  const match=/^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
  assert.ok(match,'Invalid checksum line');
  const [,expected,name]=match;
  assert.ok(names.includes(name),'Unexpected fixture file');
  listed.push(name);
  assert.equal(createHash('sha256').update(await read(name)).digest('hex'),expected,name);
}
assert.deepEqual(listed.sort(),[...names].sort(),'Duplicate or missing fixture checksum');
const info=JSON.parse(await read('expected.json'));
const valid=(await read('valid.vvault.json')).toString('utf8');
const tampered=(await read('tampered-ciphertext.vvault.json')).toString('utf8');
const malformed=(await read('malformed.json')).toString('utf8');
assert.equal(info.fixture_version,1);
assert.equal(Buffer.from(info.plaintext,'utf8').toString('base64'),info.plaintext_utf8_base64);
const original=JSON.parse(valid),changed=JSON.parse(tampered);
const originalBytes=Buffer.from(original.ciphertext,'base64');
originalBytes[0]^=1;
assert.deepEqual(changed,{...original,ciphertext:originalBytes.toString('base64')},'Tampered fixture must change exactly one ciphertext bit');
assert.equal(await decryptMessage(valid,info.passphrase),info.plaintext);
await assert.rejects(decryptMessage(valid,info.wrong_passphrase),/Unable to unlock/);
// Relay checks structure, so this deliberately altered ciphertext must still
// inspect successfully. Authentication is checked only by the recipient Vault.
assert.doesNotThrow(()=>inspectEnvelope(tampered));
await assert.rejects(decryptMessage(tampered,info.passphrase),/Unable to unlock/);
assert.throws(()=>inspectEnvelope(malformed),/Unsupported or invalid/);
await assert.rejects(decryptMessage(malformed,info.passphrase),/Unsupported or invalid/);
console.log('PASS: fixture SHA-256, exact Unicode/plaintext, wrong-passphrase and tamper rejection; malformed input rejected. No device tests performed.');
