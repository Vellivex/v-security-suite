// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CHAT_ASSET_BASELINES, CHAT_SESSION_BASELINE_SHA256, createChatOverrides, createChatSessionOverride} from '../server/app-access/patch-chat.mjs';

const baseline = readFileSync(new URL('./fixtures/app-access/public-session-baseline.mjs', import.meta.url), 'utf8');
const digest = source => createHash('sha256').update(source).digest('hex');

test('chat override changes exactly the two credentials options in the verified current client', () => {
  assert.equal(digest(baseline), CHAT_SESSION_BASELINE_SHA256);
  assert.equal(baseline.length, 15416);
  const override = createChatSessionOverride(baseline);
  assert.deepEqual(Object.keys(override), ['/public-session.mjs']);
  const asset = override['/public-session.mjs'];
  assert.equal(asset.type, 'text/javascript; charset=utf-8');
  assert.equal(asset.body.split("credentials:'same-origin'").length - 1, 2);
  assert.equal(asset.body.includes("credentials:'omit'"), false);
  assert.equal(asset.body.replaceAll("credentials:'same-origin'", "credentials:'omit'"), baseline);
  assert.equal(Object.isFrozen(override), true); assert.equal(Object.isFrozen(asset), true);
  const otherAssets = {'/': {body: 'original HTML', type: 'text/html'}, '/crypto.mjs': {body: 'unchanged cryptography'}, '/chat-core.mjs': {body: 'unchanged core'}};
  const assets = {...otherAssets, '/public-session.mjs': {body: baseline, type: asset.type}}, combined = {...assets, ...override};
  for (const name of Object.keys(otherAssets)) assert.equal(combined[name], assets[name]);
  assert.equal(assets['/public-session.mjs'].body, baseline);
});

test('chat patch rejects unexpected versions, partial replacements and unregistered module families', () => {
  for (const source of [baseline + '\n', baseline.replace("credentials:'omit'", "credentials:'same-origin'"), baseline.replace('PUBLIC_ICE_QUIET_MS=2000', 'PUBLIC_ICE_QUIET_MS=1'), '', null]) {
    assert.throws(() => createChatSessionOverride(source), /audited live client/);
  }
  for (const family of ['vkey', 'private', 'unknown', '__proto__']) {
    assert.throws(() => createChatOverrides(family, 'export default {};\n'), /audited live baseline/);
  }
  for (const hash of Object.values(CHAT_ASSET_BASELINES)) assert.match(hash, /^[0-9a-f]{64}$/);
});

test('patched session sends same-origin credentials for creation and capability cleanup without changing token semantics', async () => {
  const calls = [], source = createChatSessionOverride(baseline)['/public-session.mjs'].body;
  class ChatSession {
    constructor() { this.abort = new AbortController(); this.closed = false; }
    guard() { if (this.closed) throw Error('closed'); }
    finish() { this.closed = true; this.room = this.token = this.role = null; }
  }
  // Execute only the reviewed client with a minimal transport base: the test
  // exercises real API/cleanup code without browser WebRTC dependencies.
  const context = vm.createContext({ChatSession, AbortController, TextDecoder, setTimeout, clearTimeout});
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replaceAll('export ', '') + '\n globalThis.Session = PublicChatSession;', context);
  const session = new context.Session(() => {}, {fetcher: async (path, options) => {
    calls.push({path, options});
    return Response.json(options.method === 'POST' ? {ok: true, setupVersion: 2} : {ok: true});
  }});
  session.room = 'fictional-room'; session.token = 'fictional-capability'; session.role = 'host';
  await session.api('', {method: 'POST', body: {id: 'fictional-room'}});
  assert.equal(calls[0].path, '/api/rooms'); assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['X-Room-Token'], 'fictional-capability');
  assert.equal(calls[0].options.headers['X-Room-Role'], 'host');
  assert.equal(JSON.parse(calls[0].options.body).setupVersion, 2);
  session.finish('Ended'); const cleaned = await session.cleanup;
  assert.equal(cleaned.acknowledged, true);
  assert.equal(calls[1].path, '/api/rooms/fictional-room');
  assert.equal(calls[1].options.method, 'DELETE'); assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.headers['X-Room-Token'], 'fictional-capability');
  assert.equal(calls[1].options.headers['X-Room-Role'], 'host');
  assert.equal(calls[1].options.keepalive, true); assert.equal(calls[1].options.referrerPolicy, 'no-referrer');
  assert.equal(session.token, null); assert.equal(session.room, null);
});
