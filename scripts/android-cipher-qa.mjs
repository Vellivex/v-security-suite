// SPDX-License-Identifier: GPL-3.0-or-later
// Optional V Cipher QR text-fallback check for an offline Android Chrome context.
import assert from 'node:assert/strict';

export async function verifyCipherOffline(page, openTool) {
  const origin = 'https://www.vellivex.com';
  await openTool(page, `${origin}/apps/cipher/relay`, true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);

  const fixture = await page.evaluate(async () => {
    const { generateIdentity } = await import('/apps/cipher/protocol.js');
    const { card, fingerprint } = await generateIdentity();
    return { card: JSON.stringify(card), fingerprint };
  });
  await page.locator('#transfer-input').fill(fixture.card);
  await page.locator('#relay-qr').click();
  await page.locator('#cipher-status').filter({ hasText: /Public contact QR ready/ }).waitFor({ state: 'visible' });
  const total = Number((await page.locator('#qr-count').innerText()).match(/Frame 1 of (\d+)/)?.[1]);
  assert.ok(Number.isInteger(total) && total > 0 && total <= 48, 'Unexpected V Cipher frame count.');
  const frames = [];
  for (let index = 1; index <= total; index++) {
    await page.locator('#qr-count').filter({ hasText: `Frame ${index} of ${total}.` }).waitFor({ state: 'visible' });
    frames.push(await page.locator('#qr-frame-text').inputValue());
    if (index < total) await page.locator('#qr-next').click();
  }
  assert.equal(new Set(frames).size, total, 'Each V Cipher frame must be nonrepeating.');

  await openTool(page, `${origin}/apps/cipher/vault`, true);
  for (let index = 0; index < frames.length; index++) {
    await page.locator('#scan-frame-input').fill(frames[index]);
    await page.locator('#scan-frame').click();
    const status = index + 1 === total ? /QR complete: public contact card loaded/ : `${index + 1} of ${total} frames`;
    await page.locator('#cipher-status').filter({ hasText: status }).waitFor({ state: 'visible' });
  }
  assert.ok(await page.locator('#contact-card').inputValue() === fixture.card, 'Offline Vault must reconstruct the exact public contact.');
  await page.locator('#cipher-contact').click();
  await page.locator('#cipher-status').filter({ hasText: /Public card valid/ }).waitFor({ state: 'visible' });
  assert.ok((await page.locator('#contact-fingerprint').innerText()).includes(fixture.fingerprint), 'The reconstructed card must match the expected fingerprint.');
  console.log('PASS V Cipher offline Android Chrome reconstructed the exact public card from numbered QR text frames and verified its fingerprint');
}
