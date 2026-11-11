// SPDX-License-Identifier: GPL-3.0-or-later
// Native-engine compatibility of local source. Fictional, in-memory test keys.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {firefox,webkit} from 'playwright';

const assets=new Map(await Promise.all([
  ['/apps/cipher/protocol.js','../apps/cipher/protocol.js'],
  ['/apps/vault/crypto.js','../apps/vault/crypto.js'],
].map(async([path,file])=>[path,await readFile(new URL(file,import.meta.url),'utf8')])));
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method!=='GET')return res.writeHead(405).end();
  if(path==='/')return res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}).end('<!doctype html><title>Vellivex fictional compatibility test</title>');
  if(!assets.has(path))return res.writeHead(404).end();
  res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(assets.get(path));
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const site='http://127.0.0.1:'+server.address().port;
const password='Fictional cross-engine backup orchard river 4361';
const secret='Fictional cross-engine conversation amber iris 8274';
const opened=[];
try{
  const peers=[];
  for(const [name,engine]of Object.entries({firefox,webkit})){
    const browser=await engine.launch({headless:true});opened.push(browser);
    const page=await browser.newPage();
    await page.goto(site);
    const identity=await page.evaluate(async password=>{
      window.qaModule=await import('/apps/cipher/protocol.js');
      window.qaOwn=await window.qaModule.generateIdentity();
      const backup=await window.qaModule.exportIdentity(window.qaOwn,password);
      await window.qaModule.hardenIdentity(window.qaOwn);
      return {card:JSON.stringify(window.qaOwn.card),fingerprint:window.qaOwn.fingerprint,backup};
    },password);
    assert.equal(Object.hasOwn(JSON.parse(identity.card).sig,'alg'),false);
    peers.push({name,page,identity});
    console.log('PASS '+name+' '+browser.version()+': native identity generation, canonical public card, encrypted backup, and protected session keys');
  }
  for(let i=0;i<2;i++){
    const own=peers[i],peer=peers[1-i];
    const result=await own.page.evaluate(async({card,backup,password,expected})=>{
      const imported=await window.qaModule.importCard(card);
      let wrongRejected=false;
      try{await window.qaModule.importIdentity(backup,'Wrong fictional backup passphrase');}catch{wrongRejected=true;}
      window.qaRestoredPeer=await window.qaModule.importIdentity(backup,password);
      return {contact:imported.fingerprint,restored:window.qaRestoredPeer.fingerprint,card:JSON.stringify(window.qaRestoredPeer.card),wrongRejected,privateExportable:window.qaRestoredPeer.sign.extractable||window.qaRestoredPeer.dec.extractable};
    },{...peer.identity,password,expected:peer.identity.fingerprint});
    assert.equal(result.contact,peer.identity.fingerprint);
    assert.equal(result.restored,peer.identity.fingerprint);
    assert.equal(result.card,peer.identity.card);
    assert.equal(result.wrongRejected,true);
    assert.equal(result.privateExportable,false);
    console.log('PASS '+own.name+': imported '+peer.name+' contact and encrypted backup with matching fingerprint; wrong password rejected');
    const message='Fictional '+own.name+' to '+peer.name+' message. Café 🔐';
    const encrypted=await own.page.evaluate(async({card,message,secret})=>window.qaModule.seal(window.qaOwn,card,message,secret),{card:peer.identity.card,message,secret});
    const plaintext=await peer.page.evaluate(async({card,encrypted,secret})=>window.qaModule.open(window.qaOwn,card,encrypted,secret),{card:own.identity.card,encrypted,secret});
    assert.equal(plaintext,message);
    const restoredPlaintext=await own.page.evaluate(async({card,encrypted,secret})=>window.qaModule.open(window.qaRestoredPeer,card,encrypted,secret),{card:own.identity.card,encrypted,secret});
    assert.equal(restoredPlaintext,message);
    console.log('PASS '+own.name+' to '+peer.name+': exact authenticated fictional message recovered by native recipient and cross-engine restored backup');
  }
  console.log('V Cipher native Firefox/WebKit local-source interoperability: 6/6 PASS. No live account, message service, physical device or camera tested.');
}finally{
  await Promise.allSettled(opened.map(browser=>browser.close()));
  server.close();
}
