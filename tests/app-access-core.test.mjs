import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createAppAccess, appCallScope, validateAppCallScope } from '../server/app-access/core.mjs';
import { createVerificationMailer } from '../server/app-access/mail.mjs';
import { createAppAccessGate } from '../server/app-access/gate.mjs';

const CENTRAL = 'https://call.vellivex.com';
const INTERNAL = 'https://app-access.internal';
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
class D1 {
  constructor() { this.sql = new DatabaseSync(':memory:'); this.sql.exec(readFileSync(new URL('../server/app-access/schema.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const db = this;
    return { sql, args: [], bind(...args) { return { ...this, args }; },
      async first() { return db.sql.prepare(this.sql).get(...this.args) ?? null; },
      async all() { return { results: db.sql.prepare(this.sql).all(...this.args) }; },
      async run() { return { meta: db.sql.prepare(this.sql).run(...this.args) }; }
    };
  }
  async batch(statements) {
    this.sql.exec('BEGIN');
    try { const result = statements.map(s => ({ results: this.sql.prepare(s.sql).all(...s.args) })); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  count(table) { return this.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }
}
function fixture(options = {}) {
  const db = new D1(), messages = [], clock = { now: Date.now() };
  const env = { ACCOUNTS_DB: db, VELLIVEX_ACCOUNT_KEY: token(), VELLIVEX_RESEND_KEY: 're_fixture' };
  const app = createAppAccess({ now: () => clock.now, sendMail: async value => { messages.push(value); if (options.failMail) throw Error('provider private failure'); }, ...options });
  const jar = new Map();
  const call = async (path, body, extra = {}) => {
    const internal = path.startsWith('/__app_access/'), headers = { 'CF-Connecting-IP': '192.0.2.20', ...extra.headers };
    if (!internal) { headers.Origin ??= CENTRAL; headers['Sec-Fetch-Site'] ??= 'same-origin'; headers.Cookie ??= [...jar].map(([k,v]) => `${k}=${v}`).join('; '); }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.fetch(new Request((internal ? INTERNAL : CENTRAL) + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    if (!internal && extra.updateCookies !== false) for (const value of response.headers.getSetCookie()) {
      const [name, content] = value.split(';')[0].split('='); if (content) jar.set(name, content); else jar.delete(name);
    }
    return { status: response.status, value: await response.json(), response };
  };
  const flow = async (audience = 'https://www.vellivex.com', returnPath = '/apps/vault') => {
    const state = token(), verifier = token();
    const prepare = await call('/__app_access/prepare', { audience, returnPath, state, verifierHash: await hash(verifier) });
    assert.equal(prepare.status, 200, JSON.stringify(prepare.value));
    const boot = await call('/api/app-access/bootstrap?flow=' + prepare.value.flowId);
    assert.equal(boot.status, 200, JSON.stringify(boot.value));
    return { audience, returnPath, state, verifier, ...boot.value };
  };
  const request = async (f, email = 'reader@example.test', marketingOptIn = false) => call('/api/app-access/request-code', { flowId: f.flowId, csrf: f.csrf, email, marketingOptIn });
  const verify = async (f, challengeId, code) => call('/api/app-access/verify-code', { flowId: f.flowId, csrf: f.csrf, challengeId, code });
  const redeem = async (f, redirectTo, overrides = {}) => call('/__app_access/redeem', { code: new URL(redirectTo).searchParams.get('code'), state: f.state, audience: f.audience, verifier: f.verifier, ...overrides });
  const register = async (audience, returnPath, email, optIn = false) => {
    const f = await flow(audience, returnPath), sent = await request(f, email, optIn);
    assert.equal(sent.status, 202, JSON.stringify(sent.value));
    const verified = await verify(f, sent.value.challengeId, messages.at(-1).code);
    assert.equal(verified.status, 200, JSON.stringify(verified.value));
    const redeemed = await redeem(f, verified.value.redirectTo);
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.value));
    return { f, sent, verified, redeemed };
  };
  return { db, env, app, clock, messages, jar, call, flow, request, verify, redeem, register };
}

test('verified email creates isolated identity and child session; email and code remain encrypted/MACed at rest', async () => {
  const t = fixture(), r = await t.register();
  const checked = await t.call('/__app_access/validate', { audience: r.f.audience, sessionToken: r.redeemed.value.sessionToken });
  assert.equal(checked.status, 200); assert.equal(checked.value.scope.appAccess, true);
  assert.equal(checked.value.expiresAt, t.clock.now + 30 * 86400000);
  assert.equal(t.db.count('va_users'), 1); assert.equal(t.db.count('va_sso_sessions'), 1);
  const user = t.db.sql.prepare('SELECT * FROM va_users').get(), challenge = t.db.sql.prepare('SELECT * FROM va_email_challenges').get();
  assert.equal(user.updates_opt_in, 0); assert.equal(user.updates_consent_at, null);
  assert(!user.email_cipher.includes('reader')); assert(!user.email_index.includes('@'));
  assert.match(challenge.code_mac, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(challenge.code_mac, t.messages[0].code);
  assert.match(t.messages[0].code, /^\d{8}$/);
  assert(!t.db.sql.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'vx_%'").get());
});

test('real edge gate and central core complete an audience-bound handoff while restoring invitation fragments only locally', async () => {
  const t = fixture(), brokerBodies = [], local = new Map(), origin = 'https://www.vellivex.com', path = '/apps/vault', fragment = '#private-local-invitation-key';
  const gate = createAppAccessGate({ now: () => t.clock.now, broker: async request => {
    brokerBodies.push(await request.clone().json()); return t.app.fetch(request, t.env);
  } });
  const jar = new Map();
  const edge = async (url, headers = {}) => {
    const clean = new URL(url, origin); clean.hash = '';
    const response = await gate.handle(new Request(clean, { headers: { 'CF-Connecting-IP': '192.0.2.20', Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), ...headers } }), {});
    if (response) for (const value of response.headers.getSetCookie()) {
      const [key, content] = value.split(';')[0].split('='); if (content) jar.set(key, content); else jar.delete(key);
    }
    return response;
  };
  const renderScript = async response => {
    const html = await response.text(), matches = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
    assert.equal(matches.length, 1); return matches[0][1];
  };
  let next, redacted;
  const sessionStorage = { setItem: (key,value) => local.set(key,value), getItem: key => local.get(key) ?? null, removeItem: key => local.delete(key) };
  const bootstrap = await edge(origin + path); assert.equal(bootstrap.status, 200);
  runInNewContext(await renderScript(bootstrap), { sessionStorage, location: { hash: fragment, replace: value => { next = value; } }, history: { replaceState: (_state,_title,value) => { redacted = value; } }, document: { getElementById: () => ({ textContent: '' }) } });
  assert.equal(redacted, path + '#_'); assert(!next.includes(fragment));
  const start = await edge(next, { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }); assert.equal(start.status, 303);
  const authorization = new URL(start.headers.get('Location')); assert.equal(authorization.origin, CENTRAL); assert.equal(authorization.hash, '#_');
  const boot = await t.call('/api/app-access/bootstrap?flow=' + authorization.searchParams.get('flow'));
  const sent = await t.request(boot.value); assert.equal(sent.status, 202);
  const verified = await t.verify(boot.value, sent.value.challengeId, t.messages.at(-1).code); assert.equal(verified.status, 200);
  const finish = await edge(verified.value.redirectTo, { 'Sec-Fetch-Site': 'same-site' }); assert.equal(finish.status, 303);
  assert(jar.has('__Host-vellivex_app_access')); assert(![...jar.keys()].some(key => key.startsWith('__Host-vellivex_flow_')));
  assert.equal(await edge(origin + path), null);
  assert.notEqual(await edge('https://vkey.vellivex.com/'), null);
  const back = await edge(finish.headers.get('Location')); assert.equal(back.status, 200);
  runInNewContext(await renderScript(back), { sessionStorage, location: { replace: value => { next = value; } }, document: { getElementById: () => ({ textContent: '' }) } });
  assert.equal(next, path + fragment); assert.equal(local.size, 0);
  assert(!JSON.stringify(brokerBodies).includes(fragment));
  assert(!JSON.stringify(brokerBodies).includes('reader@example.test'));
  assert.equal((await edge(verified.value.redirectTo)).status, 401);
});

test('shared SSO admits a second audience without another email and logout revokes every child in that group', async () => {
  const t = fixture(), first = await t.register(), second = await t.flow('https://vkey.vellivex.com', '/');
  assert.equal(second.signedIn, true); assert.equal(second.email, 'reader@example.test');
  const next = await t.call('/api/app-access/continue', { flowId: second.flowId, csrf: second.csrf });
  assert.equal(next.status, 200); const other = await t.redeem(second, next.value.redirectTo); assert.equal(other.status, 200);
  assert.equal(t.messages.length, 1); assert.equal(t.db.count('va_app_sessions'), 2);
  const logoutFlow = await t.flow();
  assert.equal((await t.call('/api/app-access/logout', { flowId: logoutFlow.flowId, csrf: logoutFlow.csrf })).status, 200);
  for (const [audience, sessionToken] of [[first.f.audience, first.redeemed.value.sessionToken], [second.audience, other.value.sessionToken]]) {
    assert.equal((await t.call('/__app_access/validate', { audience, sessionToken })).status, 401);
  }
  assert.equal(t.db.count('va_sso_sessions'), 0); assert.equal(t.db.count('va_app_sessions'), 0);
});

test('concurrent code verification and callback redemption each succeed once', async () => {
  const t = fixture(), f = await t.flow(), sent = await t.request(f), code = t.messages[0].code;
  const verified = await Promise.all([t.verify(f, sent.value.challengeId, code), t.verify(f, sent.value.challengeId, code)]);
  assert.deepEqual(verified.map(x => x.status).sort(), [200, 401]);
  assert.equal(t.db.count('va_users'), 1); assert.equal(t.db.count('va_sso_sessions'), 1); assert.equal(t.db.count('va_handoffs'), 1);
  const redirect = verified.find(x => x.status === 200).value.redirectTo;
  const redeemed = await Promise.all([t.redeem(f, redirect), t.redeem(f, redirect)]);
  assert.deepEqual(redeemed.map(x => x.status).sort(), [200, 401]); assert.equal(t.db.count('va_app_sessions'), 1);
});

test('direct access management can sign out after app flow is consumed and cannot authorize apps', async () => {
  const t = fixture(), r = await t.register();
  const boot = await t.call('/api/app-access/bootstrap');
  assert.equal(boot.status, 200); assert.equal(boot.value.management, true);
  assert.equal(boot.value.signedIn, true); assert.equal(boot.value.email, 'reader@example.test');
  assert.match(boot.value.flowId, /^[A-Za-z0-9_-]{43}$/);
  const body = { flowId: boot.value.flowId, csrf: boot.value.csrf };
  assert.equal((await t.request(boot.value)).status, 401);
  assert.equal((await t.call('/api/app-access/continue', body)).status, 401);
  assert.equal((await t.verify(boot.value, token(), '12345678')).status, 401);
  const originalCookies = [...t.jar].map(([k,v]) => `${k}=${v}`).join('; ');
  assert.equal((await t.call('/api/app-access/logout', body)).status, 200);
  assert.equal((await t.call('/__app_access/validate', { audience: r.f.audience, sessionToken: r.redeemed.value.sessionToken })).status, 401);
  assert.equal(t.db.count('va_sso_sessions'), 0); assert.equal(t.db.count('va_logout_flows'), 0);
  assert.equal((await t.call('/api/app-access/logout', body, { headers: { Cookie: originalCookies } })).status, 401);
  const out = await t.call('/api/app-access/bootstrap'); assert.equal(out.value.signedIn, false); assert.equal(out.value.email, undefined);
});

test('management logout is bound to browser, exact SSO, expiry and same-origin bootstrap', async () => {
  const t = fixture(); await t.register();
  const boot = await t.call('/api/app-access/bootstrap'), body = { flowId: boot.value.flowId, csrf: boot.value.csrf };
  const sso = t.jar.get('__Host-vellivex_apps_sso');
  assert.equal((await t.call('/api/app-access/bootstrap', undefined, { headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' } })).status, 401);
  assert.equal((await t.call('/api/app-access/logout', body, { headers: { Cookie: `__Host-vellivex_apps_sso=${sso}; __Host-vellivex_apps_browser=${token()}` } })).status, 401);
  assert.equal((await t.call('/api/app-access/logout', body, { headers: { Cookie: `__Host-vellivex_apps_sso=${token()}; __Host-vellivex_apps_browser=${t.jar.get('__Host-vellivex_apps_browser')}` } })).status, 401);
  t.clock.now += 600001;
  assert.equal((await t.call('/api/app-access/logout', body)).status, 401);
  assert.equal(t.db.count('va_sso_sessions'), 1);
  assert.equal((await t.call('/api/app-access/bootstrap')).status, 200);
  assert.equal(t.db.count('va_logout_flows'), 1);
});

test('five wrong attempts consume the challenge allowance, including concurrent attempts', async () => {
  const t = fixture(), f = await t.flow(), sent = await t.request(f), right = t.messages[0].code;
  const wrong = right === '00000000' ? '00000001' : '00000000';
  const responses = await Promise.all(Array.from({ length: 7 }, () => t.verify(f, sent.value.challengeId, wrong)));
  assert(responses.every(x => x.status === 401));
  assert.equal(t.db.sql.prepare('SELECT attempts FROM va_email_challenges').get().attempts, 5);
  assert.equal((await t.verify(f, sent.value.challengeId, right)).status, 401); assert.equal(t.db.count('va_users'), 0);
});

test('resend has a true sixty-second cooldown and supersedes the older code', async () => {
  const t = fixture(), f = await t.flow(), first = await t.request(f), code = t.messages[0].code;
  t.clock.now += 59999; assert.equal((await t.request(f)).status, 429);
  t.clock.now += 1; const next = await t.request(f); assert.equal(next.status, 202);
  assert.equal((await t.verify(f, first.value.challengeId, code)).status, 401);
  assert.equal((await t.verify(f, next.value.challengeId, t.messages[1].code)).status, 200);
});

test('expiry, cross-browser binding and wrong CSRF all fail without creating an account', async () => {
  const t = fixture(), f = await t.flow(), sent = await t.request(f), code = t.messages[0].code;
  const fields = { flowId: f.flowId, csrf: f.csrf, challengeId: sent.value.challengeId, code };
  assert.equal((await t.call('/api/app-access/verify-code', fields, { headers: { Cookie: '' } })).status, 401);
  assert.equal((await t.call('/api/app-access/verify-code', { ...fields, csrf: token() })).status, 401);
  assert.equal((await t.call('/api/app-access/verify-code', fields, { headers: { Origin: 'https://vkey.vellivex.com' } })).status, 400);
  t.clock.now += 600001; assert.equal((await t.verify(f, sent.value.challengeId, code)).status, 401);
  assert.equal(t.db.count('va_users'), 0);
});

test('handoff is bound to exact audience, state and verifier and has a sixty-second deadline', async () => {
  const t = fixture(), f = await t.flow(), sent = await t.request(f), verified = await t.verify(f, sent.value.challengeId, t.messages[0].code);
  for (const overrides of [{ audience: 'https://vkey.vellivex.com' }, { state: token() }, { verifier: token() }]) {
    assert.equal((await t.redeem(f, verified.value.redirectTo, overrides)).status, 401);
  }
  t.clock.now += 60001; assert.equal((await t.redeem(f, verified.value.redirectTo)).status, 401); assert.equal(t.db.count('va_app_sessions'), 0);
});

test('failed or ambiguous mail delivery cannot activate a challenge and never exposes provider errors', async () => {
  const t = fixture({ failMail: true }), f = await t.flow(), sent = await t.request(f);
  assert.equal(sent.status, 503); assert.equal(sent.value.error, 'email_unavailable');
  assert(!JSON.stringify(sent.value).includes('provider private'));
  const row = t.db.sql.prepare('SELECT * FROM va_email_challenges').get(); assert.equal(row.used, 1); assert.equal(row.delivery, 'failed');
  assert.equal(t.db.count('va_users'), 0);
});

test('persisted free sender budgets stop actual sends and cannot be increased through configuration', async () => {
  const t = fixture({ budgets: { daily: 1, monthly: 1 } }), f = await t.flow();
  assert.equal((await t.request(f)).status, 202);
  const second = await t.flow(); const denied = await t.request(second, 'another@example.test');
  assert.equal(denied.status, 429); assert.equal(denied.value.error, 'mail_limit'); assert.equal(t.messages.length, 1);
  assert.throws(() => createAppAccess({ budgets: { daily: 91, monthly: 2800 } }));
});

test('user epoch, disabled state and parent removal invalidate app admission and free Call scope', async () => {
  const t = fixture(), r = await t.register(CENTRAL, '/call.html');
  const request = new Request(CENTRAL + '/api/volatile', { headers: { Cookie: '__Host-vellivex_app_access=' + r.redeemed.value.sessionToken } });
  const scope = await appCallScope(request, t.env);
  assert.equal(await validateAppCallScope(t.env, scope, t.clock.now), true);
  assert.equal(await validateAppCallScope(t.env, { ...scope, appAccess: false }, t.clock.now), false);
  t.db.sql.exec('UPDATE va_users SET epoch=epoch+1'); assert.equal(await validateAppCallScope(t.env, scope, t.clock.now), false);
  t.db.sql.exec('UPDATE va_users SET epoch=epoch-1,disabled=1'); assert.equal(await validateAppCallScope(t.env, scope, t.clock.now), false);
  t.db.sql.exec('UPDATE va_users SET disabled=0; DELETE FROM va_sso_sessions'); assert.equal(await validateAppCallScope(t.env, scope, t.clock.now), false);
});

test('optional updates consent is recorded only after verification and declined access still succeeds', async () => {
  const t = fixture(), f = await t.flow(), sent = await t.request(f, 'reader@example.test', true);
  assert.equal(t.db.count('va_users'), 0);
  assert.equal((await t.verify(f, sent.value.challengeId, t.messages[0].code)).status, 200);
  const row = t.db.sql.prepare('SELECT updates_opt_in,updates_consent_at,updates_consent_version FROM va_users').get();
  assert.equal(row.updates_opt_in, 1); assert.equal(row.updates_consent_at, t.clock.now); assert.equal(row.updates_consent_version, 'va-updates-v1');
});

test('unknown hosts, public broker routes, foreign origins, extra keys and unsafe return paths fail closed', async () => {
  const t = fixture();
  const r = await t.app.fetch(new Request('https://attacker.example/access'), t.env); assert.equal(r.status, 400);
  const broker = await t.app.fetch(new Request(CENTRAL + '/__app_access/validate', { method: 'POST' }), t.env); assert.equal(broker.status, 404);
  const bad = await t.call('/__app_access/prepare', { audience: 'https://www.vellivex.com', returnPath: '//attacker.example', state: token(), verifierHash: token() }); assert.equal(bad.status, 400);
  const extra = await t.call('/__app_access/prepare', { audience: CENTRAL, returnPath: '/call.html', state: token(), verifierHash: token(), email: 'reader@example.test' }); assert.equal(extra.status, 400);
  const f = await t.flow();
  const cross = await t.call('/api/app-access/bootstrap?flow=' + f.flowId, undefined, { headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(cross.status, 401);
});

test('prepare limits are persisted and expired rows are cleaned without removing user identities', async () => {
  const t = fixture();
  for (let i = 0; i < 20; i++) assert.equal((await t.call('/__app_access/prepare', { audience: CENTRAL, returnPath: '/call.html', state: token(), verifierHash: token() })).status, 200);
  assert.equal((await t.call('/__app_access/prepare', { audience: CENTRAL, returnPath: '/call.html', state: token(), verifierHash: token() })).status, 429);
  t.clock.now += 11 * 60000;
  assert.equal((await t.call('/__app_access/prepare', { audience: CENTRAL, returnPath: '/call.html', state: token(), verifierHash: token() })).status, 200);
  assert.equal(t.db.count('va_flows'), 1);
});

test('mail transport requires a bounded successful receipt and rejects redirects, errors and stalled streams', async () => {
  const details = { email: 'reader@example.test', code: '12345678', id: token() };
  for (const response of [new Response('{}', { status: 302 }), new Response('{}', { status: 500 }), new Response('x'.repeat(2049), { headers: { 'Content-Type': 'application/json' } }), new Response('{}', { headers: { 'Content-Type': 'application/json' } })]) {
    const mail = createVerificationMailer('re_fixture', { transport: async () => response }); await assert.rejects(mail(details));
  }
  const stalled = createVerificationMailer('re_fixture', { timeoutMs: 20, transport: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(stalled(details));
  let calls = 0;
  const valid = createVerificationMailer('re_fixture', { transport: async (url, request) => { calls++; assert.equal(url, 'https://api.resend.com/emails'); assert.equal(request.redirect, 'manual'); assert.match(request.headers['Idempotency-Key'], /^va-signin-/); return Response.json({ id: 'fixture-receipt' }); } });
  await valid(details); assert.equal(calls, 1);
});
