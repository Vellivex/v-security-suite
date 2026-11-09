// SPDX-License-Identifier: GPL-3.0-or-later
// Real Chromium VPhone local-workspace test. Fictional contact and unsent draft.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ORIGIN='https://vphone.vellivex.com';
const NAME='QA Fictional Contact';
const NUMBER='+447700900123'; // UK drama-use range, not a real recipient
const DRAFT='Fictional QA draft only. Never send this message.';
const TIMEOUT=35_000;

const browser=await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
  headless:true,
  args:['--disable-background-timer-throttling'],
});
const context=await browser.newContext({serviceWorkers:'block',permissions:[]});
let page,stage='opening',completed=0;
async function state() {
  return page.evaluate(async()=> {
    const module=await import('/local-workspace.mjs');
    return (await module.accessWorkspace()).state;
  });
}
try {
  page=await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  await page.goto(ORIGIN+'/',{waitUntil:'domcontentloaded',timeout:TIMEOUT});
  stage='saving fictional contact through UI';
  await page.getByRole('button',{name:'Add contact'}).filter({visible:true}).first().click();
  await page.locator('#contact-name').fill(NAME);
  await page.locator('#contact-number').fill(NUMBER);
  await page.getByRole('button',{name:'Save contact'}).filter({visible:true}).click();
  await page.getByText(NAME,{exact:true}).filter({visible:true}).first().waitFor({state:'visible',timeout:TIMEOUT});
  const afterSave=await state();
  assert.equal(afterSave.contacts.length,1);
  assert.equal(afterSave.contacts[0].name,NAME);
  assert.equal(afterSave.contacts[0].number,NUMBER);
  console.log('PASS VPhone: fictional contact saved through live app UI in browser-only storage');completed++;

  stage='persisting contact after reload';
  await page.reload({waitUntil:'domcontentloaded',timeout:TIMEOUT});
  await page.getByText(NAME,{exact:true}).filter({visible:true}).first().waitFor({state:'visible',timeout:TIMEOUT});
  assert.equal((await state()).contacts.length,1);
  console.log('PASS VPhone: fictional contact persisted after full reload');completed++;

  stage='saving unsent draft';
  const draft=await page.evaluate(async input=>{
    const module=await import('/local-workspace.mjs');
    const response=await module.localFetch('/api/ghost',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'saveDraft',to:input.number,body:input.message}),
    });
    return {status:response.status,payload:await response.json()};
  },{number:NUMBER,message:DRAFT});
  assert.equal(draft.status,200);
  assert.equal(draft.payload.ok,true);
  assert.match(draft.payload.notice,/has not been sent/i);
  await page.reload({waitUntil:'domcontentloaded',timeout:TIMEOUT});
  const afterDraft=await state();
  assert.equal(afterDraft.drafts.length,1);
  assert.equal(afterDraft.drafts[0].body,DRAFT);
  assert.equal(afterDraft.drafts[0].to,NUMBER);
  await page.getByRole('button',{name:'Drafts'}).filter({visible:true}).first().click();
  await page.getByText(DRAFT,{exact:false}).filter({visible:true}).first().waitFor({state:'visible',timeout:TIMEOUT});
  console.log('PASS VPhone: local-only unsent draft persisted and appeared in the live Drafts UI');completed++;

  stage='provider send hold';
  const blocked=await page.evaluate(async input=>{
    const module=await import('/local-workspace.mjs');
    const response=await module.localFetch('/api/ghost',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'sendSMS',to:input.number,body:input.message}),
    });
    return {status:response.status,payload:await response.json()};
  },{number:NUMBER,message:DRAFT});
  assert.equal(blocked.status,400);
  assert.equal(blocked.payload.ok,false);
  assert.match(blocked.payload.error,/Calls and SMS are not enabled/i);
  console.log('PASS VPhone: fictional outgoing SMS refused by local-only provider hold');completed++;

  stage='removing test data';
  await page.evaluate(async()=>{
    const module=await import('/local-workspace.mjs');
    await module.accessWorkspace({action:'clearLocalWorkspace'});
  });
  await page.reload({waitUntil:'domcontentloaded',timeout:TIMEOUT});
  const afterClear=await state();
  assert.deepEqual(afterClear.contacts,[]);
  assert.deepEqual(afterClear.drafts,[]);
  console.log('PASS VPhone: test contact and draft deleted from browser storage');completed++;
  console.log('VPhone real-browser local-workspace tests: '+completed+'/5 PASS. No real contact, SMS delivery or paid provider tested.');
} catch(error){
  console.error('FAIL VPhone at stage='+stage+', passed='+completed+'/5');
  console.error('VPhone error type='+(error?.name||'unknown'));
  process.exitCode=1;
} finally {
  try {if(page)await page.evaluate(async()=>{const m=await import('/local-workspace.mjs');await m.accessWorkspace({action:'clearLocalWorkspace'});});}catch{}
  await context.close();
  await browser.close();
}
