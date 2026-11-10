// SPDX-License-Identifier: GPL-3.0-or-later
// One-off VDecoy synthetic WAV import and preview smoke test in Chrome for Android.
// No voice data, camera, microphone, paid inference, or account authentication.
import assert from 'node:assert/strict';
import { _android as android } from 'playwright';

const ORIGIN = 'https://vdecoy.vellivex.com';
const WAIT = 25_000;
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

const devices = await android.devices();
let context;
let stage = 'Android Chrome setup';
try {
  assert.equal(devices.length, 1, 'Start exactly one isolated Android emulator');
  const [device] = devices;
  assert.match(device.serial(), /^emulator-\d+$/);
  assert.match((await device.shell('pm path com.android.chrome')).toString(), /^package:/m);
  device.setDefaultTimeout(WAIT);
  context = await device.launchBrowser({
    pkg: 'com.android.chrome',
    viewport: null,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  const response = await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: WAIT });
  assert.equal(response?.status(), 200);
  assert.equal(new URL(page.url()).origin, ORIGIN);
  assert.equal(await page.evaluate(() => window.isSecureContext &&
    /Android.+Chrome\//.test(navigator.userAgent)), true);

  stage = 'synthetic file import';
  await page.waitForFunction(() => document.getElementById('import-voice')?.disabled === false);
  await page.locator('#import-voice').setInputFiles({
    name: 'vellivex-qa-synthetic-tone.wav',
    mimeType: 'audio/wav',
    buffer: syntheticWav(),
  });
  await page.locator('#sample-panel').waitFor({ state: 'visible' });
  const player = page.locator('#sample-audio');
  await page.waitForFunction(() => {
    const duration = document.getElementById('sample-audio')?.duration;
    return Number.isFinite(duration) && duration >= 6;
  });
  const duration = await player.evaluate(audio => audio.duration);
  assert.ok(duration >= 6 && duration <= 12, 'Unexpected decoded audio duration');
  console.log('PASS VDecoy: Android Chrome imported a fictional WAV and decoded its audio.');

  stage = 'synthetic file preview';
  await player.evaluate(async audio => {
    await audio.play();
  });
  await page.waitForFunction(() => document.getElementById('sample-audio')?.currentTime > 0.1);
  await player.evaluate(audio => audio.pause());
  assert.equal(await player.evaluate(audio => audio.paused), true);
  console.log('PASS VDecoy: Android Chrome playback advanced and paused. Physical audio output and microphone remain unverified.');
} catch (error) {
  console.error('FAIL Android VDecoy at stage=' + stage + ' error=' + (error?.name || 'unknown'));
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  await Promise.allSettled(devices.map(device => device.close()));
}
