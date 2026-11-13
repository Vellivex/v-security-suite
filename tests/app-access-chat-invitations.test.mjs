// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import {CHAT_INVITATION_BASELINES, createChatInvitationOverride, CALL_INVITATION_BASELINE, patchCallInvitationModule, patchCallInvitationFixture} from '../server/app-access/patch-chat-invitations.mjs';
import {CLEANUP_RELEASE_BEFORE, CLEANUP_RELEASE_AFTER} from '../server/app-access/patch-chat-cleanup.mjs';
import {createChatSessionOverride} from '../server/app-access/patch-chat.mjs';
import {readInvitation, encode64} from './fixtures/app-access/chat-crypto-baseline.mjs';

const read = file => readFileSync(new URL('./fixtures/app-access/' + file, import.meta.url), 'utf8');
const sources = {vkey: read('vkey-app-baseline.mjs'), private: read('private-ui-baseline.mjs')};
const digest = value => createHash('sha256').update(value).digest('hex');
const patched = family => Object.values(createChatInvitationOverride(family, sources[family]))[0].body;
const room = encode64(new Uint8Array(16).fill(1)), secret = encode64(new Uint8Array(32).fill(2)), inviteToken = encode64(new Uint8Array(32).fill(3));
const validHash = '#v=1&r=' + room + '&k=' + secret + '&i=' + inviteToken;

function browser(url) {
  const nodes = new Map(), replacements = [], starts = [], parseCalls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', textContent: '', hidden: true, open: false, checked: false, disabled: false,
      listeners: {}, dataset: {}, removeAttribute() {}, addEventListener(type, callback) { this.listeners[type] = callback; },
      classList: {toggle() {}, add() {}, remove() {}}, replaceChildren() {}, append() {}});
    return nodes.get(id);
  };
  const location = new URL(url), history = {replaceState(_state, _title, path) { replacements.push(path); location.href = new URL(path, location).href; }};
  const document = {hidden: false, visibilityState: 'visible', getElementById: node, addEventListener() {}};
  const window = {location, history, addEventListener() {}};
  const context = vm.createContext({URL, URLSearchParams, TextEncoder, TextDecoder, document, window, location, history,
    crypto: webcrypto, isSecureContext: true, RTCPeerConnection: class {}, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    readInvitation(...args) { parseCalls.push(args); return readInvitation(...args); },
    ScreenKeyboard: class { setAvailable() {} }, bindHoldToKeep() {},
    ChatSession: class { constructor() { starts.push('construct'); } },
    privateChatSession() { throw Error('Default factory must not run in a fixture test'); },
    privateVoiceCall() { throw Error('Default voice factory must not run in a fixture test'); }});
  return {context, node, window, document, replacements, starts, parseCalls};
}
function vkey(hash, source = patched('vkey')) {
  const b = browser('https://vkey.vellivex.com/' + hash);
  vm.runInContext(source.replace(/^import .*;\n/gm, '') + '\nglobalThis.getInvite=()=>activeInvite;', b.context);
  return b;
}
function privateUI(hash, source = patched('private')) {
  const b = browser('https://private.vellivex.com/live' + hash), joins = [];
  const session = {join: async (...args) => { joins.push(args); }, create: async () => b.starts.push('create'), finish() {}, cleanup: Promise.resolve({required: false})};
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('export function mountLiveUI', 'function mountLiveUI') + '\nglobalThis.mount=mountLiveUI;', b.context);
  b.context.mount(b.document, b.window, {chatFactory: async () => { b.starts.push('factory'); return session; }, voiceFactory: async () => { b.starts.push('voice'); return session; }});
  return {...b, joins};
}

test('exact live client hashes are required and only the fragment branch changes', () => {
  for (const family of ['vkey', 'private']) {
    const baseline = CHAT_INVITATION_BASELINES[family], output = createChatInvitationOverride(family, sources[family]);
    assert.equal(digest(sources[family]), baseline.sha256);
    assert.deepEqual(Object.keys(output), [baseline.path]);
    assert.equal(output[baseline.path].body.replace(baseline.replacement, baseline.anchor), sources[family]);
    for (const source of [sources[family] + '\n', patched(family), '', null]) assert.throws(() => createChatInvitationOverride(family, source), /audited live baseline/);
  }
  for (const family of ['unknown', '__proto__']) assert.throws(() => createChatInvitationOverride(family, sources.vkey), /audited live baseline/);
});

