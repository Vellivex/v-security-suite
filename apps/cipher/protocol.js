// SPDX-License-Identifier: GPL-3.0-or-later
// Continuation of the recovered Private Line prototype; experimental, unaudited.
import {encryptMessage,decryptMessage} from '../vault/crypto.js';
const C=crypto.subtle,E=new TextEncoder(),D=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
export const MAX_MESSAGE=2048,MAX_TRANSFER=24576;
const fail=()=>{throw Error('Invalid V Cipher data.');};
export function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
export function parse(text,max=MAX_TRANSFER){
 if(typeof text!=='string'||text.length>max)fail();let value;try{value=JSON.parse(text);}catch{fail();}
 const tokens=text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)||[];
 const stack=[];for(const token of tokens){if(token==='{'||token==='['){if(stack.length>=8)fail();stack.push(token==='{'?{names:new Set(),key:true}:null);}else if(token==='}'||token===']')stack.pop();else{const top=stack.at(-1);if(top&&token===',')top.key=true;else if(top?.key&&token.startsWith('"')){const name=JSON.parse(token);if(top.names.has(name))fail();top.names.add(name);top.key=false;}}}
 return value;
}
function shape(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();}
export function b64(bytes){let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s);}
export function un64(s,min,max){if(typeof s!=='string'||s.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail();const raw=atob(s);if(raw.length<min||raw.length>max||btoa(raw)!==s)fail();return Uint8Array.from(raw,c=>c.charCodeAt(0));}
function jwkBytes(s,n){if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))fail();const raw=un64(s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4),n,n);return raw;}
function publicFields(v,kind){
 const allowed=kind==='RSA'?['kty','n','e','alg','ext','key_ops']:['kty','crv','x','y','ext','key_ops'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail();
 if(v.kty!==kind||v.ext!==true||!Array.isArray(v.key_ops)||v.key_ops.length!==1||v.key_ops[0]!== (kind==='RSA'?'encrypt':'verify'))fail();
 if(kind==='RSA'){jwkBytes(v.n,384);if(v.e!=='AQAB'||v.alg!=='RSA-OAEP-256')fail();}else{if(v.crv!=='P-256')fail();jwkBytes(v.x,32);jwkBytes(v.y,32);}
}
export async function importCard(text){const card=parse(text,5000);shape(card,['type','enc','sig']);if(card.type!=='PLCONTACT1')fail();publicFields(card.enc,'RSA');publicFields(card.sig,'EC');
 const encrypt=await C.importKey('jwk',card.enc,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']),verify=await C.importKey('jwk',card.sig,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 if(encrypt.algorithm.modulusLength!==3072)fail();const fingerprint=b64(await C.digest('SHA-256',E.encode(canonical(card))));return {card,encrypt,verify,fingerprint};}
export async function generateIdentity(){const a=await C.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']),b=await C.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const card={type:'PLCONTACT1',enc:await C.exportKey('jwk',a.publicKey),sig:await C.exportKey('jwk',b.publicKey)},pub=await importCard(JSON.stringify(card));return {...pub,dec:a.privateKey,sign:b.privateKey};}
async function passwordKey(pass,salt){if(typeof pass!=='string'||pass.length<14||pass.length>1024||!pass.isWellFormed())throw Error('Use a well-formed passphrase of 14–1,024 characters.');const bytes=E.encode(pass);try{const k=await C.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);return await C.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},k,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{bytes.fill(0);}}
const backupAAD=card=>E.encode(canonical({type:'VCVAULT2',card}));
export async function exportIdentity(mine,pass){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await passwordKey(pass,salt);const bytes=E.encode(JSON.stringify({dec:await C.exportKey('jwk',mine.dec),sign:await C.exportKey('jwk',mine.sign)}));try{return JSON.stringify({type:'VCVAULT2',card:mine.card,salt:b64(salt),iv:b64(iv),cipher:b64(await C.encrypt({name:'AES-GCM',iv,additionalData:backupAAD(mine.card)},key,bytes))});}finally{bytes.fill(0);}}
// Validate redundant private-key representations before the platform imports them.
// Some providers use CRT fields and silently ignore an inconsistent RSA d.
function privateKeys(secrets,card){
 const r=secrets.dec,e=secrets.sign;
 shape(r,['kty','n','e','d','p','q','dp','dq','qi','alg','ext','key_ops']);
 shape(e,['kty','crv','x','y','d','ext','key_ops']);
 if(r.kty!=='RSA'||r.alg!=='RSA-OAEP-256'||r.ext!==true||r.n!==card.enc.n||r.e!==card.enc.e||!Array.isArray(r.key_ops)||r.key_ops.length!==1||r.key_ops[0]!=='decrypt')fail();
 if(e.kty!=='EC'||e.crv!=='P-256'||e.ext!==true||e.x!==card.sig.x||e.y!==card.sig.y||!Array.isArray(e.key_ops)||e.key_ops.length!==1||e.key_ops[0]!=='sign')fail();jwkBytes(e.d,32);
 const integer=(value,max)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))fail();const bytes=un64(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4),1,max);if(bytes[0]===0)fail();return BigInt('0x'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''));};
 const n=integer(r.n,384),d=integer(r.d,384),p=integer(r.p,192),q=integer(r.q,192),dp=integer(r.dp,192),dq=integer(r.dq,192),qi=integer(r.qi,192);
 if(p<=2n||q<=2n||p===q||p%2n!==1n||q%2n!==1n||p*q!==n||d<=1n||d>=n||dp!==d%(p-1n)||dq!==d%(q-1n)||65537n*d%(p-1n)!==1n||65537n*d%(q-1n)!==1n||qi>=p||qi*q%p!==1n)fail();
}
export async function importIdentity(text,pass){const obj=parse(text,20000);shape(obj,['type','card','salt','iv','cipher']);if(obj.type!=='VCVAULT2')throw Error('Choose a V Cipher 2 encrypted backup. Legacy backups need a separately reviewed migration.');const pub=await importCard(JSON.stringify(obj.card)),salt=un64(obj.salt,16,16),iv=un64(obj.iv,12,12),cipher=un64(obj.cipher,16,12000),key=await passwordKey(pass,salt);let bytes;
 try{bytes=new Uint8Array(await C.decrypt({name:'AES-GCM',iv,additionalData:backupAAD(obj.card)},key,cipher));const secrets=parse(D.decode(bytes),12000);shape(secrets,['dec','sign']);privateKeys(secrets,obj.card);
 const dec=await C.importKey('jwk',secrets.dec,{name:'RSA-OAEP',hash:'SHA-256'},true,['decrypt']),sign=await C.importKey('jwk',secrets.sign,{name:'ECDSA',namedCurve:'P-256'},true,['sign']);
 // Bind restored private keys to the authenticated public card by actual operations.
 const challenge=crypto.getRandomValues(new Uint8Array(32)),wrapped=await C.encrypt({name:'RSA-OAEP'},pub.encrypt,challenge),opened=new Uint8Array(await C.decrypt({name:'RSA-OAEP'},dec,wrapped));
 if(opened.length!==challenge.length||opened.some((v,i)=>v!==challenge[i]))fail();opened.fill(0);
 const signature=await C.sign({name:'ECDSA',hash:'SHA-256'},sign,challenge);if(!await C.verify({name:'ECDSA',hash:'SHA-256'},pub.verify,signature,challenge))fail();challenge.fill(0);return {...pub,dec,sign};
 }catch{throw Error('Backup could not be unlocked or its identity did not match.');}finally{bytes?.fill(0);}}
