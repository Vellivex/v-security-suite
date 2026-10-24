// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental passphrase-based envelope. Uses browser Web Crypto exclusively.
export const ITERATIONS = 600000;
export const MAX_PLAINTEXT = 128 * 1024;
const aad = new TextEncoder().encode('VVAULT:1:PBKDF2-SHA256:600000:AES-256-GCM');
const encoder = new TextEncoder();
function requireWellFormed(text) {
  for (let i=0;i<text.length;i++) {
    const unit=text.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new Error('Text contains an incomplete Unicode character. Please re-enter it.');}
    else if(unit>=0xdc00&&unit<=0xdfff)throw new Error('Text contains an incomplete Unicode character. Please re-enter it.');
  }
}
function base64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function unbase64(text, min, max) {
  if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid encrypted package.');
  const raw = atob(text);
  if (raw.length < min || raw.length > max) throw new Error('Invalid encrypted package.');
  if (btoa(raw)!==text) throw new Error('Encrypted package must use canonical base64.');
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
// JSON.parse keeps only the last duplicate member. Reject ambiguous top-level
// names (including escaped spellings) rather than relaying a parser-dependent
// package. JSON syntax has already been validated before this scan runs.
function rejectDuplicateMembers(text) {
  const tokens=text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)||[];
  const names=new Set();let depth=0,expectKey=false;
  for(const token of tokens){
    if(token==='{'||token==='['){depth++;if(depth===1)expectKey=true;}
    else if(token==='}'||token===']')depth--;
    else if(depth===1&&token===',')expectKey=true;
    else if(depth===1&&expectKey&&token[0]==='"'){
      const name=JSON.parse(token);if(names.has(name))throw new Error('Encrypted package contains duplicate fields.');
      names.add(name);expectKey=false;
    }
  }
}
export function inspectEnvelope(text) {
  if (typeof text !== 'string' || text.length > 200000) throw new Error('Encrypted package is too large.');
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Choose a valid VVault encrypted package.'); }
  const keys = ['format','version','kdf','iterations','cipher','salt','iv','ciphertext'];
  if (!obj || Array.isArray(obj) || Object.keys(obj).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(obj,k)) || obj.format !== 'VVAULT' || obj.version !== 1 || obj.kdf !== 'PBKDF2-SHA256' || obj.iterations !== ITERATIONS || obj.cipher !== 'AES-256-GCM') throw new Error('Unsupported or invalid encrypted package.');
  rejectDuplicateMembers(text);
  const salt = unbase64(obj.salt,16,16), iv = unbase64(obj.iv,12,12), ciphertext = unbase64(obj.ciphertext,16,MAX_PLAINTEXT+16);
  return {salt, iv, ciphertext};
}
async function derive(passphrase,salt,usage) {
  if (typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error('Invalid passphrase.');
  requireWellFormed(passphrase);
  const material = encoder.encode(passphrase);
  try {
    const key = await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt},key,{name:'AES-GCM',length:256},false,[usage]);
  } finally { material.fill(0); }
}
export async function encryptMessage(message,passphrase) {
  if (typeof message !== 'string' || !message.length) throw new Error('Write a message first.');
  if(message.length>MAX_PLAINTEXT)throw new Error('Keep messages below 128 KiB.');
  if (typeof passphrase!=='string'||passphrase.length>1024) throw new Error('Invalid passphrase.');
  if (passphrase.length < 14) throw new Error('Use at least 14 characters, preferably four or more random words.');
  requireWellFormed(message);requireWellFormed(passphrase);
  const bytes=encoder.encode(message);
  if (bytes.length>MAX_PLAINTEXT) throw new Error('Keep messages below 128 KiB.');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  try {
    const key=await derive(passphrase,salt,'encrypt');
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,bytes);
    return JSON.stringify({format:'VVAULT',version:1,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,cipher:'AES-256-GCM',salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(encrypted))});
  } finally {bytes.fill(0);}
}
export async function decryptMessage(text,passphrase) {
  const {salt,iv,ciphertext}=inspectEnvelope(text);
  const key=await derive(passphrase,salt,'decrypt');
  let bytes;
  try {bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,ciphertext));}
  catch {throw new Error('Unable to unlock. The passphrase is wrong or the package has changed.');}
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}finally{bytes.fill(0);}
}