test('VKey reproduces the sentinel false error, then accepts empty and sentinel entries quietly', () => {
  assert.match(vkey('#_', sources.vkey).node('notice').textContent, /invitation link is incomplete/);
  for (const hash of ['', '#_']) {
    const b = vkey(hash);
    assert.equal(b.node('notice').textContent, ''); assert.equal(b.node('join-details').open, false);
    assert.equal(b.node('invite-input').value, ''); assert.equal(b.context.getInvite(), null);
    assert.deepEqual(b.parseCalls, []); assert.deepEqual(b.starts, []);
    assert.equal(b.window.location.hash, ''); assert.deepEqual(b.replacements, hash ? ['/'] : []);
  }
});

test('VKey still rejects every malformed real fragment and accepts a complete invitation unchanged', () => {
  for (const hash of ['#_=1', '#_%20', '#_&v=1', '#v=1', validHash + '&extra=1', validHash.replace('v=1', 'v=2')]) {
    const before = vkey(hash, sources.vkey), after = vkey(hash);
    assert.equal(after.node('notice').textContent, before.node('notice').textContent);
    assert.match(after.node('notice').textContent, /invitation/); assert.equal(after.context.getInvite(), null);
    assert.equal(after.parseCalls.length, 1); assert.equal(after.window.location.hash, ''); assert.deepEqual(after.starts, []);
  }
  const b = vkey(validHash);
  assert.deepEqual(b.context.getInvite(), {room, secret, inviteToken});
  assert.equal(b.node('invite-input').value, 'https://vkey.vellivex.com/' + validHash);
  assert.equal(b.node('join-details').open, true); assert.match(b.node('notice').textContent, /You have an invitation/);
  assert.equal(b.parseCalls.length, 1); assert.equal(b.window.location.hash, ''); assert.deepEqual(b.starts, []);
});

test('Private no longer preloads an empty-marker invitation and leaves empty entry unchanged', () => {
  assert.equal(privateUI('#_', sources.private).node('invitation').value, 'https://private.vellivex.com/live#_');
  for (const hash of ['', '#_']) {
    const b = privateUI(hash);
    assert.equal(b.node('invitation').value, ''); assert.equal(b.node('status').textContent, '');
    assert.deepEqual(b.parseCalls, []); assert.deepEqual(b.starts, []);
    assert.equal(b.window.location.hash, ''); assert.deepEqual(b.replacements, hash ? ['/live'] : []);
  }
});

test('Private preserves malformed-link rejection on Join and valid text/voice preloading', async () => {
  for (const hash of ['#_=1', '#_%20', '#_&v=1', '#v=1', validHash + '&extra=1']) {
    const b = privateUI(hash);
    assert.equal(b.node('invitation').value, 'https://private.vellivex.com/live' + hash);
    b.node('consent').checked = true; await b.node('join').listeners.click();
    assert.equal(b.parseCalls.length, 1); assert.deepEqual(b.joins, []);
    assert.match(b.node('status').textContent, /That step could not finish/);
  }
  const b = privateUI(validHash);
  assert.equal(b.node('mode').value, 'chat'); assert.match(b.node('status').textContent, /Invitation loaded/);
  b.node('consent').checked = true; await b.node('join').listeners.click();
  assert.deepEqual(b.joins, [['Peer', {room, secret, inviteToken}]]);
  const voice = privateUI(validHash.replace('v=1', 'v=2'));
  assert.equal(voice.node('mode').value, 'voice'); assert.match(voice.node('status').textContent, /Invitation loaded/);
  assert.deepEqual(voice.starts, []);
});