function fp(s){if(typeof s!=='string')fail();return un64(s,32,32);}
export function inspectMessage(text){const v=parse(text);shape(v,['type','id','from','to','iv','wrapped','cipher','signature']);if(v.type!=='VCMESSAGE2'||typeof v.id!=='string'||v.id.length!==32||!/^[0-9a-f]{32}$/.test(v.id))fail();fp(v.from);fp(v.to);un64(v.iv,12,12);un64(v.wrapped,384,384);un64(v.cipher,16,6000);un64(v.signature,64,64);return v;}
export async function seal(mine,cardText,message,conversationSecret){if(typeof message!=='string'||!message.length||message.length>MAX_MESSAGE||!message.isWellFormed()||E.encode(message).length>MAX_MESSAGE)throw Error('Use a well-formed message of 1–2,048 UTF-8 bytes.');const recipient=await importCard(cardText);
 // The independent conversation secret is required cryptographically, inside the recipient layer.
 const inner=await encryptMessage(message,conversationSecret),aes=await C.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']),iv=crypto.getRandomValues(new Uint8Array(12));
 const id=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');const head={type:'VCMESSAGE2',id,from:mine.fingerprint,to:recipient.fingerprint},aad=E.encode(canonical(head));const raw=new Uint8Array(await C.exportKey('raw',aes));
 try{const v={...head,iv:b64(iv),wrapped:b64(await C.encrypt({name:'RSA-OAEP'},recipient.encrypt,raw)),cipher:b64(await C.encrypt({name:'AES-GCM',iv,additionalData:aad},aes,E.encode(inner)))};return JSON.stringify({...v,signature:b64(await C.sign({name:'ECDSA',hash:'SHA-256'},mine.sign,E.encode(canonical(v))))});}finally{raw.fill(0);}}
export async function open(mine,cardText,text,conversationSecret,seen=new Set()){
 const v=inspectMessage(text),sender=await importCard(cardText);if(v.to!==mine.fingerprint||v.from!==sender.fingerprint)throw Error('Sender or recipient does not match the verified contact.');const replay=v.from+':'+v.id;if(seen.has(replay))throw Error('This message was already opened in this session.');const {signature,...unsigned}=v;
 if(!await C.verify({name:'ECDSA',hash:'SHA-256'},sender.verify,un64(signature,64,64),E.encode(canonical(unsigned))))throw Error('Sender signature failed.');let raw,bytes;
 try{raw=new Uint8Array(await C.decrypt({name:'RSA-OAEP'},mine.dec,un64(v.wrapped,384,384)));const key=await C.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);const {type,id,from,to}=v;bytes=new Uint8Array(await C.decrypt({name:'AES-GCM',iv:un64(v.iv,12,12),additionalData:E.encode(canonical({type,id,from,to}))},key,un64(v.cipher,16,6000)));const message=await decryptMessage(D.decode(bytes),conversationSecret);if(!message.length||message.length>MAX_MESSAGE||E.encode(message).length>MAX_MESSAGE)throw Error('Received message exceeds the 2,048-byte plaintext limit or is empty.');if(seen.has(replay))throw Error("This message was already opened in this session.");if(seen.size>=1024)throw Error("Session replay tracker is full. Lock and reopen; replay history then resets.");seen.add(replay);return message;}finally{raw?.fill(0);bytes?.fill(0);}}
export async function inspectTransfer(text){const v=parse(text);if(!v||typeof v!=='object'||Array.isArray(v))fail();if(v.type==='PLCONTACT1'){await importCard(text);return 'contact';}if(v.type==='VCMESSAGE2'){inspectMessage(text);return 'message';}throw Error('Only public contact cards and encrypted V Cipher messages can cross QR. Private vault backups are refused.');}
