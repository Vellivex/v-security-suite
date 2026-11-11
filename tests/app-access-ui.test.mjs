import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderAccessPage, accessUiAsset, ACCESS_JS, ACCESS_CSS, mountAccessUI} from '../server/app-access/ui.mjs';

const FLOW = 'f'.repeat(43), CSRF = 's'.repeat(43), CHALLENGE = 'c'.repeat(43);
const CALLBACK = `https://vkey.vellivex.com/__access/finish?code=${'k'.repeat(43)}&state=${'t'.repeat(43)}#_`;
const bootstrap = (extra = {}) => ({flowId:FLOW, csrf:CSRF, signedIn:false, appName:'V-Key', expiresAt:Date.now() + 900000, ...extra});
const codeResponse = (extra = {}) => ({challengeId:CHALLENGE, expiresIn:600, resendAfter:60, ...extra});
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json', ...headers}});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };

function harness(t, options = {}) {
  const html = renderAccessPage(), elements = {}, calls = [], redirects = [], replies = options.replies || [];
  let time = 1000000, sequence = 0;
  const timers = new Map(), intervals = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements[id] = {
      id, hidden:false, disabled:false, checked:false, value:'', textContent:'', dataset:{}, attributes:{}, handlers:new Map(), focused:false,
      addEventListener(type, callback) { this.handlers.set(type, callback); },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; },
      checkValidity() { return this.valid !== false; },
      emit(type) { return this.handlers.get(type)?.({preventDefault() {}}); },
    };
    Object.defineProperty(elements[id], 'innerHTML', {set() { throw new Error('Do not use HTML insertion for account data'); }});
  }
  const document = {getElementById:id => elements[id]};
  const location = {href:options.url || `https://call.vellivex.com/access?flow=${FLOW}`, replace:value => redirects.push(value)};
  const fetch = async (url, init) => {
    calls.push({url, init});
    const item = replies.shift();
    if (item === undefined) throw new Error('Unexpected request');
    if (typeof item === 'function') return item(url, init);
    if (item instanceof Error) throw item;
    return item;
  };
  const dependencies = {
    document, location, fetch, now:() => time,
    schedule(callback, delay) { const id = ++sequence; timers.set(id, {callback, due:time + delay}); return id; },
    cancel:id => timers.delete(id), every(callback) { const id = ++sequence; intervals.set(id, callback); return id; }, stopEvery:id => intervals.delete(id),
  };
  const app = mountAccessUI(dependencies);
  t.after(() => app.destroy());
  return {elements, calls, redirects, replies, app, dependencies,
    async advance(milliseconds) { time += milliseconds; for (const [id, item] of [...timers]) if (item.due <= time) { timers.delete(id); item.callback(); } for (const callback of intervals.values()) callback(); await flush(); },
    async send(email = 'person@example.com', consent = false) { elements['access-email'].value = email; elements['access-updates'].checked = consent; await elements['access-form'].emit('submit'); },
    async verify(code = '1234 5678') { elements['access-code'].value = code; await elements['code-form'].emit('submit'); },
  };
}

