// SPDX-License-Identifier: GPL-3.0-or-later
// Public, no-account production acceptance with fictional local data only.
// Linux browser engines are not physical iPhone/Safari or Android evidence.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {firefox,webkit} from 'playwright';
import {publicBrowserPreflight} from './live-browser-gate.mjs';

// These unattended contexts have no email-verified app session. A healthy gate
// is availability evidence only; preserve the deeper checks below for an
// explicitly verified browser context, never an authentication bypass.
if ((await publicBrowserPreflight("Firefox and WebKit", ["https://www.vellivex.com/apps/vault", "https://www.vellivex.com/apps/relay", "https://www.vellivex.com/apps/cipher"])).deepChecks === 'not-run') process.exit(0);

const engines={firefox,webkit};
const name=process.argv[2];
assert.ok(Object.hasOwn(engines,name),'Choose firefox or webkit');
const site='https://www.vellivex.com';
const fictional='Fictional Vellivex engine QA. Café 🔐\nExact second line <b>plain text</b>.';
const password='Fictional browser check orchard river 8317';
const backupPassword='Fictional offline backup amber orchid 9152';
const browser=await engines[name].launch({headless:true});
const context=await browser.newContext({acceptDownloads:true,permissions:[],serviceWorkers:'allow'});
const page=await context.newPage();
page.setDefaultTimeout(30_000);
let stage='public VVault';
const status=(id,pattern)=>page.locator('#'+id).filter({hasText:pattern}).waitFor({state:'visible'});
const appStatus=pattern=>status('app-status',pattern);
const cipherStatus=pattern=>status('cipher-status',pattern);
const val=id=>page.locator('#'+id).inputValue();
const pass=description=>console.log('PASS '+name+': '+description);
try{
  // A future UI change cannot send a report or allocate an account through this context.
  await context.route('**/*',route=>{
    const request=route.request();
    return new URL(request.url()).origin===site&&['GET','HEAD'].includes(request.method())
      ?route.continue():route.abort('blockedbyclient');
  });
  const first=await page.goto(site+'/apps/vault',{waitUntil:'domcontentloaded'});
  assert.equal(first?.status(),200);
  assert.equal(new URL(page.url()).origin,site);
  console.log('Engine '+name+' '+browser.version());
  await page.locator('#message').fill(fictional);
  await page.locator('#passphrase').fill(password);
  await page.locator('#passphrase-confirm').fill(password);
  await page.locator('#vault-submit').click();
  await appStatus(/Encrypted locally/);
  const envelope=await val('result');
  assert.equal(JSON.parse(envelope).format,'VVAULT');
  assert.equal(envelope.includes(fictional),false);
  assert.equal(await val('message'),'');
  assert.equal(await val('passphrase'),'');
  const packageDownload=page.waitForEvent('download');
  await page.locator('#download-result').click();
  const download=await packageDownload;
  assert.equal(download.suggestedFilename(),'v-vault-message.vvault');
  const packagePath=await download.path();
  assert.equal(await readFile(packagePath,'utf8'),envelope);
  pass('VVault encrypted fictional Unicode text, cleared inputs and downloaded exact encrypted bytes');

  stage='VRelay file import and malformed-input recovery';
  await page.goto(site+'/apps/relay',{waitUntil:'domcontentloaded'});
  await page.locator('#relay-file').setInputFiles(packagePath);
  await appStatus(/Loaded locally/);
  await page.locator('#relay-form button[type="submit"]').click();
  await appStatus(/Package format checked/);
  assert.equal(await val('result'),envelope);
  await page.locator('#relay-package').fill('{}');
  await page.locator('#relay-form button[type="submit"]').click();
  await appStatus(/Unsupported or invalid encrypted package/);
  assert.equal(await val('result'),'');
  assert.equal(await page.locator('#download-package').isDisabled(),true);
  await page.locator('#relay-package').fill(envelope);
  await page.locator('#relay-form button[type="submit"]').click();
  await appStatus(/Package format checked/);
  assert.equal(await val('result'),envelope);
  pass('VRelay imported exact downloaded package, rejected malformed input, and recovered valid transfer controls');

  stage='native offline installation';
  await page.goto(site+'/apps/vault',{waitUntil:'domcontentloaded'});
  await page.locator('#offline-enable').click();
  await appStatus(/Offline files installed|No new offline release/);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  // Remove automation network interception before testing the browser's native
  // offline service-worker path. Requests during this phase are offline.
  await context.unrouteAll({behavior:'wait'});
  const installed=await page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.getRegistration();
    const keys=await caches.keys();
    return {active:registration?.active?.state,controller:Boolean(navigator.serviceWorker.controller),cacheCount:keys.filter(k=>k.startsWith('v-tools-')).length};
  });
  assert.equal(installed.active,'activated');
  assert.equal(installed.cacheCount,1);
  console.log('Offline readiness '+name+' '+JSON.stringify(installed));
  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(await page.evaluate(()=>navigator.onLine),false);
  await page.locator('#vault-mode').selectOption('decrypt');
  await page.locator('#message').fill(envelope);
  await page.locator('#passphrase').fill('Deliberately incorrect fictional passphrase');
  await page.locator('#vault-submit').click();
  await appStatus(/Unable to unlock/);
  assert.equal(await val('result'),'');
  await page.locator('#passphrase').fill(password);
  await page.locator('#vault-submit').click();
  await appStatus(/Unlocked locally/);
  assert.equal(await val('result'),fictional);
  await page.locator('#clear-session').click();
  assert.equal(await val('result'),'');
  assert.equal(await val('message'),'');
  pass('VVault installed and reloaded offline, rejected wrong password, recovered exact text and cleared session');

  stage='offline VRelay reuse';
  await page.goto(site+'/apps/relay',{waitUntil:'domcontentloaded'});
  assert.equal(await page.evaluate(()=>navigator.onLine),false);
  await page.locator('#relay-file').setInputFiles(packagePath);
  await appStatus(/Loaded locally/);
  await page.locator('#relay-form button[type="submit"]').click();
  await appStatus(/Package format checked/);
  assert.equal(await val('result'),envelope);
  pass('VRelay opened and imported the exact encrypted file with browser networking offline');

  stage='offline V Cipher backup creation';
  await page.goto(site+'/apps/cipher/vault',{waitUntil:'domcontentloaded'});
  assert.equal(await page.evaluate(()=>navigator.onLine),false);
  await page.locator('#offline-confirm').check();
  await page.locator('#identity-password').fill(backupPassword);
  await page.locator('#identity-confirm').fill(backupPassword);
  const backupDownload=page.waitForEvent('download');
  await page.locator('#cipher-generate').click();
  const backup=await backupDownload;
  assert.equal(backup.suggestedFilename(),'vellivex-cipher-encrypted-vault.json');
  await cipherStatus(/Identity created and encrypted backup download requested/);
  const backupPath=await backup.path();
  const backupBytes=await readFile(backupPath);
  assert.ok(backupBytes.length>100&&backupBytes.length<20000);
  assert.equal(backupBytes.includes(backupPassword),false);
  const card=await val('identity-card');
  const fingerprint=await page.locator('#identity-fingerprint').innerText();
  assert.ok(card.length>100&&fingerprint.length>32);
  await page.locator('#cipher-lock').click();
  assert.equal(await val('identity-card'),'');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('#offline-confirm').check();
  await page.locator('#cipher-backup').setInputFiles(backupPath);
  await page.locator('#identity-password').fill('Wrong fictional backup passphrase');
  await page.locator('#cipher-unlock').click();
  await cipherStatus(/Unable to unlock|could not be unlocked|invalid|incorrect|failed/i);
  assert.equal(await val('identity-card'),'');
  await page.locator('#identity-password').fill(backupPassword);
  await page.locator('#cipher-unlock').click();
  await cipherStatus(/Identity unlocked locally/);
  assert.equal(await val('identity-card'),card);
  assert.equal(await page.locator('#identity-fingerprint').innerText(),fingerprint);
  await page.locator('#cipher-lock').click();
  assert.equal(await val('identity-card'),'');
  pass('V Cipher created encrypted backup offline, rejected wrong restore password, and recovered matching public card/fingerprint after reload');
  console.log('Engine '+name+': 5/5 production workflow groups PASS. Linux engine; physical phone, camera, native share and iOS Safari remain separate.');
}catch(error){
  console.error('FAIL '+name+' at '+stage+' ('+(error?.name||'unknown')+')');
  if(stage==='offline V Cipher backup creation'){
    // Report schema only. Never print generated public/private key material.
    const schema=await page.evaluate(async()=>{
      const c=crypto.subtle;
      const rsa=await c.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
      const ec=await c.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
      const summary=async key=>{const j=await c.exportKey('jwk',key);return {fields:Object.keys(j).sort(),kty:j.kty,alg:j.alg??null,crv:j.crv??null,ext:j.ext,key_ops:j.key_ops};};
      return {rsaPublic:await summary(rsa.publicKey),rsaPrivate:await summary(rsa.privateKey),ecPublic:await summary(ec.publicKey),ecPrivate:await summary(ec.privateKey)};
    }).catch(()=>({unavailable:true}));
    console.error('Native generated JWK schema '+JSON.stringify(schema));
  }
  for(const id of ['app-status','cipher-status']){
    try{console.error('Visible '+id+': '+(await page.locator('#'+id).textContent({timeout:500})).slice(0,300));}catch{}
  }
  throw error;
}finally{
  await context.close();
  await browser.close();
}