test('authenticated session changes only the reviewed cleanup retry and shared access marker stays', () => {
  const session = createChatSessionOverride(read('public-session-baseline.mjs'));
  assert.equal(digest('export default ' + JSON.stringify(session) + ';\n'), '48e0b728219d92968fc1d34bea10874b7b626a49a5c00f9b450fd40269f301d2');
  const restored = {'/public-session.mjs': {...session['/public-session.mjs'], body: session['/public-session.mjs'].body.replace(CLEANUP_RELEASE_AFTER, CLEANUP_RELEASE_BEFORE)}};
  assert.equal(digest('export default ' + JSON.stringify(restored) + ';\n'), '2f02c953a2c57fbc097a94f83aa7f80183b0c7683f47379585390eec3af53634');
  for (const family of ['vkey', 'private']) {
    const combined = {...session, ...createChatInvitationOverride(family, sources[family])};
    assert.equal(combined['/public-session.mjs'], session['/public-session.mjs']);
  }
  const gate = readFileSync(new URL('../server/app-access/gate.mjs', import.meta.url), 'utf8');
  assert.match(gate, /location\.replace\(path\+\(fragment\|\|'#_'\)\)/);
});

async function callUI(hash, source = patchCallInvitationFixture(read('call-ui-baseline.mjs'))) {
  const b = browser('https://call.vellivex.com/call.html' + hash), joins = [];
  const call = {status: {phase: 'idle', message: 'Ready', microphoneActive: false, soundEnabled: false}, invitationLink: '',
    addEventListener() {}, join: async link => joins.push(link), create: async () => b.starts.push('create')};
  Object.assign(b.context, {atob, btoa, AbortController, fetch: async () => ({ok: true}),
    boundedJson: async () => ({enabled: true, maxSeconds: 300, phoneCalling: false, profile: 'wss-opus-v1'}),
    OpusAudio: {supported: async () => true}});
  // Fixtures are exact portions of the deployed module's template literal.
  // Decode its escaped backslashes without evaluating the containing Worker.
  const decodeTemplatePortion = text => text.replaceAll('\\\\', '\\');
  vm.runInContext(decodeTemplatePortion(read('call-crypto-baseline.mjs')) + '\n' + decodeTemplatePortion(source), b.context);
  b.context.setupInternetCallUI({call});
  await new Promise(resolve => setImmediate(resolve));
  return {...b, joins};
}
const callHash = '#v=2&r=11111111-1111-4111-8111-111111111111&j=' + inviteToken + '&k=' + secret;

test('Call removes only the access marker and retains the precise embedded initializer patch', async () => {
  const source = read('call-ui-baseline.mjs'), {anchor, replacement} = CALL_INVITATION_BASELINE;
  assert.equal(patchCallInvitationFixture(source).replace(replacement, anchor), source);
  for (const unexpected of [source + '\n', patchCallInvitationFixture(source), null, '']) assert.throws(() => patchCallInvitationFixture(unexpected), /audited live baseline/);
  assert.throws(() => patchCallInvitationModule(source), /audited live baseline/);
  assert.match((await callUI('#_', source)).node('call-status').textContent, /invitation link is invalid/);
  for (const hash of ['', '#_']) {
    const b = await callUI(hash);
    assert.equal(b.node('call-status').textContent, 'Ready'); assert.equal(b.node('call-status').dataset.state, '');
    assert.match(b.node('call-incoming-note').textContent, /^Open the private link/);
    assert.equal(b.node('call-incoming').value, ''); assert.equal(b.window.location.hash, '');
    assert.deepEqual(b.replacements, hash ? ['/call.html'] : []); assert.deepEqual(b.starts, []); assert.deepEqual(b.joins, []);
    assert.equal(b.node('call-mic-on').disabled, true); assert.equal(b.node('call-sound').disabled, true);
  }
});

test('Call still rejects malformed invitations and loads a valid invitation without joining automatically', async () => {
  for (const hash of ['#_=1', '#_%20', '#_&v=2', '#v=2', callHash + '&extra=1', callHash.replace('v=2', 'v=1')]) {
    const b = await callUI(hash);
    assert.match(b.node('call-status').textContent, /invitation link is invalid/);
    assert.equal(b.node('call-status').dataset.state, 'error'); assert.deepEqual(b.joins, []);
  }
  const b = await callUI(callHash);
  assert.equal(b.node('call-status').textContent, 'Ready'); assert.match(b.node('call-incoming-note').textContent, /^A private invitation is ready/);
  assert.equal(b.window.location.hash, ''); assert.deepEqual(b.joins, []);
  b.node('call-consent').checked = true; b.node('call-join').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(b.joins, ['https://call.vellivex.com/call.html' + callHash]);
  assert.equal(b.node('call-mic-on').disabled, true); assert.equal(b.node('call-sound').disabled, true);
});
