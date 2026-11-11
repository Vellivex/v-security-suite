// SPDX-License-Identifier: GPL-3.0-or-later
// VMail real browser *read-only* health check; never creates an address or accesses mail.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {publicBrowserPreflight} from './live-browser-gate.mjs';

// These unattended contexts have no email-verified app session. A healthy gate
// is availability evidence only; preserve the deeper checks below for an
// explicitly verified browser context, never an authentication bypass.
if ((await publicBrowserPreflight("VMail", ["https://www.vellivex.com/apps/mail"])).deepChecks === 'not-run') process.exit(0);

const SITE='https://www.vellivex.com/apps/mail';
const browser=await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
  headless:true,
});
const context=await browser.newContext({permissions:[],serviceWorkers:'block'});
const page=await context.newPage();
page.setDefaultTimeout(25_000);
const checks=[];
let stage='opening public mail page';
try {
  // Explicitly deny inbox creation, reading and deletion during the test,
  // even if a future page change accidentally attempts them.
  await page.route('**/api/mail/inbox**',route=>route.abort('blockedbyclient'));
  const response=await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:25_000});
  assert.equal(response?.status(),200);
  assert.equal(new URL(page.url()).origin,'https://www.vellivex.com');
  checks.push('public mail page HTTP 200');

  stage='checking browser API status';
  const statusResult=await page.evaluate(async()=>{
    try{
      const r=await fetch('/api/mail/status',{
        method:'GET',cache:'no-store',credentials:'same-origin',
        headers:{Accept:'application/json'},
        signal:AbortSignal.timeout(12_000),
      });
      const data=r.status===200?await r.json():null;
      return {ok:r.ok,http:r.status,enabled:data?.receivingEnabled===true,
        signup:data?.publicSignupEnabled===true,reason:r.ok?null:'HTTP status'};
    }catch(e){return {ok:false,http:null,reason:e?.name||'Network error'};}
  });
  assert.equal(statusResult.ok,true,'VMail same-origin API health did not respond: '+statusResult.reason);
  assert.equal(statusResult.enabled,true,'VMail receiving disabled');
  assert.equal(statusResult.signup,true,'VMail public signup disabled');
  checks.push('live same-origin mail API status');

  stage='waiting for in-page readiness';
  await page.waitForFunction(()=>{
    const text=document.getElementById('mail-status')?.textContent||'';
    return text&&!/Checking mail service availability/i.test(text);
  },null,{timeout:18_000});
  const ui=await page.evaluate(()=>({
    status:(document.getElementById('mail-status')?.textContent||'').slice(0,240),
    createDisabled:document.getElementById('mail-create')?.disabled,
    noInbox:document.getElementById('mail-address')?.value==='No active inbox',
    refreshDisabled:document.getElementById('mail-refresh')?.disabled,
    count:(document.getElementById('mail-count')?.textContent||'').slice(0,40),
  }));
  assert.ok(/verification|Create inbox|Check|available/i.test(ui.status),'Browser UI did not recognise readiness');
  assert.equal(ui.createDisabled,true,'No bot check should be bypassed by a test');
  assert.equal(ui.noInbox,true,'No inbox may be created by this read-only test');
  assert.equal(ui.refreshDisabled,true,'No unknown inbox should be accessed');
  checks.push('live mail page readiness and no inbox creation');

  console.log('PASS VMail: '+checks.join(' | '));
  console.log('PASS VMail: no inboxes created, addresses consumed, messages accessed, or email sent.');
} catch (error) {
  console.error('FAIL VMail at stage='+stage);
  console.error('VMail error type='+(error?.name||'unknown'));
  try{
    console.error('VMail visible status='+JSON.stringify((await page.locator('#mail-status').textContent({timeout:1000}))?.slice(0,240)));
  }catch{}
  process.exitCode=1;
}finally{
  await context.close();
  await browser.close();
}
