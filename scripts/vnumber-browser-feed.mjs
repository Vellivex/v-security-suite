// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only checks of VNumber free-country feeds: no number selected or SMS viewed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SITE='https://www.vellivex.com/apps/sms';
const browser=await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
  headless:true,
});
const context=await browser.newContext({permissions:[],serviceWorkers:'block'});
const page=await context.newPage();
page.setDefaultTimeout(25_000);
const results=[];
try {
  // Prohibit any explicit number-scoped requests or mutations.
  await page.route(/\/api\/public-sms(?:-extra)?\?.*(?:country|number)=/,route=>route.abort('blockedbyclient'));
  const response=await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:25_000});
  assert.equal(response?.status(),200);
  assert.equal(new URL(page.url()).origin,'https://www.vellivex.com');
  for (const id of ['sms-status','sms-coverage','sms-provider','sms-country']) {
    assert.equal(await page.locator('#'+id).count(),1);
  }
  for (const provider of ['gvpn','onlinesim']) {
    if (provider==='onlinesim') await page.locator('#sms-provider').selectOption('onlinesim');
    let settled=true;
    try{
      await page.waitForFunction(()=>{
        const status=document.getElementById('sms-status')?.textContent||'';
        const coverage=document.getElementById('sms-coverage')?.textContent||'';
        return (!/Checking the free|Loading the public/i.test(status) &&
          (Boolean(coverage)||/limited|unavailable|timed out|retry|could not/i.test(status)));
      },null,{timeout:20_000});
    }catch {settled=false;}
    const result=await page.evaluate(provider=>({
      provider,
      countryCount:document.getElementById('sms-country')?.options?.length??0,
      countryEnabled:document.getElementById('sms-country')?.disabled===false,
      status:(document.getElementById('sms-status')?.textContent||'').slice(0,180),
      coverage:(document.getElementById('sms-coverage')?.textContent||'').slice(0,180),
    }),provider);
    // No phone numbers, message bodies or sender details are logged.
    const available=settled && result.countryEnabled && result.countryCount>0 &&
      /countries listed/i.test(result.coverage);
    results.push({provider,available,countryCount:result.countryCount,status:result.status,coverage:result.coverage});
    console.log((available?'PASS':'NOTICE')+' VNumber '+provider+
      ': '+(available?'free country list loaded':'provider did not return a usable country list')+
      '; countries='+result.countryCount+
      '; status='+JSON.stringify(result.status));
  }
  assert.ok(results.some(r=>r.available),
    'Neither free provider produced a usable country list in this browser run');
  console.log('PASS VNumber: at least one free public country feed rendered in Chromium; no number was selected, no message text logged and no SMS was sent.');
} catch(e){
  console.error('FAIL VNumber: '+(e?.name||'error')+'. Read-only provider results were logged without numbers or messages.');
  process.exitCode=1;
} finally {
  await context.close();
  await browser.close();
}
