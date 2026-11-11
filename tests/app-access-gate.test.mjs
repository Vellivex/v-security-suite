// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {CENTRAL_ORIGIN, APP_AUDIENCES, LEGACY_APP_ORIGINS, allowedAudience, validReturnPath, classifyAppRequest} from '../server/app-access/registry.mjs';
import {APP_COOKIE, FLOW_COOKIE_PREFIX, AppAccessUnavailable, createAppAccessGate, validateAppAccess, markAuthorizedAppDocument, validAccessToken} from '../server/app-access/gate.mjs';

const token = n => Buffer.alloc(32, n).toString('base64url');
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
const NOW = 1_800_000_000_000;
const ORIGIN = 'https://vkey.vellivex.com';
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
function harness(overrides = {}) {
  const calls = [], flows = new Map(); let redeemed = false;
  const broker = async request => {
    const url = new URL(request.url), data = await request.json();
    calls.push({url: url.href, body: data, headers: Object.fromEntries(request.headers)});
    assert.equal(url.origin, 'https://app-access.internal');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Cookie'), null);
    assert.equal(request.headers.get('Authorization'), null);
    if (overrides.reply) return overrides.reply(url.pathname, data, request);
    if (url.pathname.endsWith('/prepare')) {
      assert.equal(Object.keys(data).sort().join(','), 'audience,returnPath,state,verifierHash');
      assert.equal(validAccessToken(data.verifierHash), true);
      flows.set(token(10), data);
      return json({flowId: token(10), authorizeUrl: CENTRAL_ORIGIN + '/access?flow=' + token(10) + '#_'});
    }
    if (url.pathname.endsWith('/redeem')) {
      const flow = flows.get(token(10));
      if (!flow || redeemed || data.code !== token(11) || data.state !== flow.state || data.audience !== flow.audience || await hash(data.verifier) !== flow.verifierHash) return json({error: 'invalid'}, 401);
      redeemed = true;
      return json({sessionToken: token(12), expiresIn: 3600, returnPath: flow.returnPath, state: flow.state});
    }
    if (url.pathname.endsWith('/validate')) {
      if (data.sessionToken !== token(12) || data.audience !== ORIGIN) return json({error: 'invalid'}, 401);
      return json({valid: true, scope: {id: token(13), epoch: 1, session: token(14), appAccess: true}, expiresAt: NOW + 3600_000});
    }
    throw Error('unexpected broker route');
  };
  return {calls, flows, broker, gate: createAppAccessGate({broker, now: () => NOW})};
}
function pageScript(html) {
  const match = html.match(/<script nonce="[A-Za-z0-9_-]+">([\s\S]+)<\/script>/);
  assert.ok(match, 'nonce-protected bootstrap exists'); return match[1];
}
function storage() {
  const data = new Map();
  return {data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key)};
}
function executePage(html, {fragment = '', saved = storage()} = {}) {
  const navigations = [], history = [], status = {textContent: ''};
  vm.runInNewContext(pageScript(html), {
    location: {hash: fragment, replace: value => navigations.push(value)},
    history: {replaceState: (...args) => history.push(args)},
    sessionStorage: saved, document: {getElementById: () => status},
  });
  return {navigations, history, saved, status};
}
function req(path, headers = {}, method = 'GET', origin = ORIGIN) {
  return new Request(origin + path, {method, headers});
}
async function startFlow(h, fragment = '#private=fictional-secret') {
  const gate = await h.gate.handle(req('/'), {});
  const run = executePage(await gate.text(), {fragment});
  assert.equal(run.navigations.length, 1);
  const start = new URL(run.navigations[0], ORIGIN); start.hash = '';
  const result = await h.gate.handle(new Request(start, {headers: {'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '192.0.2.10'}}), {});
  return {state: start.searchParams.get('state'), run, result};
}

test('all eleven direct entrances, offline sources, APK versions and actual aliases are gated', () => {
  const entries = [
    ['https://www.vellivex.com', '/apps/guard'], ['https://www.vellivex.com', '/apps/vault'],
    ['https://www.vellivex.com', '/apps/relay'], ['https://www.vellivex.com', '/apps/cipher'],
    ['https://www.vellivex.com', '/apps/mail'], ['https://www.vellivex.com', '/apps/sms'],
    [CENTRAL_ORIGIN, '/call.html'], ['https://vphone.vellivex.com', '/'],
    ['https://vdecoy.vellivex.com', '/'], [ORIGIN, '/'], ['https://private.vellivex.com', '/'],
  ];
  assert.equal(entries.length, 11);
  for (const [origin, path] of entries) {
    assert.equal(validReturnPath(origin, path), true);
    assert.equal(classifyAppRequest(req(path, {}, 'GET', origin)).kind, 'document');
  }
  for (const path of ['/offline/vault', '/offline/relay', '/offline/cipher/vault', '/offline/cipher/relay', '/apps/cipher/vault', '/apps/cipher/relay']) assert.equal(classifyAppRequest(req(path, {}, 'GET', 'https://vellivex.com')).kind, 'document');
  assert.equal(classifyAppRequest(req('/index.html', {}, 'GET', 'https://vphone.vellivex.com')).kind, 'document');
  assert.equal(classifyAppRequest(req('/index.html', {}, 'GET', 'https://vdecoy.vellivex.com')).kind, 'document');
  for (const path of ['/live', '/live/']) assert.equal(classifyAppRequest(req(path, {}, 'GET', 'https://private.vellivex.com')).kind, 'document');
  for (const path of ['/downloads/VGuard-0.1.4-candidate.apk', '/downloads/VGuard-0.1.1.apk']) assert.equal(classifyAppRequest(req(path, {}, 'GET', 'https://www.vellivex.com')).kind, 'download');
});
test('public information and strong account root stay open; arbitrary returns cannot escape allowlist', () => {
  for (const path of ['/', '/privacy', '/source', '/terms', '/downloads/VGuard-Source-GPL.zip']) assert.equal(classifyAppRequest(req(path, {}, 'GET', 'https://www.vellivex.com')), null);
  assert.equal(classifyAppRequest(req('/', {}, 'GET', CENTRAL_ORIGIN)), null);
  for (const audience of ['https://vkey.vellivex.com.evil.test', 'http://vkey.vellivex.com', 'https://vkey.vellivex.com:8443', 'https://user@vkey.vellivex.com', 'https://vkey.vellivex.com/']) assert.equal(allowedAudience(audience), false);
  for (const path of ['//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/apps/vault?next=https://evil.test', '/apps/vault#secret', '/apps/vault\r\nX: x', '/api/account', '/access', '/apps/../privacy']) assert.equal(validReturnPath('https://www.vellivex.com', path), false);
  assert.equal(Object.keys(APP_AUDIENCES).length, 7);
});
test('alternate workers.dev entrances are denied rather than redirecting a private fragment', async () => {
  const h = harness();
  for (const origin of Object.keys(LEGACY_APP_ORIGINS)) {
    const result = await h.gate.handle(req('/', {}, 'GET', origin), {});
    assert.equal(result.status, 403); assert.equal(result.headers.get('Location'), null);
  }
  assert.equal(h.calls.length, 0);
});
test('only new admission and public number feeds require login; capabilities retain read/delete/join', async () => {
  const h = harness();
  const api = [req('/api/rooms', {}, 'POST'), req('/api/ice', {}, 'POST'), req('/api/mail/inbox', {}, 'POST', 'https://www.vellivex.com'), req('/api/public-sms?country=GB', {}, 'GET', 'https://www.vellivex.com')];
  for (const request of api) { const result = await h.gate.handle(request, {}); assert.equal(result.status, 401); assert.equal(result.headers.get('Location'), null); }
  for (const [path, method] of [['/api/rooms/fictional', 'GET'], ['/api/rooms/fictional', 'DELETE'], ['/api/rooms/fictional/join', 'POST'], ['/api/rooms/fictional/answer', 'PUT']]) assert.equal(await h.gate.handle(req(path, {}, method), {}), null);
  assert.equal(await h.gate.handle(req('/api/mail/inbox/fictional', {}, 'DELETE', 'https://www.vellivex.com'), {}), null);
});
test('bootstrap keeps invitation only in same-origin sessionStorage and prevents fragment inheritance', async () => {
  const h = harness(), secret = '#v=2&key=fictional-private-key';
  const page = await h.gate.handle(req('/'), {}), html = await page.text();
  assert.equal(page.headers.get('Location'), null); assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(page.headers.get('X-Vellivex-App-Access'), 'required');
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
  assert.equal(html.includes(secret), false);
  const run = executePage(html, {fragment: secret});
  assert.equal(run.saved.data.size, 1);
  assert.equal(JSON.parse([...run.saved.data.values()][0]).fragment, secret);
  assert.equal(run.history[0][2], '/#_');
  assert.ok(run.navigations[0].startsWith('/__access/start?'));
  assert.ok(run.navigations[0].endsWith('#_'));
  assert.equal(run.navigations[0].includes('fictional-private-key'), false);
  assert.equal(h.calls.length, 0);
});
test('prepare is same-origin and returns HttpOnly per-flow verifier with exact central handoff', async () => {
  const h = harness(), flow = await startFlow(h);
  assert.equal(flow.result.status, 303);
  assert.equal(flow.result.headers.get('Location'), CENTRAL_ORIGIN + '/access?flow=' + token(10) + '#_');
  const cookie = flow.result.headers.get('Set-Cookie');
  assert.ok(cookie.startsWith(FLOW_COOKIE_PREFIX + flow.state.slice(0, 12) + '='));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(cookie.includes(flag));
  assert.equal(/Domain=/i.test(cookie), false);
  assert.equal(h.calls[0].headers['cf-connecting-ip'], '192.0.2.10');
  assert.equal(JSON.stringify(h.calls).includes('fictional-secret'), false);
  const start = '/__access/start?state=' + token(1) + '&next=%2F';
  for (const headers of [{}, {'Sec-Fetch-Site': 'same-site'}, {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-origin', Origin: 'https://private.vellivex.com'}]) assert.equal((await h.gate.handle(req(start, headers), {})).status, 403);
});
test('callback binds one-use code to exact audience, state and verifier and restores fragment locally', async () => {
  const h = harness(), flow = await startFlow(h), verifierCookie = flow.result.headers.get('Set-Cookie').split(';')[0];
  const finishPath = '/__access/finish?code=' + token(11) + '&state=' + flow.state;
  assert.equal((await h.gate.handle(req(finishPath), {})).status, 401);
  assert.equal((await h.gate.handle(req(finishPath, {Cookie: verifierCookie.replace(/=.*/, '=' + token(2))}), {})).status, 401);
  const finish = await h.gate.handle(req(finishPath, {Cookie: verifierCookie}), {});
  assert.equal(finish.status, 303); assert.ok(finish.headers.get('Location').endsWith('#_'));
  const setCookies = finish.headers.getSetCookie(); assert.equal(setCookies.length, 2);
  assert.ok(setCookies[0].startsWith(APP_COOKIE + '=' + token(12)));
  assert.ok(setCookies[1].includes('Max-Age=0'));
  for (const value of setCookies) { assert.match(value, /HttpOnly/); assert.doesNotMatch(value, /Domain=/i); }
  const callback = new URL(finish.headers.get('Location'), ORIGIN); callback.hash = '';
  const returned = await h.gate.handle(new Request(callback), {});
  const run = executePage(await returned.text(), {saved: flow.run.saved});
  assert.deepEqual(run.navigations, ['/#private=fictional-secret']); assert.equal(run.saved.data.size, 0);
  assert.equal((await h.gate.handle(req(finishPath, {Cookie: verifierCookie}), {})).status, 401);
  assert.equal(JSON.stringify(h.calls).includes('fictional-secret'), false);
});
test('valid app cookie yields only low privilege scope; malformed, duplicate and revoked cookies do not pass', async () => {
  const h = harness(), good = req('/', {Cookie: APP_COOKIE + '=' + token(12)});
  assert.equal(await h.gate.handle(good, {}), null);
  assert.deepEqual(await validateAppAccess(good, {}, {broker: h.broker, now: () => NOW}), {id: token(13), epoch: 1, session: token(14), appAccess: true});
  for (const value of ['bad', token(2), token(12) + '; ' + APP_COOKIE + '=' + token(12)]) {
    const result = await h.gate.handle(req('/', {Cookie: APP_COOKIE + '=' + value}), {});
    assert.equal(result.headers.get('X-Vellivex-App-Access'), 'required');
  }
  assert.equal((await h.gate.handle(req('/', {Cookie: APP_COOKIE + '=' + token(12)}, 'GET', 'https://private.vellivex.com'), {})).headers.get('X-Vellivex-App-Access'), 'required');
});
test('broker cannot substitute external authorize redirect, wrong return, oversize session or malformed scope', async () => {
  for (const replacement of [
    {flowId: token(10), authorizeUrl: 'https://evil.test/access?flow=' + token(10) + '#_'},
    {flowId: token(10), authorizeUrl: CENTRAL_ORIGIN + '/access?flow=' + token(10)},
    {flowId: token(10), authorizeUrl: CENTRAL_ORIGIN + '/access?flow=' + token(10) + '&next=evil#_'},
  ]) {
    const h = harness({reply: () => json(replacement)}), result = await h.gate.handle(req('/__access/start?state=' + token(1) + '&next=%2F', {'Sec-Fetch-Site': 'same-origin'}), {});
    assert.equal(result.status, 503); assert.equal(result.headers.get('Set-Cookie'), null);
  }
  for (const scope of [{id: token(13), epoch: 0, session: token(14), appAccess: true}, {id: 'short', epoch: 1, session: token(14), appAccess: true}, {id: token(13), epoch: 1, session: token(14), appAccess: true, admin: true}]) {
    const h = harness({reply: () => json({valid: true, scope, expiresAt: NOW + 1000})});
    await assert.rejects(validateAppAccess(req('/', {Cookie: APP_COOKIE + '=' + token(12)}), {}, {broker: h.broker, now: () => NOW}), AppAccessUnavailable);
  }
});
test('missing/failed broker fails closed instead of bypassing a protected page', async () => {
  const request = req('/', {Cookie: APP_COOKIE + '=' + token(12)});
  assert.equal((await createAppAccessGate().handle(request, {})).status, 503);
  for (const reply of [() => json({error: 'unavailable'}, 503), () => new Response('not JSON'), () => json({huge: 'x'.repeat(5000)})]) {
    const h = harness({reply}); assert.equal((await h.gate.handle(request, {})).status, 503);
  }
});
test('duplicate, hostile and malformed protocol query parameters cannot invoke broker', async () => {
  const h = harness();
  for (const path of [
    '/__access/start?state=' + token(1) + '&state=' + token(1) + '&next=%2F',
    '/__access/start?state=' + token(1) + '&next=https%3A%2F%2Fevil.test',
    '/__access/start?state=' + token(1) + '&next=%2F&extra=1',
    '/__access/return?state=' + token(1) + '&next=%2F%2Fevil.test',
    '/__access/finish?state=' + token(1) + '&code=invalid',
  ]) assert.ok((await h.gate.handle(req(path, {'Sec-Fetch-Site': 'same-origin'}), {})).status >= 400);
  assert.equal(h.calls.length, 0);
});
test('authorized marker preserves app headers and covers offline transport without marking public files', () => {
  for (const [path, type] of [['/apps/vault', 'text/html; charset=utf-8'], ['/offline/vault', 'text/plain; charset=utf-8']]) {
    const before = new Response('original bytes', {headers: {'Content-Type': type, 'Content-Security-Policy': "connect-src 'none'", 'Cache-Control': 'no-store, no-transform'}});
    const after = markAuthorizedAppDocument(req(path, {}, 'GET', 'https://www.vellivex.com'), before);
    assert.equal(after.headers.get('X-Vellivex-App-Access'), 'verified');
    assert.equal(after.headers.get('Content-Security-Policy'), "connect-src 'none'");
    assert.equal(after.headers.get('Cache-Control'), 'no-store, no-transform');
  }
  const original = new Response('public');
  assert.equal(markAuthorizedAppDocument(req('/source', {}, 'GET', 'https://www.vellivex.com'), original), original);
});