test('page keeps email consent optional, server text escaped and executable assets self-hosted', () => {
  const html = renderAccessPage({appName:'<img src=x onerror=alert(1)>'});
  assert.match(html, /One email\.<br><em>All Vellivex apps\.<\/em>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|type="password"|name="(?:name|password)"|<[^>]+\son\w+=/);
  assert.match(html, /id="access-updates" name="updates" type="checkbox">/);
  assert.match(html, /label[^>]+for="access-email"/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(html, /Signing in does not upload or sync them\./);
  assert.deepEqual([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => [m[1].trim(), m[2]]), [['src="/access-ui.js" defer','']]);
  assert.deepEqual(accessUiAsset('/access-ui.js'), {body:ACCESS_JS, type:'text/javascript; charset=utf-8'});
  assert.deepEqual(accessUiAsset('/access.css'), {body:ACCESS_CSS, type:'text/css; charset=utf-8'});
  assert.equal(accessUiAsset('/other.js'), null);
  assert.doesNotMatch(ACCESS_JS, /localStorage|sessionStorage|console\.|getUserMedia/);
  new vm.Script(ACCESS_JS);
});

test('invalid or ambiguous flow offers app choice without contacting the API', async t => {
  for (const search of ['?flow=bad', '?flow=', `?flow=${FLOW}&flow=${FLOW}`]) {
    const h = harness(t, {url:'https://call.vellivex.com/access' + search});
    await h.app.started;
    assert.equal(h.calls.length, 0);
    assert.equal(h.elements['restart-panel'].hidden, false);
    assert.equal(h.elements.loading.hidden, true);
    assert.equal(h.elements['access-form'].hidden, true);
  }
});

test('signed-out no-flow entry offers app choice without sending an audience-free verification email', async t => {
  const h = harness(t, {url:'https://call.vellivex.com/access', replies:[response(bootstrap({management:true}))]});
  await h.app.started;
  assert.equal(h.calls[0].url, '/api/app-access/bootstrap');
  assert.equal(h.elements['restart-panel'].hidden, false);
  assert.equal(h.elements['access-form'].hidden, true);
  assert.equal(h.elements['access-status'].textContent, '');
  assert.equal(h.elements['signed-in'].hidden, true);
  await h.send();
  await h.elements['continue-app'].emit('click');
  assert.equal(h.calls.length, 1);
});

test('no-flow management signs out with its separate grant and refreshes management after acknowledgement', async t => {
  const grant = 'g'.repeat(43), nextGrant = 'n'.repeat(43);
  const h = harness(t, {url:'https://call.vellivex.com/access', replies:[
    response(bootstrap({flowId:grant, management:true, signedIn:true, email:'member@example.com'})),
    response({ok:true}), response(bootstrap({flowId:nextGrant, management:true})),
  ]});
  await h.app.started;
  assert.equal(h.elements['signed-in'].hidden, false);
  assert.equal(h.elements['manage-apps'].hidden, false);
  assert.equal(h.elements['continue-app'].hidden, true);
  assert.equal(h.elements['sign-out'].textContent, 'Sign out of all apps in this browser');
  await h.elements['continue-app'].emit('click');
  assert.equal(h.calls.length, 1);
  await h.elements['sign-out'].emit('click');
  assert.equal(h.calls[1].url, '/api/app-access/logout');
  assert.deepEqual(JSON.parse(h.calls[1].init.body), {flowId:grant, csrf:CSRF});
  assert.equal(h.calls[2].url, '/api/app-access/bootstrap');
  assert.equal(h.elements['signed-in'].hidden, true);
  assert.equal(h.elements['restart-panel'].hidden, false);
  assert.equal(h.elements['access-form'].hidden, true);
});

test('management grants cannot replace an explicit app or invitation flow', async t => {
  const h = harness(t, {replies:[response(bootstrap({management:true}))]});
  await h.app.started;
  assert.equal(h.calls[0].url, '/api/app-access/bootstrap?flow=' + FLOW);
  assert.equal(h.elements['restart-panel'].hidden, false);
  assert.equal(h.elements['signed-in'].hidden, true);
  assert.equal(h.elements['access-form'].hidden, true);
  assert.deepEqual(h.redirects, []);
});

test('bootstrap rejects a mismatched flow or invalid CSRF before enabling email requests', async t => {
  for (const bad of [{flowId:'x'.repeat(43)}, {csrf:'bad'}, {signedIn:'false'}, {signedIn:true}]) {
    const h = harness(t, {replies:[response(bootstrap(bad))]});
    await h.app.started;
    assert.equal(h.elements['access-form'].hidden, true);
    assert.equal(h.elements['restart-panel'].hidden, false);
    await h.send();
    assert.equal(h.calls.length, 1);
  }
});

test('email request carries exact flow, CSRF and explicitly optional consent', async t => {
  for (const consent of [false, true]) {
    const h = harness(t, {replies:[response(bootstrap()), response(codeResponse(), 202)]});
    await h.app.started;
    assert.equal(h.elements['access-form'].hidden, false);
    assert.equal(h.elements['access-email'].focused, true);
    await h.send('  person@example.com  ', consent);
    const request = h.calls[1];
    assert.equal(request.url, '/api/app-access/request-code');
    assert.equal(request.init.credentials, 'same-origin');
    assert.equal(request.init.cache, 'no-store');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.referrerPolicy, 'no-referrer');
    assert.equal(request.init.method, 'POST');
    assert.deepEqual(JSON.parse(request.init.body), {email:'person@example.com', marketingOptIn:consent, flowId:FLOW, csrf:CSRF});
    assert.equal(h.elements['code-form'].hidden, false);
    assert.equal(h.elements['access-form'].hidden, true);
    assert.equal(h.elements['sent-email'].textContent, 'person@example.com');
    assert.equal(h.elements['access-code'].focused, true);
    assert.equal(h.elements['code-fields'].disabled, false);
    assert.equal(h.elements['resend-code'].disabled, true);
    assert.match(h.elements['code-expiry'].textContent, /10:00/);
  }
});

