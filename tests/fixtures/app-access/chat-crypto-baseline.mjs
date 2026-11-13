// The conversation uses WebRTC DTLS. These helpers protect only its SDP setup.
const utf8 = new TextEncoder();
const decodeUtf8 = new TextDecoder('utf-8',{fatal:true});
export const PROTOCOL = 'private-line/v2';
export const MAX_TEXT = 4000;
export function encode64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
export function decode64(value,length) {
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length>40_000) throw new Error('Invalid invitation.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  if ((length!==undefined && bytes.byteLength!==length) || encode64(bytes)!==value) throw new Error('Invalid invitation.');
  return bytes;
}
export function randomValue(size=32) { return encode64(crypto.getRandomValues(new Uint8Array(size))); }
export function readInvitation(input,expectedOrigin) {
  const url = new URL(input);
  if (url.origin!==expectedOrigin || url.pathname!=='/' || url.search || url.username || url.password) throw new Error('Only invitation links for this app can be opened here.');
  const p = new URLSearchParams(url.hash.slice(1));
  if ([...p.keys()].sort().join(',')!=='i,k,r,v' || p.get('v')!=='1') throw new Error('This invitation link is incomplete. Copy the whole link.');
  const room=p.get('r'); const secret=p.get('k'); const inviteToken=p.get('i');
  decode64(room,16); decode64(secret,32); decode64(inviteToken,32);
  return {room,secret,inviteToken};
}
export async function deriveKeys(secret,room) {
  const bytes=decode64(secret,32); decode64(room,16);
  const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);
  bytes.fill(0);
  const salt=await crypto.subtle.digest('SHA-256',utf8.encode(`${PROTOCOL}|${room}`));
  const keys={};
  for (const role of ['host','guest']) keys[role]=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:utf8.encode(`${PROTOCOL}|signal|${role}`)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  return keys;
}
function aad(room,role) { return utf8.encode(`${PROTOCOL}|${room}|${role}|${role==='host'?'offer':'answer'}|0`); }
export function fingerprint(sdp) {
  if (typeof sdp!=='string' || sdp.length>18_000) throw new Error('Invalid connection details.');
  const lines=sdp.split(/\r?\n/).filter(line=>line.startsWith('a=fingerprint:'));
  if (lines.length!==1 || !/^a=fingerprint:sha-256 (?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(lines[0])) throw new Error('The peer did not supply a single SHA-256 certificate fingerprint.');
  const values=[lines[0].slice('a=fingerprint:sha-256 '.length).replaceAll(':','').toLowerCase()];
  const media=sdp.split(/\r?\n/).filter(line=>line.startsWith('m='));
  if (media.length!==1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0])) throw new Error('Only an encrypted text data connection is supported.');
  return values[0];
}
export async function sealSignal(keys,room,role,payload) {
  if (!['host','guest'].includes(role)) throw new Error('Invalid role.');
  fingerprint(payload.sdp);
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const data=utf8.encode(JSON.stringify(payload));
  if (data.byteLength>22_000) throw new Error('Connection details are too large.');
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(room,role),tagLength:128},keys[role],data);
  data.fill(0);
  return {v:1,role,seq:0,nonce:encode64(nonce),ciphertext:encode64(ciphertext)};
}
export async function openSignal(keys,room,role,value,now=Date.now()) {
  if (!value || Object.keys(value).sort().join(',')!=='ciphertext,nonce,role,seq,v' || value.v!==1 || value.seq!==0 || value.role!==role) throw new Error('Connection authentication failed.');
  let raw;
  try {
    raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(value.nonce,12),additionalData:aad(room,role),tagLength:128},keys[role],decode64(value.ciphertext)));
    if (raw.byteLength>22_000) throw new Error('size');
    const payload=JSON.parse(decodeUtf8.decode(raw));
    if (Object.keys(payload).sort().join(',')!=='expiresAt,name,sdp,type' || payload.type!==(role==='host'?'offer':'answer') ||
      typeof payload.name!=='string' || payload.name.length<1 || payload.name.length>32 || !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt<=now || payload.expiresAt>now+660_000) throw new Error('payload');
    fingerprint(payload.sdp); return payload;
  } catch { throw new Error('The invitation could not authenticate this connection, or it has expired. Start a new chat.'); }
  finally { raw?.fill(0); }
}
export async function verification(room,offer,answer) {
  decode64(room,16);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(`${PROTOCOL}|verify|${room}|${fingerprint(offer)}|${fingerprint(answer)}`)));
  const full=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  return {full,short:full.slice(0,32).match(/.{4}/g).join(' ')};
}
