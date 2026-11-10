// SPDX-License-Identifier: GPL-3.0-or-later
// Test VDecoy's capture, stop and playback using a synthetic Web Audio input
// in real Android Chrome. The test never opens an emulator or physical mic.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { _android as android } from 'playwright';

const ORIGIN = 'https://vdecoy.vellivex.com';
const WAIT = 25_000;

const devices = await android.devices();
let context;
let page;
let stage = 'Android Chrome setup';
try {
  assert.equal(devices.length, 1, 'Start exactly one isolated Android emulator');
  const [device] = devices;
  assert.match(device.serial(), /^emulator-\d+$/);
  device.setDefaultTimeout(WAIT);
  context = await device.launchBrowser({
    pkg: 'com.android.chrome',
    viewport: null,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  await page.addInitScript(({ origin }) => {
    if (location.origin !== origin || !navigator.mediaDevices) return;
    let stream;
    let audio;
    let requests = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async constraints => {
        if (!constraints?.audio || constraints.video) {
          throw new DOMException('Only synthetic audio capture is allowed in this test.', 'NotAllowedError');
        }
        requests++;
        audio = new AudioContext();
        const destination = audio.createMediaStreamDestination();
        for (const [frequency, amplitude] of [[180, 0.12], [320, 0.06]]) {
          const tone = audio.createOscillator();
          tone.frequency.value = frequency;
          const gain = audio.createGain();
          gain.gain.value = amplitude;
          tone.connect(gain).connect(destination);
          tone.start();
        }
        stream = destination.stream;
        await audio.resume();
        return stream;
      },
    });
    Object.defineProperty(window, '__vdecoySyntheticAudioState', {
      value: () => ({
        requests,
        audioState: audio?.state,
        tracks: stream?.getAudioTracks().map(track => track.readyState) ?? [],
      }),
    });
    window.addEventListener('pagehide', () => {
      stream?.getTracks().forEach(track => track.stop());
      void audio?.close();
    }, { once: true });
  }, { origin: ORIGIN });

  stage = 'open production VDecoy';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: WAIT });
      assert.equal(response?.status(), 200);
      break;
    } catch (error) {
      if (attempt === 3 || !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(error.message)) throw error;
      await delay(4_000);
    }
  }
  assert.equal(new URL(page.url()).origin, ORIGIN);
  assert.equal(await page.evaluate(() => window.isSecureContext &&
    /Android.+Chrome\//.test(navigator.userAgent)), true);

  stage = 'start recording from synthetic stream';
  await page.locator('#start-recording').click();
  await page.locator('#recording-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('mic-state')?.textContent === 'Recording');
  const active = await page.evaluate(() => window.__vdecoySyntheticAudioState());
  assert.deepEqual(active, { requests: 1, audioState: 'running', tracks: ['live'] });

  stage = 'stop recording and release the synthetic track';
  await delay(8_500);
  await page.locator('#finish-recording').click();
  await page.waitForFunction(() =>
    document.getElementById('recording-panel')?.hidden &&
    document.getElementById('mic-state')?.textContent === 'Mic off' &&
    window.__vdecoySyntheticAudioState().tracks.every(state => state === 'ended'));
  const stopped = await page.evaluate(() => window.__vdecoySyntheticAudioState());
  assert.deepEqual(stopped.tracks, ['ended']);
  console.log('PASS VDecoy: Android Chrome recorded a synthetic Web Audio stream and stopped its audio track.');

  stage = 'decode and preview the recorded sample';
  await page.locator('#sample-panel').waitFor({ state: 'visible' });
  const player = page.locator('#sample-audio');
  await page.waitForFunction(() => {
    const duration = document.getElementById('sample-audio')?.duration;
    return Number.isFinite(duration) && duration >= 6;
  });
  assert.ok(await player.evaluate(audio => audio.duration <= 20), 'Unexpected recorded sample length');
  await player.evaluate(audio => audio.play());
  await page.waitForFunction(() => document.getElementById('sample-audio')?.currentTime > 0.2);
  await player.evaluate(audio => audio.pause());
  assert.equal(await player.evaluate(audio => audio.paused), true);
  console.log('PASS VDecoy: the recorded sample was decoded, previewed and paused in Android Chrome.');
  console.log('Coverage: browser recording and playback lifecycle with injected audio. Hardware mic and speaker were outside this test.');
} catch (error) {
  console.error('FAIL VDecoy synthetic recording at stage=' + stage + ': ' + (error?.message || 'unknown'));
  if (page) {
    const status = await page.locator('#message').textContent({ timeout: 1_000 }).catch(() => '');
    if (status) console.error('VDecoy status: ' + status.slice(0, 200));
  }
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  await Promise.allSettled(devices.map(device => device.close()));
}