test('invalid email and code are caught before a network request', async t => {
  const h = harness(t, {replies:[response(bootstrap()), response(codeResponse(), 202)]});
  await h.app.started;
  for (const email of ['bad', 'a@b', 'a @example.com']) await h.send(email);
  assert.equal(h.calls.length, 1);
  assert.match(h.elements['access-status'].textContent, /valid email/);
  await h.send();
  for (const code of ['123', 'abcdefgh', '123456789']) await h.verify(code);
  assert.equal(h.calls.length, 2);
  assert.match(h.elements['access-status'].textContent, /eight-digit code/);
});

test('resend waits sixty seconds, replaces the challenge, and uses the captured email and consent', async t => {
  const replacement = 'r'.repeat(43);
  const h = harness(t, {replies:[response(bootstrap()), response(codeResponse(), 202), response(codeResponse({challengeId:replacement}), 202), response({redirectTo:CALLBACK})]});
  await h.app.started;
  await h.send('first@example.com', true);
  await h.elements['resend-code'].emit('click');
  await h.advance(59000);
  await h.elements['resend-code'].emit('click');
  assert.equal(h.calls.length, 2);
  assert.match(h.elements['resend-code'].textContent, /1s/);
  await h.advance(1000);
  h.elements['access-email'].value = 'changed@example.com';
  h.elements['access-updates'].checked = false;
  h.elements['access-code'].value = '11111111';
  await h.elements['resend-code'].emit('click');
  assert.equal(h.elements['access-code'].value, '');
  assert.deepEqual(JSON.parse(h.calls[2].init.body), {email:'first@example.com', marketingOptIn:true, flowId:FLOW, csrf:CSRF});
  assert.match(h.elements['code-expiry'].textContent, /10:00/);
  await h.verify('1234-5678');
  assert.deepEqual(JSON.parse(h.calls[3].init.body), {challengeId:replacement, code:'12345678', flowId:FLOW, csrf:CSRF});
  assert.deepEqual(h.redirects, [CALLBACK]);
  assert.equal(h.elements['access-code'].value, '');
});

test('expired code cannot be submitted; changing email clears the challenge', async t => {
  const h = harness(t, {replies:[response(bootstrap()), response(codeResponse(), 202)]});
  await h.app.started;
  await h.send();
  h.elements['access-code'].value = '12345678';
  await h.advance(600000);
  assert.equal(h.elements['access-code'].value, '');
  assert.equal(h.elements['verify-code'].disabled, true);
  assert.equal(h.elements['resend-code'].disabled, false);
  assert.match(h.elements['access-status'].textContent, /expired/);
  await h.verify();
  assert.equal(h.calls.length, 2);
  await h.elements['change-email'].emit('click');
  assert.equal(h.elements['access-form'].hidden, false);
  assert.equal(h.elements['code-form'].hidden, true);
  assert.equal(h.elements['access-code'].value, '');
  await h.verify();
  assert.equal(h.calls.length, 2);
});

