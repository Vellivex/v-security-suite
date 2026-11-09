// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic browser-only VDecoy input/preview test; no human voice or model inference.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://vdecoy.vellivex.com';
const TIMEOUT = 40_000;
function syntheticWav(sampleRate = 24_000, seconds = 8) {
  const count = sampleRate * seconds;
  const data = Buffer.alloc(44 + count * 2);
  data.write('RIFF',0,'ascii'); data.writeUInt32LE(data.length-8,4);
  data.write('WAVE',8,'ascii'); data.write('fmt ',12,'ascii');
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(sampleRate,24); data.writeUInt32LE(sampleRate*2,28);
  data.writeUInt16LE(2,32); data.writeUInt16LE(16,34);
  data.write('data',36,'ascii'); data.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++) {
    const t=i/sampleRate;
    const fade=Math.min(1,t/.08,(seconds-t)/.08);
    const sound=fade*(.11*Math.sin(2*Math.PI*(180*t+.07*Math.sin(t*3)))+.06*Math.sin(2*Math.PI*320*t));
    data.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(sound*32767))),44+i*2);
  }
  return data;
}
async function ready(page,id) {
  await page.waitForFunction(id => {
    const element=document.getElementById(id);
    return element && element.disabled===false;
  },id,{timeout:TIMEOUT});
}
async function panelVisible(page,id) {
  await page.waitForFunction(id => {
    const element=document.getElementById(id);
    return element && !element.hidden;
  },id,{timeout:TIMEOUT});
}
async function text(page,id) {
  try { return String(await page.locator('#'+id).textContent({timeout:1000})).slice(0,150); }
  catch { return 'unavailable'; }
}
const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'vellivex-synthetic-audio-'));
const fakeMicPath=path.join(tempDir,'synthetic-microphone.wav');
fs.writeFileSync(fakeMicPath,syntheticWav(48_000,10));
const browser=await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
  headless:true,
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture='+fakeMicPath,
    '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling'],
});
const context=await browser.newContext({permissions:['microphone'],serviceWorkers:'allow'});
let page,stage='opening';
const thirdPartyHosts=new Set();
const externalRequestKinds=[];
const externalResponseStatuses=[];
const externalFailureReasons=[];
try {
  page=await context.newPage();
  page.on('request',request=>{
    try {
      const url=new URL(request.url());
      if(['http:','https:'].includes(url.protocol)&&url.origin!==ORIGIN){
        thirdPartyHosts.add(url.host);
        externalRequestKinds.push({host:url.host,type:request.resourceType()});
      }
    }
    catch {}
  });
  page.on('requestfailed',request=>{
    try {const u=new URL(request.url());if(['http:','https:'].includes(u.protocol)&&u.origin!==ORIGIN)externalFailureReasons.push({host:u.host,reason:request.failure()?.errorText||'unknown'});} catch {}
  });
  page.on('response',response=>{
    try {const u=new URL(response.url());if(['http:','https:'].includes(u.protocol)&&u.origin!==ORIGIN)externalResponseStatuses.push({host:u.host,status:response.status()});} catch {}
  });
  await page.goto(ORIGIN+'/',{waitUntil:'domcontentloaded',timeout:TIMEOUT});

  stage='browser readiness';
  await ready(page,'import-voice');
  assert.equal(await page.evaluate(()=>window.isSecureContext),true);

  stage='importing synthetic WAV';
  await page.locator('#import-voice').setInputFiles({
    name:'vellivex-qa-synthetic-tone.wav',mimeType:'audio/wav',buffer:syntheticWav(),
  });
  await panelVisible(page,'sample-panel');
  await page.waitForFunction(()=>{
    const el=document.getElementById('sample-audio');
    return el && Number.isFinite(el.duration) && el.duration >= 6;
  },null,{timeout:TIMEOUT});
  const duration=await page.locator('#sample-audio').evaluate(el=>el.duration);
  assert.ok(duration>=6 && duration<=12);
  console.log('PASS VDecoy: fictional WAV imported, decoded and locally prepared for preview');

  stage='previewing synthetic audio';
  const playing=await page.locator('#sample-audio').evaluate(async el=>{
    await el.play();
    const started=!el.paused;
    el.pause();
    return started;
  });
  assert.equal(playing,true);
  console.log('PASS VDecoy: browser audio preview of fictional recording started');

  stage='fake microphone';
  await page.reload({waitUntil:'domcontentloaded',timeout:TIMEOUT});
  await ready(page,'start-recording');
  await page.locator('#start-recording').click();
  await panelVisible(page,'recording-panel');
  await page.waitForFunction(()=>document.getElementById('mic-state')?.textContent==='Recording',
    null,{timeout:TIMEOUT});
  // 6 seconds is the minimum reference sample; 8 seconds tolerates startup delay.
  await page.waitForTimeout(8_400);
  await page.locator('#finish-recording').click();
  await page.waitForFunction(()=>{
    const panel=document.getElementById('recording-panel');
    const mic=document.getElementById('mic-state');
    return panel && panel.hidden && mic?.textContent==='Mic off';
  },null,{timeout:TIMEOUT});
  const accepted=await page.locator('#sample-panel').evaluate(el=>!el.hidden);
  if(accepted){
    console.log('PASS VDecoy: synthetic fake microphone started, stopped, released and prepared a sample');
  } else {
    // A synthetic test tone is not human speech. Explicit quality rejection is
    // expected and must not be misreported as a hardware/audio failure.
    const warning=await text(page,'message');
    assert.match(warning,/too little sustained audio at a usable level/i);
    console.log('PASS VDecoy: synthetic fake microphone started, stopped and released; insufficient signal rejected by local quality gate');
  }

  stage='network isolation';
  // Cloudflare has been observed injecting an analytics tag after Worker
  // rendering. VDecoy's restrictive CSP blocks the external script request:
  // a blocked request event is NOT a successful third-party download.
  if(thirdPartyHosts.size){
    const onlyExpectedScript=thirdPartyHosts.size===1 &&
      thirdPartyHosts.has('static.cloudflareinsights.com') &&
      externalRequestKinds.length>0 &&
      externalRequestKinds.every(x=>x.host==='static.cloudflareinsights.com'&&x.type==='script') &&
      externalResponseStatuses.length===0 &&
      externalFailureReasons.length===externalRequestKinds.length &&
      externalFailureReasons.every(x=>x.host==='static.cloudflareinsights.com'&&x.reason==='csp');
    if(!onlyExpectedScript){
      console.error('Unexpected external hosts: '+[...thirdPartyHosts].sort().join(', '));
      console.error('External request types: '+JSON.stringify(externalRequestKinds));
      console.error('External response statuses: '+JSON.stringify(externalResponseStatuses));
      console.error('External failure reasons: '+JSON.stringify(externalFailureReasons));
    }
    assert.equal(onlyExpectedScript,true,'Unexpected external network activity or a change to CSP enforcement');
    console.log('PASS VDecoy: externally injected Cloudflare Insights script blocked by enforced CSP; zero third-party responses');
  }else{
    assert.equal(externalResponseStatuses.length,0,'Unexpected off-origin HTTP response');
    console.log('PASS VDecoy: no third-party requests or responses in this limited test');
  }
  console.log('VDecoy synthetic browser checks: 4/4 PASS. No real voice, voice likeness, phone speaker or model inference tested.');
} catch(error) {
  console.error('FAIL VDecoy at stage='+stage);
  if(page){
    console.error('VDecoy status='+await text(page,'message'));
    console.error('VDecoy compatibility='+await text(page,'compatibility'));
    console.error('VDecoy microphone state='+await text(page,'mic-state'));
  }
  console.error('VDecoy error type='+(error?.name||'unknown'));
  process.exitCode=1;
} finally {
  await context.close();
  await browser.close();
  fs.rmSync(tempDir,{recursive:true,force:true});
}
