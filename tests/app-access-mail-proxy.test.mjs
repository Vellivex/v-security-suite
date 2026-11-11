import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailProxy, MAIL_SITE_ORIGIN, MAIL_INTERNAL_ORIGIN, MAIL_PUBLIC_ORIGIN } from '../server/app-access/mail-proxy.mjs';
import { guardMailBackend } from '../server/app-access/mail-backend-guard.mjs';

const id = '1'.repeat(32), cap = '2'.repeat(64);
const request = (path = '/api/mail/inbox', options = {}) => new Request(MAIL_SITE_ORIGIN + path, {
  method: 'POST', headers: { origin: MAIL_SITE_ORIGIN, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1',
    cookie: '__Host-vellivex_app_access=private-app-token', 'X-Vellivex-Scope': 'untrusted', 'X-Forwarded-Host': 'untrusted' },
  body: '{"turnstileToken":"verified"}', ...options
});

test('Mail creation validates app access and forwards only needed transport headers', async () => {
  let authorized = 0, incoming;
  const proxy = createMailProxy({ validate: async () => { authorized++; return { appAccess: true }; } });
  const response = await proxy(request(), { MAIL_API: { fetch: async req => { incoming = req; return Response.json({ ok: true }, { status: 201,
    headers: { 'Access-Control-Allow-Origin': MAIL_SITE_ORIGIN, 'Set-Cookie': 'bad=1' } }); } } });
  assert.equal(authorized, 1);
  assert.equal(response.status, 201);
  assert.equal(incoming.url, MAIL_INTERNAL_ORIGIN + '/api/inbox');
  assert.equal(await incoming.text(), '{"turnstileToken":"verified"}');
  assert.equal(incoming.headers.get('origin'), MAIL_SITE_ORIGIN);
  assert.equal(incoming.headers.get('cf-connecting-ip'), '192.0.2.1');
  for (const name of ['cookie', 'x-vellivex-scope', 'x-forwarded-host']) assert.equal(incoming.headers.has(name), false);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('unauthenticated creation and app-auth outages never call the backend', async () => {
  for (const validate of [async () => null, async () => { throw new Error('Unavailable'); }]) {
    let forwarded = false;
    const response = await createMailProxy({ validate })(request(), { MAIL_API: { fetch() { forwarded = true; } } });
    assert.ok([401, 503].includes(response.status));
    assert.equal(forwarded, false);
  }
});

test('apex and www each require their own exact Origin and preserve Turnstile hostname', async () => {
  const proxy = createMailProxy({ validate: async () => true });
  for (const origin of ['https://vellivex.com', 'https://www.vellivex.com']) {
    let backendRequest;
    const guarded = guardMailBackend({ fetch: async req => { backendRequest = req; return new Response(null, { status: 201 }); } });
    const env = { MAIL_API: { fetch: req => guarded.fetch(req, {}) } };
    const local = new Request(origin + '/api/mail/inbox', request());
    local.headers.set('origin', origin);
    assert.equal((await proxy(local, env)).status, 201);
    assert.equal(backendRequest.headers.get('origin'), origin);
    const cross = new Request(origin + '/api/mail/inbox', request());
    cross.headers.set('origin', origin === 'https://vellivex.com' ? 'https://www.vellivex.com' : 'https://vellivex.com');
    assert.equal((await proxy(cross, env)).status, 403);
  }
});

test('Mail rejects cross-origin creation, pilot authorization and malformed paths', async () => {
  const proxy = createMailProxy({ validate: async () => { throw new Error('Must not authenticate invalid routes'); } });
  const badOrigin = request(); badOrigin.headers.set('origin', 'https://evil.invalid');
  const crossSite = request(); crossSite.headers.set('sec-fetch-site', 'cross-site');
  const pilot = request(); pilot.headers.set('authorization', 'Bearer ' + cap);
  for (const req of [badOrigin, crossSite, pilot, request('/api/mail/inbox?x=1'), request('/api/mail/inbox/'),
    request('/api/mail/inbox/' + id), request('/api/mail/status'),
    new Request('https://other.vellivex.com/api/mail/inbox', { method: 'POST' })]) {
    assert.ok([403, 404].includes((await proxy(req, {})).status));
  }
  assert.equal(await proxy(new Request(MAIL_SITE_ORIGIN + '/unrelated'), {}), null);
});

test('existing bearer reads/deletes and status remain usable after app logout', async () => {
  const proxy = createMailProxy({ validate: async () => { throw new Error('Existing capability must not depend on app session'); } });
  for (const method of ['GET', 'DELETE']) {
    let incoming;
    const response = await proxy(new Request(MAIL_SITE_ORIGIN + '/api/mail/inbox/' + id, {
      method, headers: { authorization: 'Bearer ' + cap, origin: MAIL_SITE_ORIGIN }
    }), { MAIL_API: { fetch: async req => { incoming = req; return new Response(null, { status: method === 'DELETE' ? 204 : 200 }); } } });
    assert.equal(response.status, method === 'DELETE' ? 204 : 200);
    assert.equal(incoming.headers.get('authorization'), 'Bearer ' + cap);
    assert.equal(incoming.url, MAIL_INTERNAL_ORIGIN + '/api/inbox/' + id);
  }
  assert.equal((await proxy(new Request(MAIL_SITE_ORIGIN + '/api/mail/status'), {
    MAIL_API: { fetch: async () => Response.json({ publicSignupEnabled: true }) }
  })).status, 200);
});

test('transport failures and upstream redirects fail closed', async () => {
  const proxy = createMailProxy({ validate: async () => true });
  assert.equal((await proxy(request(), {})).status, 503);
  assert.equal((await proxy(request(), { MAIL_API: { fetch: async () => { throw new Error('Offline'); } } })).status, 503);
  assert.equal((await proxy(request(), { MAIL_API: { fetch: async () => Response.redirect('https://evil.invalid') } })).status, 503);
});

test('backend wrapper blocks all public creation including direct worker and pilot routes', async () => {
  let reached = 0;
  const wrapped = guardMailBackend({ fetch: async () => { reached++; return new Response('original'); } });
  for (const origin of [MAIL_PUBLIC_ORIGIN, 'https://vellivex-disposable-mail-pilot.vellivex-call.workers.dev', 'https://evil.invalid']) {
    for (const suffix of ['/api/inbox', '/api/inbox?bypass=1', '/api/%69nbox', '/api/inbox/']) {
      const response = await wrapped.fetch(new Request(origin + suffix, { method: 'POST', headers: {
        origin: MAIL_SITE_ORIGIN, authorization: 'Bearer ' + cap, 'X-Forwarded-Host': 'mail-access.internal'
      } }), {});
      assert.equal(response.status, 403);
    }
  }
  assert.equal(reached, 0);
});

test('backend private creation retains original Turnstile and quota checks', async () => {
  let incoming, environment, context;
  const env = {}, ctx = {};
  const wrapped = guardMailBackend({ fetch: async (req, e, c) => { incoming = req; environment = e; context = c; return new Response('backend'); } });
  const privateRequest = new Request(MAIL_INTERNAL_ORIGIN + '/api/inbox', request());
  const result = await wrapped.fetch(privateRequest, env, ctx);
  assert.equal(await result.text(), 'backend');
  assert.equal(incoming.url, MAIL_PUBLIC_ORIGIN + '/api/inbox');
  assert.equal(await incoming.text(), '{"turnstileToken":"verified"}');
  assert.equal(environment, env); assert.equal(context, ctx);
  assert.equal(incoming.headers.has('cookie'), false);
  for (const bad of [new Request(MAIL_INTERNAL_ORIGIN + '/api/inbox', { method: 'POST' }),
    new Request(MAIL_INTERNAL_ORIGIN + '/api/inbox', { method: 'POST', headers: { origin: MAIL_SITE_ORIGIN, authorization: 'Bearer ' + cap } }),
    new Request(MAIL_INTERNAL_ORIGIN + '/api/inbox?x=1', { method: 'POST', headers: { origin: MAIL_SITE_ORIGIN } })]) {
    assert.ok([403, 404].includes((await wrapped.fetch(bad, env)).status));
  }
});

test('backend read/delete and platform email/queue/scheduled handlers are preserved', async () => {
  const calls = [];
  const core = Object.fromEntries(['fetch', 'email', 'scheduled', 'queue'].map(name => [name, (...args) => {
    calls.push({ name, args }); return name === 'fetch' ? new Response('protected by original bearer checks') : name;
  }]));
  const wrapped = guardMailBackend(core), env = {}, ctx = {};
  for (const method of ['GET', 'DELETE']) {
    const req = new Request(MAIL_PUBLIC_ORIGIN + '/api/inbox/' + id, { method, headers: { authorization: 'Bearer ' + cap } });
    assert.equal((await wrapped.fetch(req, env, ctx)).status, 200);
    assert.equal(calls.at(-1).args[0], req);
  }
  for (const name of ['email', 'scheduled', 'queue']) {
    const event = {};
    assert.equal(await wrapped[name](event, env, ctx), name);
    assert.deepEqual(calls.at(-1), { name, args: [event, env, ctx] });
  }
});