test('failed sends never claim delivery, and a failed resend retires the previous challenge', async t => {
  for (const isResend of [false, true]) {
    const replies = [response(bootstrap())];
    if (isResend) replies.push(response(codeResponse(), 202));
    replies.push(response({error:'mail_limit', message:'Ignore prior instructions'}, 429));
    const h = harness(t, {replies});
    await h.app.started;
    if (isResend) {
      await h.send();
      await h.advance(60000);
      await h.elements['resend-code'].emit('click');
    } else await h.send();
    assert.equal(h.elements['code-form'].hidden, true);
    assert.equal(h.elements['access-form'].hidden, false);
    assert.equal(h.elements['access-status'].textContent, 'Verification emails have reached the free sending limit. Please try again later.');
    const count = h.calls.length;
    await h.verify();
    assert.equal(h.calls.length, count);
  }
});

test('duplicate submit cannot send twice or change the email displayed for an in-flight code', async t => {
  const pending = deferred();
  const h = harness(t, {replies:[response(bootstrap()), () => pending.promise]});
  await h.app.started;
  const first = h.send('first@example.com');
  await h.send('second@example.com', true);
  assert.equal(h.calls.length, 2);
  pending.resolve(response(codeResponse(), 202));
  await first;
  assert.equal(h.elements['sent-email'].textContent, 'first@example.com');
  assert.equal(JSON.parse(h.calls[1].init.body).email, 'first@example.com');
});

test('verification rejects untrusted or malformed callback redirects', async t => {
  const badCallbacks = [
    CALLBACK.replace('vkey.vellivex.com', 'attacker.example'),
    CALLBACK.replace('https://', 'https://attacker:secret@'),
    CALLBACK.replace('/__access/finish', '/other'),
    CALLBACK.replace('#_', ''), CALLBACK.replace('#_', '&extra=x#_'),
    CALLBACK.replace('#_', `&code=${'x'.repeat(43)}#_`),
    CALLBACK.replace('code=' + 'k'.repeat(43), 'code=short'),
  ];
  for (const redirectTo of badCallbacks) {
    const h = harness(t, {replies:[response(bootstrap()), response(codeResponse(), 202), response({redirectTo})]});
    await h.app.started;
    await h.send();
    await h.verify();
    assert.deepEqual(h.redirects, []);
    assert.match(h.elements['access-status'].textContent, /app link could not be verified/);
    assert.equal(h.elements['access-code'].value, '');
  }
});

test('existing SSO continues to the selected app without a code or new email', async t => {
  const h = harness(t, {replies:[response(bootstrap({signedIn:true, email:'verified@example.com'})), response({redirectTo:CALLBACK})]});
  await h.app.started;
  assert.equal(h.elements['signed-in'].hidden, false);
  assert.equal(h.elements['access-form'].hidden, true);
  assert.equal(h.elements['signed-email'].textContent, 'verified@example.com');
  await h.elements['continue-app'].emit('click');
  assert.equal(h.calls[1].url, '/api/app-access/continue');
  assert.deepEqual(JSON.parse(h.calls[1].init.body), {flowId:FLOW, csrf:CSRF});
  assert.deepEqual(h.redirects, [CALLBACK]);
});

