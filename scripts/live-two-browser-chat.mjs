// SPDX-License-Identifier: GPL-3.0-or-later
// One-off synthetic, two-browser *live* production chat acceptance check.
// No account credentials, real messages, screenshots, video, traces or secret logging.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const VKEY = 'https://vkey.vellivex.com/';
const PRIVATE = 'https://private.vellivex.com/';
const WAIT = 65_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
async function syntheticVKey(browser) {
  const hostContext = await browser.newContext({ permissions: [], serviceWorkers: 'block' });
  const peerContext = await browser.newContext({ permissions: [], serviceWorkers: 'block' });
  let host, peer, stage = 'opening';
  try {
    host = await hostContext.newPage();
    peer = await peerContext.newPage();
    await Promise.all([
      host.goto(VKEY, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
      peer.goto(VKEY, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
    ]);
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
    console.error('VKey error type=' + (error?.name || 'unknown'));
    throw new Error('VKey real browser acceptance did not complete at stage: ' + stage);
  } finally {
    await Promise.allSettled([hostContext.close(), peerContext.close()]);
  }
}
async function syntheticPrivate(browser) {
  const hostContext = await browser.newContext({ permissions: [], serviceWorkers: 'block' });
  const peerContext = await browser.newContext({ permissions: [], serviceWorkers: 'block' });
  let host, peer, stage = 'opening';
  try {
    host = await hostContext.newPage();
    peer = await peerContext.newPage();
    await Promise.all([
      host.goto(PRIVATE, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
      peer.goto(PRIVATE, { waitUntil: 'domcontentloaded', timeout: 25_000 }),
    ]);
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

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
try {
  const run = process.env.VELLIVEX_E2E_TARGET || 'both';
  if (!['both','vkey','private'].includes(run)) throw Error('Invalid test selection');
  const outcomes = [];
  if (run === 'both' || run === 'vkey') {
    try { await syntheticVKey(browser); outcomes.push(true); }
    catch { outcomes.push(false); }
  }
  if (run === 'both' || run === 'private') {
    try { await syntheticPrivate(browser); outcomes.push(true); }
    catch { outcomes.push(false); }
  }
  console.log('Browser checks passed: ' + outcomes.filter(Boolean).length + '/' + outcomes.length + '. One Chromium runner, not physical devices.');
  if (outcomes.some(ok => !ok)) process.exitCode = 1;
} finally {
  await browser.close();
}
