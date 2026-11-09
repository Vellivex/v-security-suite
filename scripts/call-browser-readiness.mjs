// SPDX-License-Identifier: GPL-3.0-or-later
// Public internet-audio readiness and unauthenticated safety checks.
// No accounts, invitations, microphone samples, WebSockets or carrier calls.
// Sends one unauthenticated negative-test allocation POST; must be denied.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ORIGIN='https://call.vellivex.com';
const browser=await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
  headless:true,
});
const context=await browser.newContext({permissions:[],serviceWorkers:'block'});
const page=await context.newPage();
page.setDefaultTimeout(20000);
let stage='opening public call page';
let completed=0;
try {
  // Block any unexpected mutating account/call API request from this test.
  await page.route('**/api/**', route => {
    const request=route.request();
    const path=new URL(request.url()).pathname;
    const allowed=request.method()==='GET' ||
      (request.method()==='POST' && path==='/api/volatile');
    return allowed ? route.continue() : route.abort('blockedbyclient');
  });
  await page.addInitScript(() => {
    let calls=0;
    Object.defineProperty(window,'__qaGetUserMediaCalls',{get:()=>calls,configurable:false});
    if(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia==='function'){
      navigator.mediaDevices.getUserMedia=async()=>{calls++;throw new Error('QA intentionally blocks microphone access');};
    }
  });
  const response=await page.goto(ORIGIN+'/call.html',{waitUntil:'domcontentloaded',timeout:25000});
  assert.equal(response?.status(),200);
  assert.equal(new URL(page.url()).origin,ORIGIN);
  await page.locator('#call-create').waitFor({state:'visible'});
  console.log('PASS Vellivex Call: public internet-calling page HTTP 200');completed++;

  stage='public audio status';
  const audioStatus=await page.evaluate(async()=>{
    const r=await fetch('/api/audio/status',{method:'GET',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});
    return {status:r.status,data:r.ok?await r.json():null};
  });
  assert.equal(audioStatus.status,200);
  assert.deepEqual(audioStatus.data,{
    enabled:true,profile:'wss-opus-v1',maxSeconds:300,phoneCalling:false,
  });
  console.log('PASS Vellivex Call: internet audio enabled, five-minute maximum and telephone-provider calling disabled');completed++;

  stage='no unauthenticated invitation';
  await page.waitForTimeout(1300);
  assert.equal(await page.locator('#call-create').isDisabled(),true);
  assert.equal(await page.locator('#call-join').isDisabled(),true);
  assert.equal(await page.locator('#call-end').isDisabled(),true);
  assert.equal(await page.locator('#call-share').evaluate(e=>e.hidden),true);
  assert.equal((await page.locator('#call-link').inputValue()).length,0);
  console.log('PASS Vellivex Call: unsigned browser cannot create or join invitations');completed++;

  stage='opt-in consent without authentication';
  await page.locator('#call-consent').check();
  await page.locator('#call-headphones').check();
  await page.waitForTimeout(500);
  // The call page enables the Create button after local consent, even without
  // login; actual room allocation must still be rejected by the server.
  assert.equal(await page.locator('#call-create').isEnabled(),true);
  assert.equal(await page.locator('#call-join').isDisabled(),true);
  const denial=await page.evaluate(async()=>{
    const response=await fetch('/api/volatile',{
      method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'allocate'}),
      signal:AbortSignal.timeout(10000),
    });
    try {await response.body?.cancel();}catch{}
    return {status:response.status};
  });
  assert.ok([401,403].includes(denial.status),
    'Unsigned browser must not allocate an internet-call session');
  assert.equal(await page.locator('#call-mic-on').isDisabled(),true);
  assert.equal(await page.locator('#call-sound').isDisabled(),true);
  assert.equal(await page.locator('#call-verify').isDisabled(),true);
  console.log('PASS Vellivex Call: unauthenticated call allocation denied by server; no mic or sound controls unlocked');completed++;

  stage='no passive microphone or call setup';
  await page.locator('#call-preset').selectOption('deeper');
  await page.locator('#call-preset').selectOption('robot');
  assert.equal(await page.evaluate(()=>window.__qaGetUserMediaCalls),0);
  assert.match((await page.locator('#call-audio-status').textContent()||''),/microphone off/i);
  assert.equal(await page.locator('#call-share').evaluate(e=>e.hidden),true);
  console.log('PASS Vellivex Call: voice preset selection does not activate microphone or create an invitation');completed++;

  console.log('Vellivex Call public readiness: '+completed+'/5 PASS. No accounts, voice samples, telephone calls or paid relays tested.');
}catch(e){
  console.error('FAIL Vellivex Call at stage='+stage+', passed='+completed+'/5');
  console.error('Vellivex Call error type='+(e?.name||'unknown'));
  try {console.error('Call visible status='+(await page.locator('#call-status').textContent({timeout:1000})||'').slice(0,220));}catch{}
  process.exitCode=1;
}finally{
  await context.close();
  await browser.close();
}