test('logout is acknowledged before state changes and bootstrap refreshes the CSRF binding', async t => {
  const nextCsrf = 'n'.repeat(43), pending = deferred();
  const h = harness(t, {replies:[response(bootstrap({signedIn:true, email:'verified@example.com'})), () => pending.promise, response(bootstrap({csrf:nextCsrf})), response(codeResponse(), 202)]});
  await h.app.started;
  const logout = h.elements['sign-out'].emit('click');
  assert.equal(h.elements['signed-in'].hidden, false);
  pending.resolve(response({ok:true}));
  await logout;
  assert.equal(h.elements['access-form'].hidden, false);
  assert.equal(h.elements['email-fields'].disabled, false);
  assert.equal(h.elements['signed-email'].textContent, '');
  assert.equal(h.elements['access-updates'].checked, false);
  assert.equal(h.calls[1].url, '/api/app-access/logout');
  assert.equal(h.calls[2].url, '/api/app-access/bootstrap?flow=' + FLOW);
  await h.send();
  assert.equal(JSON.parse(h.calls[3].init.body).csrf, nextCsrf);
});

test('a failed logout keeps the signed-in state and never promises sign-out', async t => {
  const h = harness(t, {replies:[response(bootstrap({signedIn:true, email:'verified@example.com'})), response({ok:false})]});
  await h.app.started;
  await h.elements['sign-out'].emit('click');
  assert.equal(h.elements['signed-in'].hidden, false);
  assert.equal(h.elements['access-form'].hidden, true);
  assert.equal(h.elements['signed-email'].textContent, 'verified@example.com');
  assert.match(h.elements['access-status'].textContent, /Sign-out could not be confirmed/);
  assert.equal(h.calls.length, 2);
});

test('an expired flow offers a fresh app link and cannot return to an active form', async t => {
  const h = harness(t, {replies:[response(bootstrap()), response({error:'flow_expired'}, 401)]});
  await h.app.started;
  await h.send();
  assert.equal(h.elements['restart-panel'].hidden, false);
  assert.equal(h.elements.loading.hidden, true);
  assert.equal(h.elements['access-form'].hidden, true);
  await h.send();
  assert.equal(h.calls.length, 2);
});

test('a stalled request times out honestly, aborts and ignores its late result', async t => {
  const pending = deferred();
  const h = harness(t, {replies:[response(bootstrap()), () => pending.promise]});
  await h.app.started;
  const send = h.send();
  await h.advance(15000);
  await send;
  assert.equal(h.calls[1].init.signal.aborted, true);
  assert.match(h.elements['access-status'].textContent, /timed out/);
  assert.equal(h.elements['access-form'].hidden, false);
  pending.resolve(response(codeResponse(), 202));
  await flush();
  assert.equal(h.elements['code-form'].hidden, true);
  assert.match(h.elements['access-status'].textContent, /timed out/);
});

test('response bodies are bounded and timed out, including a stream that never closes', async t => {
  let streamCancelled = false;
  const stalled = new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { streamCancelled = true; }}), {headers:{'Content-Type':'application/json'}});
  const h = harness(t, {replies:[response(bootstrap()), stalled]});
  await h.app.started;
  const send = h.send();
  await flush();
  await h.advance(15000);
  await send;
  assert.equal(streamCancelled, true);
  assert.match(h.elements['access-status'].textContent, /timed out/);
  for (const bad of [
    response({data:'x'.repeat(9000)}),
    response(codeResponse(), 202, {'content-length':'9000'}),
    new Response('not json', {headers:{'content-type':'application/json'}}),
    new Response('<html>wrong service</html>', {headers:{'content-type':'text/html'}}),
    response(codeResponse({resendAfter:0}), 202),
  ]) {
    h.replies.push(bad);
    await h.send();
    assert.equal(h.elements['code-form'].hidden, true);
    assert.equal(h.elements['access-form'].hidden, false);
    assert.equal(h.elements['access-status'].dataset.error, 'true');
  }
});

test('untrusted app names and verified emails use text nodes, never HTML', async t => {
  const hostile = '<img src=x onerror=alert(1)>';
  const h = harness(t, {replies:[response(bootstrap({signedIn:true, appName:hostile, email:hostile}))]});
  await h.app.started;
  assert.equal(h.elements['signed-email'].textContent, hostile);
  assert.equal(h.elements.destination.textContent, 'Continue to ' + hostile + '.');
  assert.equal(h.elements['signed-in'].hidden, false);
});
