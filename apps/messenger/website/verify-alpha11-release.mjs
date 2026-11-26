// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {cp, mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';

const [baseline, pinned, promoted, modules, signedApk, previousApk] = process.argv.slice(2);
if (!previousApk) throw Error('Expected three successive website modules, the production modules directory, and signed Alpha11 and Alpha10 APKs.');
const apkName = 'Vellivex-Messenger-0.1.0-alpha11-universal.apk';
const apkPath = '/downloads/' + apkName;
const mime = 'application/vnd.android.package-archive';
const origin = 'https://www.vellivex.com';
const work = await mkdtemp(join(tmpdir(), 'vellivex-alpha11-site-'));
const context = {waitUntil(promise) { promise.catch(() => {}); }};
const offline = {MESSENGER_RELEASES: {async head() {}, async get() {}}};
const request = (app, path, method = 'GET', env = offline, headers = {}) =>
  app.fetch(new Request(origin + path, {method, headers}), env, context);

async function hash(stream) {
  const digest = createHash('sha256');
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

async function snapshot(response) {
  return [response.status, [...response.headers], createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')];
}

try {
  const apps = [];
  for (const [i, file] of [baseline, pinned, promoted].entries()) {
    const stage = join(work, String(i));
    await cp(modules, stage, {recursive: true});
    await cp(file, join(stage, 'phone-shop.mjs'));
    apps.push((await import(pathToFileURL(join(stage, 'app-access-entry.mjs')))).default);
  }
  const [old, standalone, live] = apps;
  async function assertDownload(version, signedApk, stages) {
    const apkName = 'Vellivex-Messenger-0.1.0-alpha' + version + '-universal.apk';
    const apkPath = '/downloads/' + apkName;
    const expectedHash = await hash(createReadStream(signedApk));
    const size = (await stat(signedApk)).size;
    const source = await readFile(pinned, 'utf8');
    const match = source.match(new RegExp('const candidateAlpha' + version + String.raw` = Object\.freeze\((\{[^}]+\})\);`));
    assert.ok(match, 'Missing pinned object');
    const spec = JSON.parse(match[1]);
    assert.equal(spec.key, apkName);
    assert.equal(spec.sha256, expectedHash);
    assert.equal(spec.bytes, size);
    assert.match(spec.version, /^[a-f\d]{32}$/);
    assert.match(spec.etag, /^[a-f\d]{32}(?:-[1-9][0-9]*)?$/);
    const object = {
      key: spec.key, size, version: spec.version, etag: spec.etag, httpMetadata: {contentType: mime},
      checksums: {sha256: Uint8Array.from(Buffer.from(expectedHash, 'hex')).buffer},
      customMetadata: {sha256: expectedHash},
    };
    const available = {MESSENGER_RELEASES: {
      async head(key) { return key === apkName ? object : null; },
      async get(key, options) {
        assert.equal(key, apkName);
        assert.equal(options.onlyIf.etagMatches, spec.etag);
        if (!options.range) return {...object, body: Readable.toWeb(createReadStream(signedApk))};
        const {offset, length} = options.range;
        return {...object, range: options.range,
          body: Readable.toWeb(createReadStream(signedApk, {start: offset, end: offset + length - 1}))};
      },
    }};
    for (const app of stages) {
      const full = await request(app, apkPath, 'GET', available);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), mime);
      assert.equal(full.headers.get('x-content-sha256'), expectedHash);
      assert.equal(full.headers.get('content-length'), String(size));
      assert.equal(await hash(full.body), expectedHash);
      const head = await request(app, apkPath, 'HEAD', available);
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      for (const [start, end] of [[0, 1023], [size - 1024, size - 1]]) {
        const response = await request(app, apkPath, 'GET', available, {Range: 'bytes=' + start + '-' + end});
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), 'bytes ' + start + '-' + end + '/' + size);
        assert.equal(await hash(response.body), await hash(createReadStream(signedApk, {start, end})));
      }
      const stale = {MESSENGER_RELEASES: {
        async head() { return {...object, version: 'unexpected-version'}; },
        async get() { throw Error('Invalid version reached object GET'); },
      }};
      assert.equal((await request(app, apkPath, 'GET', stale)).status, 503);
    }
    return available;
  }
  const available = await assertDownload(11, signedApk, [standalone, live]);
  await assertDownload(10, previousApk, [old, standalone, live]);
  for (const path of ['/invite', '/invite/manual', '/.well-known/assetlinks.json', '/privacy', '/phones', '/security',
    '/downloads/Vellivex-Messenger-0.1.0-alpha08-arm64.apk', apkPath.replace('alpha11', 'alpha09'), apkPath.replace('alpha11', 'alpha10')]) {
    for (const method of ['GET', 'HEAD']) {
      const original = await snapshot(await request(old, path, method));
      for (const app of [standalone, live]) {
        assert.deepEqual(await snapshot(await request(app, path, method)), original, method + ' ' + path);
      }
    }
  }
  for (const path of ['/', '/messenger']) {
    const original = await request(old, path);
    assert.deepEqual(await snapshot(original), await snapshot(await request(standalone, path)));
    const response = await request(live, path, 'GET', available);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.equal((page.match(/class="messenger-download"/g) || []).length, 1);
    assert.ok(page.includes('href="' + apkPath + '">Download Alpha11 APK</a>'));
    if (path === '/messenger') {
      for (const label of ['Enable background alerts', 'Android notification settings', 'New Vellivex message',
        'Open in Vellivex', 'Copy contact ID', 'Message history warning']) assert.ok(page.includes(label), label);
    }
  }
  console.log('Verified both signed APKs, range reads, object pins, prior routes, and public download instructions.');
} finally {
  await rm(work, {recursive: true, force: true});
}
