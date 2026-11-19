// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialise, seal, unseal } from '../live-input-envelope.mjs';

function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'vellivex-live-envelope-test-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const privateDirectory=path.join(base,'private');
  const publicFile=path.join(base,'public.json');
  const timestamp=Math.floor(Date.now()/1000);
  const descriptor=initialise(privateDirectory,publicFile,'12345678901',1,'a'.repeat(40),timestamp);
  return {base,privateDirectory,publicFile,timestamp,descriptor};
}

test('received email and code survive authenticated sealing without public plaintext',t=>{
  const f=fixture(t);
  for(const [purpose,payload] of [['email',{email:'disposable-check@example.org'}],['code',{code:'84620017'}]]){
    const envelope=seal(f.descriptor,'A',purpose,payload,f.timestamp);
    const serialized=JSON.stringify(envelope);
    assert.ok(!serialized.includes(Object.values(payload)[0]));
    assert.deepEqual(unseal(f.privateDirectory,envelope,f.timestamp),{opened:true,role:'A',purpose});
    const result=path.join(f.privateDirectory,'inbox',`A-${purpose}.json`);
    assert.deepEqual(JSON.parse(fs.readFileSync(result)).payload,payload);
    assert.equal(fs.statSync(result).mode&0o777,0o600);
    assert.equal(fs.statSync(result+'.ready').mode&0o777,0o600);
  }
  assert.equal(fs.statSync(f.privateDirectory).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(f.privateDirectory,'private-key.pem')).mode&0o777,0o600);
  assert.ok(!fs.readFileSync(f.publicFile,'utf8').includes('PRIVATE KEY'));
});

test('wrong run, attempt, head, session and key fail before installing private input',t=>{
  const f=fixture(t), envelope=seal(f.descriptor,'A','code',{code:'84620017'},f.timestamp);
  for(const [key,value] of [['run_id','99999999999'],['run_attempt',2],['head_sha','b'.repeat(40)],
      ['session_id','c'.repeat(24)],['key_id','d'.repeat(64)]]){
    const altered=structuredClone(envelope);altered[key]=value;
    assert.throws(()=>unseal(f.privateDirectory,altered,f.timestamp));
  }
  assert.deepEqual(fs.readdirSync(path.join(f.privateDirectory,'inbox')),[]);
});

test('role, purpose, nonce and expiry metadata are authenticated',t=>{
  const f=fixture(t), envelope=seal(f.descriptor,'A','code',{code:'84620017'},f.timestamp);
  for(const [key,value] of [['role','B'],['purpose','email'],['nonce','f'.repeat(32)],
      ['issued_at',f.timestamp+1],['expires_at',f.timestamp+299]]){
    const altered=structuredClone(envelope);altered.metadata[key]=value;
    assert.throws(()=>unseal(f.privateDirectory,altered,f.timestamp));
  }
  assert.deepEqual(fs.readdirSync(path.join(f.privateDirectory,'inbox')),[]);
});

test('ciphertext, wrapped key, nonce and authentication tag tampering fail closed',t=>{
  const f=fixture(t), envelope=seal(f.descriptor,'A','code',{code:'84620017'},f.timestamp);
  for(const key of ['ciphertext','encrypted_key','iv','tag']){
    const altered=structuredClone(envelope), bytes=Buffer.from(altered[key],'base64');
    bytes[0]^=1;altered[key]=bytes.toString('base64');
    assert.throws(()=>unseal(f.privateDirectory,altered,f.timestamp));
  }
  assert.deepEqual(fs.readdirSync(path.join(f.privateDirectory,'inbox')),[]);
});

test('expired codes and a longer than 300 second envelope are rejected',t=>{
  const f=fixture(t), envelope=seal(f.descriptor,'A','code',{code:'84620017'},f.timestamp);
  assert.equal(envelope.metadata.expires_at-envelope.metadata.issued_at,300);
  assert.throws(()=>unseal(f.privateDirectory,envelope,f.timestamp+300));
  const extended=structuredClone(envelope);extended.metadata.expires_at=f.timestamp+301;
  assert.throws(()=>unseal(f.privateDirectory,extended,f.timestamp));
  assert.deepEqual(fs.readdirSync(path.join(f.privateDirectory,'inbox')),[]);
});

test('replayed envelopes and replacement inputs cannot overwrite accepted private data',t=>{
  const f=fixture(t), envelope=seal(f.descriptor,'A','code',{code:'84620017'},f.timestamp);
  unseal(f.privateDirectory,envelope,f.timestamp);
  assert.throws(()=>unseal(f.privateDirectory,envelope,f.timestamp));
  assert.throws(()=>unseal(f.privateDirectory,seal(f.descriptor,'A','code',{code:'10000001'},f.timestamp),f.timestamp));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.privateDirectory,'inbox','A-code.json'))).payload.code,'84620017');
});

test('each run has a different ephemeral key and cannot open another run envelope',t=>{
  const first=fixture(t),second=fixture(t);
  assert.notEqual(first.descriptor.key_id,second.descriptor.key_id);
  assert.notEqual(first.descriptor.session_id,second.descriptor.session_id);
  assert.throws(()=>unseal(second.privateDirectory,seal(first.descriptor,'A','code',{code:'84620017'},first.timestamp),second.timestamp));
});

test('private key replacement cannot authenticate input even with the expected descriptor',t=>{
  const first=fixture(t),second=fixture(t);
  const envelope=seal(first.descriptor,'A','code',{code:'84620017'},first.timestamp);
  fs.copyFileSync(path.join(second.privateDirectory,'private-key.pem'),path.join(first.privateDirectory,'private-key.pem'));
  assert.throws(()=>unseal(first.privateDirectory,envelope,first.timestamp));
  assert.deepEqual(fs.readdirSync(path.join(first.privateDirectory,'inbox')),[]);
});

test('CLI failure prints a fixed diagnostic and never its malformed private stdin',t=>{
  const f=fixture(t),script=fileURLToPath(new URL('../live-input-envelope.mjs',import.meta.url));
  const secret='PRIVATE_INPUT_MUST_NOT_APPEAR';
  const result=spawnSync(process.execPath,[script,'seal',f.publicFile,'A','code',path.join(f.base,'sealed.json')],
    {input:secret,encoding:'utf8'});
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.equal(result.stderr,'Live-test input operation failed; no private input was printed.\n');
  assert.ok(!result.stderr.includes(secret));
  assert.equal(fs.existsSync(path.join(f.base,'sealed.json')),false);
});
