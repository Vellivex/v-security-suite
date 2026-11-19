#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// One-run confidential transport for operator-supplied live-test email addresses and codes.
// This does not alter the app's authentication or encryption. Only sealed envelopes go public.
import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Vellivex/v-security-suite';
const SUITE = 'vellivex-live-two-app';
const BRANCH = 'test/messenger-live-inputs';
const LABEL = Buffer.from('vellivex-live-input-v1', 'utf8');
const MAX_FILE = 16384;
const now = () => Math.floor(Date.now() / 1000);
const fail = () => { throw new Error('Invalid live-test input envelope'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail();
}
function readJson(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length > MAX_FILE) fail();
  return JSON.parse(bytes.toString('utf8'));
}
function writePrivate(filename, value) {
  fs.writeFileSync(filename, value, { mode: 0o600, flag: 'wx' });
}
function base64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) fail();
  return decoded;
}
function validateDescriptor(d, timestamp = now()) {
  exact(d, ['schema','suite','repository','run_id','run_attempt','head_sha','session_id',
    'created_at','expires_at','input_branch','key_id','public_key']);
  if (d.schema !== 1 || d.suite !== SUITE || d.repository !== REPOSITORY || d.input_branch !== BRANCH ||
      !/^[0-9]{1,20}$/.test(d.run_id) || !Number.isSafeInteger(d.run_attempt) || d.run_attempt < 1 ||
      !/^[0-9a-f]{40}$/.test(d.head_sha) || !/^[0-9a-f]{24}$/.test(d.session_id) ||
      !/^[0-9a-f]{64}$/.test(d.key_id) || !Number.isSafeInteger(d.created_at) ||
      !Number.isSafeInteger(d.expires_at) || d.created_at > timestamp + 30 ||
      d.expires_at <= timestamp || d.expires_at - d.created_at > 3600 || d.expires_at <= d.created_at) fail();
  const key = createPublicKey(d.public_key);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) fail();
  const digest = createHash('sha256').update(key.export({ type:'spki', format:'der' })).digest('hex');
  if (digest !== d.key_id) fail();
  return key;
}
function aad(d, m) {
  return Buffer.from(JSON.stringify({ schema:1, suite:SUITE, repository:REPOSITORY,
    run_id:d.run_id, run_attempt:d.run_attempt, head_sha:d.head_sha, session_id:d.session_id,
    key_id:d.key_id, role:m.role, purpose:m.purpose, nonce:m.nonce,
    issued_at:m.issued_at, expires_at:m.expires_at }), 'utf8');
}
function validatePayload(purpose, value) {
  if (purpose === 'email') {
    exact(value, ['email']);
    if (typeof value.email !== 'string' || value.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) ||
        /(?:\.test|\.invalid|\.example)$/i.test(value.email)) fail();
  } else if (purpose === 'code') {
    exact(value, ['code']);
    if (typeof value.code !== 'string' || !/^[0-9]{8}$/.test(value.code)) fail();
  } else fail();
}

export function initialise(privateDirectory, publicFile, runId, runAttempt, headSha, timestamp = now()) {
  if (!/^[0-9]{1,20}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
      !/^[0-9a-f]{40}$/.test(headSha)) fail();
  fs.mkdirSync(privateDirectory, { mode:0o700, recursive:false });
  const keys = generateKeyPairSync('rsa', { modulusLength:3072 });
  const descriptor = { schema:1, suite:SUITE, repository:REPOSITORY, run_id:runId,
    run_attempt:runAttempt, head_sha:headSha, session_id:randomBytes(12).toString('hex'),
    created_at:timestamp, expires_at:timestamp + 3600, input_branch:BRANCH,
    key_id:createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex'),
    public_key:keys.publicKey.export({type:'spki',format:'pem'}).toString() };
  writePrivate(path.join(privateDirectory,'private-key.pem'), keys.privateKey.export({type:'pkcs8',format:'pem'}));
  writePrivate(path.join(privateDirectory,'descriptor.json'), JSON.stringify(descriptor));
  fs.mkdirSync(path.join(privateDirectory,'inbox'), {mode:0o700});
  fs.mkdirSync(path.join(privateDirectory,'consumed'), {mode:0o700});
  fs.writeFileSync(publicFile, JSON.stringify(descriptor,null,2)+'\n', {mode:0o600,flag:'wx'});
  return descriptor;
}

