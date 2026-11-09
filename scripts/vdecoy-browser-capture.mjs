// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic browser-only VDecoy input/preview test; no human voice or model inference.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ORIGIN = 'https://vdecoy.vellivex.com';
const TIMEOUT = 40_000;
function syntheticWav() {
  const sampleRate = 24_000, seconds = 8, count = sampleRate * seconds;
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
const browser=await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
  headless:true,
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling'],
});
const context=await browser.newContext({permissions:['microphone'],serviceWorkers:'allow'});
let page,stage='opening';
const thirdPartyHosts=new Set();
try {
  page=await context.newPage();
  page.on('request',request=>{
    try { const url=new URL(request.url()); if(['http:','https:'].includes(url.protocol)&&url.origin!==ORIGIN)thirdPartyHosts.add(url.host); }
    catch {}
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
  await panelVisible(page,'sample-panel');
  assert.equal((await page.locator('#mic-state').textContent()).trim(),'Mic off');
  console.log('PASS VDecoy: Chrome fake microphone started, stopped, released and prepared a local sample');

  assert.equal(thirdPartyHosts.size,0,'Unexpected non-VDecoy network requests');
  console.log('PASS VDecoy: no third-party requests observed in this limited test');
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
}
