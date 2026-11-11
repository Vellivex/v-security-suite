// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppAccess} from '../server/app-access/entry.mjs';
import {APP_COOKIE} from '../server/app-access/gate.mjs';
import {CENTRAL_ORIGIN} from '../server/app-access/registry.mjs';

const token = n => Buffer.alloc(32, n).toString('base64url');
const ORIGIN = 'https://www.vellivex.com';
const cookie = {["Cookie"]: APP_COOKIE + '=' + token(1)};
const request = (path, {origin = ORIGIN, method = 'GET', headers = {}} = {}) => new Request(origin + path, {method, headers});
function environment(log) {
  return {APP_ACCESS: {async fetch(req) {
    assert.equal(new URL(req.url).origin, 'https://app-access.internal');
    const data = await req.json(); log.push(['validate', data.audience]);
    assert.equal(data.sessionToken, token(1));
    return Response.json({valid: true, scope: {id: token(2), epoch: 1, session: token(3), appAccess: true}, expiresAt: Date.now() + 3600_000});
  }}};
}

test('wrapper rejects app entry before invoking proxy or original and marks only authorized documents', async () => {
  const log = [];
  const worker = withAppAccess({async fetch() {log.push(['original']); return new Response('private app bytes', {headers: {'Content-Type': 'text/html', 'Content-Security-Policy': "connect-src 'none'", 'Cache-Control': 'no-store, no-transform'}});}}, {proxy: async () => {log.push(['proxy']); return null;}});
  const env = environment(log);
  const denied = await worker.fetch(request('/apps/vault'), env);
  assert.equal(denied.headers.get('X-Vellivex-App-Access'), 'required');
  assert.equal((await denied.text()).includes('private app bytes'), false);
  assert.deepEqual(log, []);
  const allowed = await worker.fetch(request('/apps/vault', {headers: cookie}), env);
  assert.deepEqual(log, [['validate', ORIGIN], ['proxy'], ['original']]);
  assert.equal(await allowed.text(), 'private app bytes');
  assert.equal(allowed.headers.get('X-Vellivex-App-Access'), 'verified');
  assert.equal(allowed.headers.get('Cache-Control'), 'no-store, no-transform');
  assert.equal(allowed.headers.get('Content-Security-Policy'), "connect-src 'none'");
});

test('central router dispatches only the exact trusted origins and route namespaces', async () => {
  const calls = [];
  const central = {fetch: async req => {calls.push(new URL(req.url).href); return new Response('central');}};
  const worker = withAppAccess({fetch: async () => new Response('original')}, {central});
  for (const path of ['/access', '/access-ui.js', '/access.css', '/api/app-access/bootstrap', '/__app_access/validate']) {
    assert.equal(await (await worker.fetch(request(path, {origin: CENTRAL_ORIGIN}), {})).text(), 'central');
  }
  assert.equal(await (await worker.fetch(request('/__app_access/validate', {origin: 'https://app-access.internal', method: 'POST'}), {})).text(), 'central');
  const routed = calls.length;
  assert.equal(await (await worker.fetch(request('/access'), {})).text(), 'original');
  for (const origin of ['https://call.vellivex.com.evil.test', 'https://app-access.internal.evil.test', 'http://call.vellivex.com', 'https://call.vellivex.com:8443']) {
    assert.equal((await worker.fetch(request('/access', {origin}), {})).status, 403);
  }
  for (const path of ['/', '/access/extra', '/access-ui.js/extra', '/api/app-access-other/bootstrap', '/__app_access-evil/validate']) {
    assert.equal(await (await worker.fetch(request(path, {origin: CENTRAL_ORIGIN}), {})).text(), 'original');
  }
  assert.equal(calls.length, routed);
});

