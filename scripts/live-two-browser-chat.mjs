// SPDX-License-Identifier: GPL-3.0-or-later
// One-off synthetic, two-browser *live* production chat acceptance check.
// No account credentials, real messages, screenshots, video, traces or secret logging.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { _android as android, chromium } from 'playwright';

const VKEY = 'https://vkey.vellivex.com/';
const PRIVATE = 'https://private.vellivex.com/';
const WAIT = 65_000;
const backgroundArgs = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

async function openEndpoints(contextFactories) {
  const contexts = [];
  try {
    for (const create of contextFactories) contexts.push(await create());
    return contexts;
  } catch (error) {
    await Promise.allSettled(contexts.map(context => context.close()));
    throw error;
  }
}

async function assertAndroidEndpoints(host, peer, mode) {
  if (mode === 'desktop') return;
  const androidChrome = page => page.evaluate(() => /Android.+Chrome\//.test(navigator.userAgent));
  assert.equal(await androidChrome(host), true, 'Host must be running actual Chrome for Android');
  assert.equal(await androidChrome(peer), mode === 'dual', 'Unexpected peer runtime');
}

async function until(page, predicate, timeout = WAIT) {
  await page.waitForFunction(predicate, null, { timeout });
}
async function status(page, selector) {
  try {
    return String(await page.locator(selector).textContent({ timeout: 1500 }))
      .replace(/https?:\/\/\S+/g, '[link]')
      .slice(0, 180);
  } catch { return 'unavailable'; }
}
async function syntheticVKey(contextFactories, mode) {
  const [hostContext, peerContext] = await openEndpoints(contextFactories);
  let host, peer, stage = 'opening';
  try {
    host = await hostContext.newPage();
    peer = await peerContext.newPage();
    await Promise.all([
      host.goto(VKEY, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
      peer.goto(VKEY, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
    ]);
    stage = 'verifying browser runtimes';
    await assertAndroidEndpoints(host, peer, mode);

    stage = 'creating invitation';
    await host.locator('#display-name').fill('QA Host');
    await peer.locator('#display-name').fill('QA Peer');
    await host.locator('#create-btn').click();
    await until(host, () => (document.getElementById('share-link')?.value || '').includes('#v='));
    const invite = await host.locator('#share-link').inputValue();
    assert.equal(new URL(invite).origin, new URL(VKEY).origin);

    stage = 'joining invitation';
    await peer.locator('#join-details').evaluate(el => { el.open = true; });
    await peer.locator('#invite-input').fill(invite);
    await peer.locator('#join-btn').click();
    await host.locator('#accept-btn').waitFor({ state: 'visible', timeout: WAIT });
    stage = 'host approval';
    await host.locator('#accept-btn').click();

    stage = 'encrypted transport and fingerprint';
    await Promise.all([
      until(host, () => (document.getElementById('full-fingerprint')?.textContent || '').length >= 32),
      until(peer, () => (document.getElementById('full-fingerprint')?.textContent || '').length >= 32),
    ]);
    const [hcode, pcode] = await Promise.all([
      host.locator('#full-fingerprint').textContent(),
      peer.locator('#full-fingerprint').textContent(),
    ]);
    assert.ok(hcode && hcode === pcode, 'Connection fingerprints must agree');

    stage = 'mutual fingerprint verification';
    await host.locator('#verify-btn').click();
    await peer.locator('#verify-btn').click();
    await Promise.all([
      until(host, () => !document.getElementById('message-input')?.disabled),
      until(peer, () => !document.getElementById('message-input')?.disabled),
    ]);

    stage = 'fictional message and receipt';
    const message = 'Vellivex QA fictional text ' + randomUUID();
    // VKey deliberately sets this field read-only while its private on-screen
    // keyboard is enabled. Use the UI's supported physical-typing toggle.
    await host.locator('#keyboard-toggle').click();
    await until(host, () => document.getElementById('message-input')?.readOnly === false, 5_000);
    await host.locator('#message-input').fill(message);
    await host.locator('#send-btn').click();
    await peer.locator('#messages').getByText(message, { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });

    stage = 'closing chat';
    await host.locator('#end-btn').click();
    await until(host, () => !!document.getElementById('ended') && !document.getElementById('ended').hidden, 12_000);
    console.log('PASS VKey: real browser invitation, approval, matched fingerprint, two confirmations, delivered fictional message, cleanup');
  } catch (error) {
    console.error('FAIL VKey stage=' + stage);
    console.error('VKey host state=' + (host ? await status(host, '#session-status') : 'not opened'));
    console.error('VKey peer state=' + (peer ? await status(peer, '#session-status') : 'not opened'));
    console.error('VKey peer notice=' + (peer ? await status(peer, '#notice') : 'not opened'));
    console.error('VKey host end reason=' + (host ? await status(host, '#ended-message') : 'not opened'));
    console.error('VKey peer end reason=' + (peer ? await status(peer, '#ended-message') : 'not opened'));
    for (const [label, page] of [['host', host], ['peer', peer]]) {
      if (!page) continue;
      try {
        const diagnostic = await page.evaluate(() => {
          document.getElementById('refresh-checks')?.click();
          const ids = ['check-gathering','check-network','check-connection','check-encryption',
            'check-data-channel','check-local-routes','check-remote-routes','check-peer-handshake',
            'check-relay-fallback'];
          return Object.fromEntries(ids.map(id => [id, document.getElementById(id)?.textContent?.slice(0, 100) || 'none']));
        });
        console.error('VKey ' + label + ' safe ICE diagnostics=' + JSON.stringify(diagnostic));
      } catch { console.error('VKey ' + label + ' diagnostics unavailable'); }
    }
    console.error('VKey error type=' + (error?.name || 'unknown'));
    throw new Error('VKey real browser acceptance did not complete at stage: ' + stage);
  } finally {
    await Promise.allSettled([hostContext.close(), peerContext.close()]);
  }
}
async function syntheticPrivate(contextFactories, mode) {
  const [hostContext, peerContext] = await openEndpoints(contextFactories);
  let host, peer, stage = 'opening';
  try {
    host = await hostContext.newPage();
    peer = await peerContext.newPage();
    await Promise.all([
      host.goto(PRIVATE, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
      peer.goto(PRIVATE, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
    ]);
    stage = 'verifying browser runtimes';
    await assertAndroidEndpoints(host, peer, mode);

    stage = 'consent and invitation';
    await host.locator('#consent').check();
    await peer.locator('#consent').check();
    await host.locator('#start').click();
    await until(host, () => (document.getElementById('invitation')?.value || '').includes('#v='));
    const invite = await host.locator('#invitation').inputValue();
    assert.equal(new URL(invite).origin, new URL(PRIVATE).origin);

    stage = 'joining and host approval';
    await peer.locator('#invitation').fill(invite);
    await peer.locator('#join').click();
    await host.locator('#accept').waitFor({ state: 'visible', timeout: WAIT });
    await host.locator('#accept').click();

    stage = 'encrypted transport and fingerprint';
    await Promise.all([
      until(host, () => (document.getElementById('code')?.textContent || '').length >= 32),
      until(peer, () => (document.getElementById('code')?.textContent || '').length >= 32),
    ]);
    const [hcode, pcode] = await Promise.all([
      host.locator('#code').textContent(),
      peer.locator('#code').textContent(),
    ]);
    assert.ok(hcode && hcode === pcode, 'Connection fingerprints must agree');

    stage = 'mutual verification';
    await host.locator('#confirm').click();
    await peer.locator('#confirm').click();
    await Promise.all([
      until(host, () => !document.getElementById('send')?.disabled),
      until(peer, () => !document.getElementById('send')?.disabled),
    ]);

    stage = 'fictional message and receipt';
    const message = 'Vellivex Private QA fictional text ' + randomUUID();
    await host.locator('#typing').check();
    await host.locator('#message').fill(message);
    await host.locator('#send').click();
    await peer.locator('#messages').getByText(message, { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });

    stage = 'closing chat';
    await host.locator('#end').click();
    await until(host, () => (document.getElementById('status')?.textContent || '').includes('cleared'), 12_000);
    console.log('PASS Private: real browser invitation, approval, matched fingerprint, two confirmations, delivered fictional message, cleanup');
  } catch (error) {
    console.error('FAIL Private stage=' + stage);
    console.error('Private host state=' + (host ? await status(host, '#status') : 'not opened'));
    console.error('Private peer state=' + (peer ? await status(peer, '#status') : 'not opened'));
    console.error('Private error type=' + (error?.name || 'unknown'));
    throw new Error('Private real browser acceptance did not complete at stage: ' + stage);
  } finally {
    await Promise.allSettled([hostContext.close(), peerContext.close()]);
  }
}

const mode = process.env.VELLIVEX_ANDROID_CHAT_MODE || 'desktop';
const run = process.env.VELLIVEX_E2E_TARGET || 'both';
if (!['desktop', 'hybrid', 'dual'].includes(mode)) throw new Error('Invalid Android chat mode');
if (!['both', 'vkey', 'private'].includes(run)) throw new Error('Invalid test selection');

let browser;
const devices = [];
try {
  const contextFactories = [];
  if (mode !== 'desktop') {
    devices.push(...await android.devices());
    const required = mode === 'dual' ? 2 : 1;
    assert.equal(devices.length, required, 'Start exactly the required number of isolated Android emulators');
    for (const device of devices) {
      assert.match(device.serial(), /^emulator-\d+$/, 'Only isolated Android emulators are supported');
      assert.match((await device.shell('pm path com.android.chrome')).toString(), /^package:/m,
        'Install official Google Chrome on the emulator first');
      device.setDefaultTimeout(25_000);
      contextFactories.push(() => device.launchBrowser({
        pkg: 'com.android.chrome',
        args: backgroundArgs,
        viewport: null,
        serviceWorkers: 'block',
      }));
    }
  }
  if (mode !== 'dual') {
    browser = await chromium.launch({
      ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
      headless: true,
      args: backgroundArgs,
    });
    const create = () => browser.newContext({ permissions: [], serviceWorkers: 'block' });
    contextFactories.push(create);
    if (mode === 'desktop') contextFactories.push(create);
  }
  const outcomes = [];
  for (const [name, test] of [['vkey', syntheticVKey], ['private', syntheticPrivate]]) {
    if (run !== 'both' && run !== name) continue;
    try {
      await test(contextFactories, mode);
      outcomes.push(true);
    } catch (error) {
      // A browser launch error may include machine-local paths. The typed error
      // and stage messages are enough to diagnose without disclosing details.
      console.error('Failed browser session for ' + name + ': ' + (error?.name || 'unknown'));
      outcomes.push(false);
    }
  }
  const endpoints = {
    desktop: 'two desktop Chromium contexts',
    hybrid: 'Chrome on an Android emulator and a desktop Chromium peer',
    dual: 'Chrome on two Android emulators',
  };
  console.log('Browser checks passed: ' + outcomes.filter(Boolean).length + '/' + outcomes.length +
    ' using ' + endpoints[mode] + '.');
  if (outcomes.some(ok => !ok)) process.exitCode = 1;
} finally {
  await Promise.allSettled(devices.map(device => device.close()));
  if (browser) await browser.close();
}
