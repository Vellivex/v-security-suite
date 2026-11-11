import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ACCESS_COOKIE, CALL_ORIGIN, normalizeCallScope, readCallScope,
  sameCallScope, callScopeKey, resolveFreeCallScope } from '../server/app-access/call-scope.mjs';

const token = byte => Buffer.alloc(32, byte).toString('base64url');
const legacy = { id: token(1), session: token(2), epoch: 1 };
const app = { ...legacy, appAccess: true };
const env = { VELLIVEX_ORIGIN: CALL_ORIGIN };
const authError = () => Object.assign(new Error('Denied'), { status: 401 });
const no = async () => { throw authError(); };
const req = (path = '/api/volatile', options = {}) => new Request(CALL_ORIGIN + path, {
  method: path === '/connect' ? 'GET' : 'POST',
  headers: { cookie: `${APP_ACCESS_COOKIE}=${token(3)}; __Host-vellivex_session=${token(4)}` }, ...options
});

test('valid app cookie wins on exactly the two free call routes', async () => {
  for (const path of ['/api/volatile', '/connect']) {
    let strongChecked = false;
    const scope = await resolveFreeCallScope(req(path), env, async () => { strongChecked = true; return legacy; }, async () => app);
    assert.deepEqual(scope, app);
    assert.equal(strongChecked, false);
    assert.notEqual(scope, app);
  }
});

test('expired strong cookie does not break valid app login', async () => {
  assert.deepEqual(await resolveFreeCallScope(req(), env, no, async () => app), app);
});

test('valid strong session retains free calling when app cookie is invalid', async () => {
  assert.deepEqual(await resolveFreeCallScope(req(), env, async () => legacy, no), legacy);
  for (const cookie of ['', `${APP_ACCESS_COOKIE}=bad`, `${APP_ACCESS_COOKIE}=${token(3)}; ${APP_ACCESS_COOKIE}=${token(3)}`]) {
    let appChecked = false;
    assert.deepEqual(await resolveFreeCallScope(req('/api/volatile', { headers: { cookie } }), env,
      async () => legacy, async () => { appChecked = true; return app; }), legacy);
    assert.equal(appChecked, false);
  }
});

test('both invalid sessions deny, including malformed or absent cookies', async () => {
  for (const cookie of [req().headers.get('cookie'), '', `${APP_ACCESS_COOKIE}=bad`]) {
    await assert.rejects(resolveFreeCallScope(req('/api/volatile', { headers: { cookie } }), env, no, no), { status: 401 });
  }
});

test('no email-only admission on account, payment, recovery, owner or sibling paths', async () => {
  for (const path of ['/api/account', '/api/payphone/quote', '/api/payphone/call', '/api/payments/bitcoin',
    '/api/auth/recover', '/api/auth/logout', '/api/owner', '/api/volatile/', '/api/volatile?x=1', '/connect?x=1']) {
    let calls = 0;
    await assert.rejects(resolveFreeCallScope(req(path), env, async () => { calls++; return legacy; }, async () => { calls++; return app; }), { status: 401 });
    assert.equal(calls, 0);
  }
  for (const request of [req('/api/volatile', { method: 'GET' }), req('/connect', { method: 'POST' }),
    new Request('https://other.vellivex.com/api/volatile', { method: 'POST' })]) {
    await assert.rejects(resolveFreeCallScope(request, env, async () => legacy, async () => app), { status: 401 });
  }
  await assert.rejects(resolveFreeCallScope(req(), { VELLIVEX_ORIGIN: 'https://other.vellivex.com' }, async () => legacy, async () => app), { status: 401 });
});

test('scope family cannot be erased, forged or escalated by a callback', async () => {
  await assert.rejects(resolveFreeCallScope(req(), env, no, async () => legacy), { status: 401 });
  await assert.rejects(resolveFreeCallScope(req(), env, async () => app, no), { status: 401 });
  for (const malformed of [null, [], {}, { ...app, appAccess: false }, { ...app, appAccess: 1 },
    { ...app, admin: true }, { ...app, id: 'A'.repeat(42) + 'B' }, { ...app, session: 'A'.repeat(44) },
    { ...app, epoch: 0 }, { ...app, epoch: 1.5 }, { ...app, epoch: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => normalizeCallScope(malformed), { status: 401 });
  }
});

test('actor scope parser is bounded and preserves the explicit family', () => {
  for (const scope of [app, legacy]) {
    assert.deepEqual(readCallScope(new Request('https://volatile.invalid/operation', { headers: { 'X-Vellivex-Scope': JSON.stringify(scope) } })), scope);
  }
  for (const header of ['', '{', ' '.repeat(513), JSON.stringify({ ...app, owner: true })]) {
    assert.throws(() => readCallScope(new Request('https://volatile.invalid/operation', { headers: { 'X-Vellivex-Scope': header } })), { status: 401 });
  }
  const bundledError = Object.assign(new Error('Bundled auth'), { status: 401 });
  assert.throws(() => readCallScope(new Request('https://volatile.invalid/operation'), () => bundledError), error => error === bundledError);
});

test('session identity and ongoing revocation keys isolate va and vx stores', () => {
  assert.equal(sameCallScope(legacy, app), false);
  assert.equal(sameCallScope(app, { ...app }), true);
  assert.equal(sameCallScope(legacy, { ...legacy }), true);
  assert.equal(sameCallScope(app, { ...app, epoch: 2 }), false);
  assert.equal(sameCallScope(undefined, undefined), false);
  assert.notEqual(callScopeKey(app), callScopeKey(legacy));
});

test('infrastructure failure stays a failure unless the other family is valid', async () => {
  const outage = new Error('Database unavailable');
  const unavailable = async () => { throw outage; };
  await assert.rejects(resolveFreeCallScope(req(), env, no, unavailable), error => error === outage);
  await assert.rejects(resolveFreeCallScope(req(), env, unavailable, no), error => error === outage);
  assert.deepEqual(await resolveFreeCallScope(req(), env, async () => legacy, unavailable), legacy);
});
