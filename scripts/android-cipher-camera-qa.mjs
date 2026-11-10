// SPDX-License-Identifier: GPL-3.0-or-later
// V Cipher browser camera-path QA using Relay pixels and a synthetic video source.
import assert from 'node:assert/strict';

const ORIGIN = 'https://www.vellivex.com';
const CAMERA = '__vellivexQrCameraQa';
const WAIT = 20_000;

export async function verifyCipherCamera(page, openTool) {
  await openTool(page, `${ORIGIN}/apps/cipher/relay`, true);
  const fixture = await page.evaluate(async () => {
    const { generateIdentity } = await import('/apps/cipher/protocol.js');
    const { card, fingerprint } = await generateIdentity();
    return { card: JSON.stringify(card), fingerprint };
  });
  await page.locator('#transfer-input').fill(fixture.card);
  await page.locator('#relay-qr').click();
  const status = page.locator('#cipher-status');
  await status.filter({ hasText: /Public contact QR ready/ }).waitFor({ state: 'visible', timeout: WAIT });
  const count = Number((await page.locator('#qr-count').innerText()).match(/Frame 1 of (\d+)/)?.[1]);
  assert.ok(Number.isInteger(count) && count >= 2 && count <= 48, 'Expected a bounded, multi-frame QR transfer.');

  const frames = [];
  for (let number = 1; number <= count; number++) {
    await page.locator('#qr-count').filter({ hasText: `Frame ${number} of ${count}.` }).waitFor({ state: 'visible', timeout: WAIT });
    frames.push(await page.locator('#cipher-qr').evaluate(canvas => {
      const { width, height } = canvas;
      if (width !== height || width <= 1 || width > 640) throw Error('Unexpected QR canvas dimensions.');
      const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
      const packed = new Uint8Array(Math.ceil(width * height / 8));
      for (let i = 0; i < width * height; i++) {
        if (data[i * 4] < 128) packed[i >> 3] |= 1 << (i & 7);
      }
      return { size: width, packed: btoa(String.fromCharCode(...packed)) };
    }));
    if (number < count) await page.locator('#qr-next').click();
  }
  assert.equal(new Set(frames.map(frame => frame.packed)).size, count, 'Relay rendered duplicate QR images.');

  await openTool(page, `${ORIGIN}/apps/cipher/vault`, true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  await page.evaluate(key => {
    const devices = navigator.mediaDevices;
    if (!devices || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      throw Error('Browser lacks the synthetic video capture API.');
    }
    const previous = Object.getOwnPropertyDescriptor(devices, 'getUserMedia');
    const source = document.createElement('canvas');
    source.width = source.height = 640;
    const paint = source.getContext('2d');
    let image = null;
    let timer = null;
    let stream = null;
    const redraw = () => {
      paint.fillStyle = '#fff';
      paint.fillRect(0, 0, source.width, source.height);
      if (image) {
        const offset = Math.floor((source.width - image.width) / 2);
        paint.putImageData(image, offset, offset);
      }
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      stream?.getTracks().forEach(track => track.stop());
    };
    Object.defineProperty(devices, 'getUserMedia', {
      configurable: true,
      value: async constraints => {
        if (constraints.audio !== false || !constraints.video) throw Error('Unexpected V Cipher media request.');
        stop();
        redraw();
        stream = source.captureStream(10);
        timer = setInterval(redraw, 100);
        return stream;
      },
    });
    window[key] = {
      render({ size, packed }) {
        const bytes = atob(packed);
        image = paint.createImageData(size, size);
        for (let i = 0; i < size * size; i++) {
          const dark = (bytes.charCodeAt(i >> 3) & (1 << (i & 7))) !== 0;
          const pixel = i * 4;
          image.data[pixel] = image.data[pixel + 1] = image.data[pixel + 2] = dark ? 0 : 255;
          image.data[pixel + 3] = 255;
        }
        redraw();
      },
      ended() {
        return stream?.getVideoTracks().length === 1 &&
          stream.getVideoTracks()[0].readyState === 'ended';
      },
      restore() {
        stop();
        if (previous) Object.defineProperty(devices, 'getUserMedia', previous);
        else delete devices.getUserMedia;
        delete window[key];
      },
    };
  }, CAMERA);

  try {
    const start = page.locator('#scan-start');
    const ready = status.filter({ hasText: /Camera reads locally/ });
    await start.click();
    await ready.waitFor({ state: 'visible', timeout: WAIT });
    await page.locator('#scan-stop').click();
    await status.filter({ hasText: /Camera stopped/ }).waitFor({ state: 'visible', timeout: WAIT });
    assert.equal(await page.evaluate(key => window[key].ended(), CAMERA), true, 'Stop must end the media track.');
    await start.click();
    await ready.waitFor({ state: 'visible', timeout: WAIT });

    for (const [index, frame] of frames.entries()) {
      await page.evaluate(({ key, frame }) => window[key].render(frame), { key: CAMERA, frame });
      const progress = index + 1 === count
        ? /QR complete: public contact card loaded/
        : `${index + 1} of ${count} frames`;
      await status.filter({ hasText: progress }).waitFor({ state: 'visible', timeout: WAIT });
    }
    assert.equal(await page.locator('#contact-card').inputValue(), fixture.card);
    assert.equal(await page.evaluate(key => window[key].ended(), CAMERA), true, 'A completed transfer must stop the media track.');
    assert.equal(await page.locator('#scan-video').evaluate(video => video.hidden && video.srcObject === null), true);
    await page.locator('#cipher-contact').click();
    await status.filter({ hasText: /Public card valid/ }).waitFor({ state: 'visible', timeout: WAIT });
    assert.ok((await page.locator('#contact-fingerprint').innerText()).includes(fixture.fingerprint));
    console.log(`PASS V Cipher Android Chrome decoded all ${count} QR images from a synthetic video stream offline, checked the fingerprint and stopped capture.`);
  } finally {
    await page.evaluate(key => window[key]?.restore(), CAMERA);
  }
}