test('unknown preview hosts and per-entry origin mismatches fail closed before original dispatch', async () => {
  let calls = 0;
  const worker = withAppAccess({fetch: async () => {calls++; return new Response('private original');}}, {origins: [ORIGIN, 'https://vellivex.com']});
  for (const origin of ['https://vellivex-site-migration.vellivex-call.workers.dev', 'https://abc123-vellivex-site-migration.vellivex-call.workers.dev', 'https://unlisted.vellivex.com', 'https://vphone.vellivex.com']) {
    const result = await worker.fetch(request('/unlisted-route', {origin}), {});
    assert.equal(result.status, 403); assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('Location'), null); assert.equal(result.headers.get('X-Vellivex-App-Access'), 'required');
  }
  assert.equal(calls, 0);
  for (const origin of [ORIGIN, 'https://vellivex.com']) assert.equal(await (await worker.fetch(request('/privacy', {origin}), {})).text(), 'private original');
  assert.equal(calls, 2);
  assert.throws(() => withAppAccess({fetch() {}}, {origins: ['https://unknown.test']}), /registered app origins/);
});

test('existing event handlers, context and capability WebSocket response are preserved', async () => {
  const scheduled = () => 'scheduled', queue = () => 'queue', ctx = {waitUntil: () => {}}, env = {};
  // Node Response excludes status101; model the platform upgrade response to
  // verify the wrapper returns the exact original object without reconstruction.
  const upgrade = {status: 101, headers: new Headers(), webSocket: {accepted: true}};
  const original = {scheduled, queue, marker: true, async fetch(req, gotEnv, gotCtx) {
    assert.equal(this, original); assert.equal(gotEnv, env); assert.equal(gotCtx, ctx);
    assert.equal(new URL(req.url).pathname, '/api/rooms/room/messages'); return upgrade;
  }};
  const worker = withAppAccess(original);
  assert.equal(worker.scheduled, scheduled); assert.equal(worker.queue, queue); assert.equal(worker.marker, true);
  assert.equal(await worker.fetch(request('/api/rooms/room/messages', {origin: 'https://vkey.vellivex.com'}), env, ctx), upgrade);
});

test('asset overrides retain security policy, remove stale byte metadata, and honor HEAD and errors', async () => {
  const worker = withAppAccess({async fetch(req) {
    return new Response(req.method === 'HEAD' ? null : 'old', {status: new URL(req.url).search ? 404 : 200, headers: {'Content-Type': 'text/plain', 'Content-Length': '3', 'Content-Encoding': 'gzip', ETag: 'old', 'Content-Security-Policy': "default-src 'none'"}});
  }}, {overrides: {'/bundle.js': {type: 'text/javascript', body: 'new code'}}});
  for (const method of ['GET', 'HEAD']) {
    const response = await worker.fetch(request('/bundle.js', {method}), {});
    assert.equal(response.status, 200); assert.equal(await response.text(), method === 'HEAD' ? '' : 'new code');
    assert.equal(response.headers.get('Content-Type'), 'text/javascript');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'");
    for (const name of ['Content-Length', 'Content-Encoding', 'ETag']) assert.equal(response.headers.get(name), null);
  }
  const missing = await worker.fetch(request('/bundle.js?missing=1'), {});
  assert.equal(missing.status, 404); assert.equal(await missing.text(), 'old');
  const post = await worker.fetch(request('/bundle.js', {method: 'POST'}), {});
  assert.equal(await post.text(), 'old');
});

test('creation proxy runs after admission; capability cleanup remains available without an app cookie', async () => {
  const log = [];
  const worker = withAppAccess({fetch: async () => {log.push(['original']); return new Response('unexpected');}}, {proxy: async req => {log.push(['proxy', req.method]); return new Response('proxied');}});
  const env = environment(log);
  const denied = await worker.fetch(request('/api/mail/inbox', {method: 'POST'}), env);
  assert.equal(denied.status, 401); assert.deepEqual(log, []);
  const created = await worker.fetch(request('/api/mail/inbox', {method: 'POST', headers: cookie}), env);
  assert.equal(await created.text(), 'proxied'); assert.deepEqual(log, [['validate', ORIGIN], ['proxy', 'POST']]);
  log.length = 0;
  const deleted = await worker.fetch(request('/api/mail/inbox/existing', {method: 'DELETE'}), env);
  assert.equal(await deleted.text(), 'proxied'); assert.deepEqual(log, [['proxy', 'DELETE']]);
});