export function seal(descriptor, role, purpose, payload, timestamp = now()) {
  const publicKey = validateDescriptor(descriptor, timestamp);
  if (!['A','B'].includes(role)) fail();
  validatePayload(purpose,payload);
  const metadata = {role,purpose,nonce:randomBytes(16).toString('hex'),issued_at:timestamp,
    expires_at:Math.min(timestamp + (purpose === 'code' ? 300 : 1200),descriptor.expires_at)};
  const secret = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',secret,iv,{authTagLength:16});
    cipher.setAAD(aad(descriptor,metadata));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
    return {schema:1,run_id:descriptor.run_id,run_attempt:descriptor.run_attempt,
      head_sha:descriptor.head_sha,session_id:descriptor.session_id,key_id:descriptor.key_id,metadata,
      encrypted_key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash:'sha256',oaepLabel:LABEL},secret).toString('base64'),
      iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  } finally {secret.fill(0);}
}

export function unseal(privateDirectory, envelope, timestamp = now()) {
  const descriptor = readJson(path.join(privateDirectory,'descriptor.json'));
  validateDescriptor(descriptor,timestamp);
  exact(envelope,['schema','run_id','run_attempt','head_sha','session_id','key_id','metadata',
    'encrypted_key','iv','ciphertext','tag']);
  if (envelope.schema !== 1 || ['run_id','run_attempt','head_sha','session_id','key_id']
    .some(k=>envelope[k]!==descriptor[k])) fail();
  const m=envelope.metadata;
  exact(m,['role','purpose','nonce','issued_at','expires_at']);
  if (!['A','B'].includes(m.role) || !['email','code'].includes(m.purpose) ||
      !/^[0-9a-f]{32}$/.test(m.nonce) || !Number.isSafeInteger(m.issued_at) ||
      !Number.isSafeInteger(m.expires_at) || m.issued_at > timestamp + 30 ||
      m.issued_at < descriptor.created_at - 30 ||
      m.expires_at <= timestamp || m.expires_at <= m.issued_at || m.expires_at > descriptor.expires_at ||
      m.expires_at-m.issued_at > (m.purpose==='code' ? 300 : 1200)) fail();
  const consumed = path.join(privateDirectory,'consumed',m.nonce);
  const output = path.join(privateDirectory,'inbox',`${m.role}-${m.purpose}.json`);
  if (fs.existsSync(consumed) || fs.existsSync(output)) fail();
  const privateKey = createPrivateKey(fs.readFileSync(path.join(privateDirectory,'private-key.pem')));
  const secret=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash:'sha256',oaepLabel:LABEL},base64(envelope.encrypted_key,384));
  if (secret.length!==32) fail();
  try {
    const decipher=createDecipheriv('aes-256-gcm',secret,base64(envelope.iv,12),{authTagLength:16});
    decipher.setAAD(aad(descriptor,m));
    decipher.setAuthTag(base64(envelope.tag,16));
    const encrypted=base64(envelope.ciphertext);
    if(encrypted.length>4096)fail();
    const plain=Buffer.concat([decipher.update(encrypted),decipher.final()]);
    let payload;
    try {payload=JSON.parse(plain.toString('utf8'));validatePayload(m.purpose,payload);}
    finally {plain.fill(0);}
    writePrivate(consumed,'consumed\n');
    writePrivate(output,JSON.stringify({metadata:m,payload}));
    writePrivate(output+'.ready','ready\n');
    return {opened:true,role:m.role,purpose:m.purpose};
  } finally {secret.fill(0);}
}

async function main() {
  const [command,...args]=process.argv.slice(2);
  if(command==='init'&&args.length===5){
    initialise(args[0],args[1],args[2],Number(args[3]),args[4]);
    process.stdout.write('Live-test public key created; private key retained only on this runner.\n');
  } else if(command==='seal'&&args.length===4){
    let input='';
    for await(const part of process.stdin){input+=part;if(Buffer.byteLength(input)>4096)fail();}
    const envelope=seal(readJson(args[0]),args[1],args[2],JSON.parse(input));
    fs.writeFileSync(args[3],JSON.stringify(envelope,null,2)+'\n',{mode:0o600,flag:'wx'});
    process.stdout.write('Sealed live-test input written.\n');
  } else if(command==='open'&&args.length===2){
    unseal(args[0],readJson(args[1]));
    process.stdout.write('Sealed live-test input accepted.\n');
  } else {
    process.stderr.write('Usage: live-input-envelope.mjs init PRIVATE_DIR PUBLIC_FILE RUN_ID ATTEMPT HEAD_SHA | seal PUBLIC_FILE ROLE PURPOSE OUTPUT_FILE < PRIVATE_JSON | open PRIVATE_DIR ENVELOPE_FILE\n');
    process.exitCode=2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{process.stderr.write('Live-test input operation failed; no private input was printed.\n');process.exitCode=1;});
}
