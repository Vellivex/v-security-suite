// SPDX-License-Identifier: GPL-3.0-or-later
// Production web acceptance in Chrome on an isolated Android emulator.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { _android as android } from 'playwright';
import { verifyCipherCamera } from './android-cipher-camera-qa.mjs';
import { verifyCipherOffline } from './android-cipher-qa.mjs';

const origin = 'https://www.vellivex.com';
const vaultUrl = `${origin}/apps/vault`;
const relayUrl = `${origin}/apps/relay`;
const messageMarker = randomUUID();
const message = `Fictional Android browser QA ${messageMarker}\nLine two.`;
const passphrase = `Android QA only ${randomUUID()}`;

const devices = await android.devices();
const selectedSerial = process.env.ANDROID_SERIAL;
const emulators = devices.filter(device => /^emulator-\d+$/.test(device.serial()));
const device = selectedSerial ? emulators.find(item => item.serial() === selectedSerial) :
  emulators.length === 1 ? emulators[0] : undefined;
assert.ok(device, 'Use one isolated Android emulator or identify it with ANDROID_SERIAL.');

async function openTool(page, url, requireServiceWorker = false) {
  const navigation = { waitUntil: 'domcontentloaded', timeout: 30_000 };
  const response = page.url() === url ? await page.reload(navigation) : await page.goto(url, navigation);
  assert.equal(response?.status(), 200, 'The Vellivex tool must return HTTP 200.');
  assert.equal(page.url(), url, 'The test requires the production Vellivex tool.');
  if (requireServiceWorker) {
    assert.equal(response.fromServiceWorker(), true, 'The offline document must come from the service worker.');
  }
}

async function openFirstPage(page) {
  // ADB boot completion can precede Android's first usable network route.
  for (let attempt = 1; ; attempt++) {
    try {
      await openTool(page, vaultUrl);
      return;
    } catch (error) {
      if (attempt === 6 || !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(error.message)) throw error;
      console.log('Waiting for the isolated Android emulator network to become ready.');
      await delay(4_000);
    }
  }
}

async function expectStatus(page, text, timeout = 12_000) {
  await page.locator('#app-status').filter({ hasText: text }).waitFor({ state: 'visible', timeout });
}

async function decrypt(page, envelope, password) {
  await page.locator('#vault-mode').selectOption('decrypt');
  await page.locator('#message').fill(envelope);
  await page.locator('#passphrase').fill(password);
  await page.locator('#vault-submit').click();
}

let context;
let stage = 'launch Android Chrome';
try {
  const androidVersion = (await device.shell('getprop ro.build.version.release')).toString().trim();
  const packagePath = (await device.shell('pm path com.android.chrome')).toString();
  assert.match(packagePath, /^package:/m, 'The emulator must have Google Chrome installed.');
  context = await device.launchBrowser({ viewport: null });
  context.setDefaultTimeout(12_000);
  const page = await context.newPage();

  stage = 'confirm the Android mobile browser';
  await openFirstPage(page);
  const mobile = await page.evaluate(() => ({ ua: navigator.userAgent, width: innerWidth }));
  assert.match(mobile.ua, /Android.*Chrome\/\d+.*Mobile/);
  assert.ok(mobile.width > 0 && mobile.width < 800, 'Expected the native Android phone viewport.');
  console.log(`PASS Android ${androidVersion} Chrome ${mobile.ua.match(/Chrome\/([\d.]+)/)[1]} (${mobile.width} CSS px)`);

  stage = 'VVault local encryption';
  await page.locator('#message').fill(message);
  await page.locator('#passphrase').fill(passphrase);
  await page.locator('#passphrase-confirm').fill(passphrase);
  await page.locator('#vault-submit').click();
  await expectStatus(page, /Encrypted locally/);
  await page.locator('#download-result').waitFor({ state: 'visible' });
  const envelope = await page.locator('#result').inputValue();
  assert.equal(JSON.parse(envelope).format, 'VVAULT');
  assert.ok(!envelope.includes(messageMarker), 'The encrypted package must not include the plaintext marker.');
  console.log('PASS VVault encrypted fictional text in Android Chrome and offered an encrypted download');

  stage = 'VRelay encrypted file import';
  await openTool(page, relayUrl);
  await page.locator('#relay-file').setInputFiles({
    name: 'android-qa.vvault',
    mimeType: 'application/json',
    buffer: Buffer.from(envelope, 'utf8'),
  });
  await expectStatus(page, /Loaded locally/);
  await page.locator('#relay-form button[type=submit]').click();
  await expectStatus(page, /Package format checked/);
  const transferred = await page.locator('#result').inputValue();
  assert.ok(transferred === envelope, 'VRelay must preserve the imported package byte-for-byte.');
  console.log('PASS VRelay imported a test file containing the exact VVault bytes and validated its format in Android Chrome');

  stage = 'VVault wrong-passphrase rejection';
  await openTool(page, vaultUrl);
  await decrypt(page, transferred, 'Incorrect QA passphrase');
  await expectStatus(page, /Unable to unlock/);
  assert.equal(await page.locator('#result').inputValue(), '');
  console.log('PASS VVault rejected the wrong passphrase and exposed no plaintext');

  stage = 'install verified offline tools';
  await page.locator('#offline-enable').click();
  await expectStatus(page, /Offline files installed with integrity checks|No new offline release found/, 35_000);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');

  stage = 'verify Android browser offline';
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  const outsideCache = `${origin}/?android-qa-network-probe=${randomUUID()}`;
  assert.equal(await page.evaluate(url => fetch(url, { cache: 'no-store' }).then(() => true, () => false), outsideCache), false);

  stage = 'VVault offline reload and decryption';
  await openTool(page, vaultUrl, true);
  await decrypt(page, transferred, passphrase);
  await expectStatus(page, /Unlocked locally/);
  assert.ok(await page.locator('#result').inputValue() === message, 'Offline decryption must reproduce the exact fictional message.');
  console.log('PASS VVault reloaded from the service worker and recovered the exact message with Android Chrome offline');

  stage = 'VRelay offline reload and package validation';
  await openTool(page, relayUrl, true);
  await page.locator('#relay-package').fill(transferred);
  await page.locator('#relay-form button[type=submit]').click();
  await expectStatus(page, /Package format checked/);
  assert.ok(await page.locator('#result').inputValue() === envelope, 'Offline VRelay must preserve the exact package.');
  console.log('PASS VRelay reloaded from the service worker and validated the same package offline');

  stage = 'V Cipher offline numbered QR text transfer';
  await verifyCipherOffline(page, openTool);

  stage = 'V Cipher offline QR scanning from synthetic camera video';
  await verifyCipherCamera(page, openTool);
} catch (error) {
  console.error(`FAIL Android browser at ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await context?.close();
  await device.close();
}
