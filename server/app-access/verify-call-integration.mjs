// Run against an independently verified live module snapshot:
// node server/app-access/verify-call-integration.mjs /path/to/accounts/modules
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchCallBundle, sha256 } from './patch-call.mjs';
import { CALL_ORIGIN, APP_ACCESS_COOKIE } from './call-scope.mjs';

const baseline = process.argv[2];
if (!baseline) throw new Error('Supply the independently verified baseline modules directory.');
const temporary = await mkdtemp(join(tmpdir(), 'vellivex-call-access-'));
const candidate = join(temporary, 'modules');
const token = byte => Buffer.alloc(32, byte).toString('base64url');
const hash = text => createHash('sha256').update(text).digest('base64url');
const appToken = token(3), strongToken = token(4), ssoToken = token(5);
const user = token(1), strongUser = token(6);
const now = Date.now();
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

class D1Fixture {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    const bound = args => ({
      bind: (...values) => bound(values),
      first: async column => { const row = statement.get(...args); return column ? row?.[column] ?? null : row ?? null; },
      all: async () => ({ success: true, results: statement.all(...args) }),
      run: async () => { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
    });
    return bound([]);
  }
  async batch(statements) { return Promise.all(statements.map(statement => statement.all())); }
}

try {
  await cp(baseline, candidate, { recursive: true, errorOnExist: true });
  const before = await readFile(join(baseline, 'accounts-core.mjs'), 'utf8');
  const after = patchCallBundle(before);
  await writeFile(join(candidate, 'accounts-core.mjs'), after);
  await cp(new URL('.', import.meta.url), join(candidate, 'app-access'), { recursive: true });
  const sourceNames = (await readdir(new URL('.', import.meta.url))).filter(name => name.endsWith('.mjs') && !name.includes('test'));
  assert.ok(sourceNames.includes('core.mjs'), 'Core app-access implementation must exist before integration verification.');
  const [{ default: oldWorker }, { default: worker, VolatileCalls }] = await Promise.all([
    import(pathToFileURL(join(baseline, 'accounts-core.mjs'))),
    import(pathToFileURL(join(candidate, 'accounts-core.mjs')))
  ]);

  const db = new D1Fixture();
  db.db.exec(await readFile(new URL('schema.sql', import.meta.url), 'utf8'));
  db.db.exec(`CREATE TABLE vx_users(id TEXT PRIMARY KEY,email_index TEXT,email_cipher TEXT,method TEXT,epoch INTEGER,disabled INTEGER);
    CREATE TABLE vx_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,epoch INTEGER,expires_at INTEGER,verified_at INTEGER);`);
  db.db.prepare('INSERT INTO va_users(id,email_index,email_cipher,created_at,verified_at) VALUES(?,?,?,?,?)').run(user, token(7), 'unused-in-call-admission', now, now);
  db.db.prepare('INSERT INTO va_sso_sessions(token_hash,user_id,epoch,created_at,expires_at) VALUES(?,?,1,?,?)').run(hash(ssoToken), user, now, now + 3600000);
  db.db.prepare('INSERT INTO va_app_sessions(token_hash,sso_hash,user_id,epoch,audience,created_at,expires_at) VALUES(?,?,?,1,?,?,?)').run(hash(appToken), hash(ssoToken), user, CALL_ORIGIN, now, now + 3600000);
  db.db.prepare('INSERT INTO vx_users VALUES(?,?,?,?,1,0)').run(strongUser, token(8), 'unused-in-call-admission', 'email_totp');
  db.db.prepare('INSERT INTO vx_sessions VALUES(?,?,1,?,?)').run(hash(strongToken), strongUser, now + 3600000, now);
  let forwarded;
  const env = {
    ACCOUNTS_DB: db, VELLIVEX_ORIGIN: CALL_ORIGIN, VELLIVEX_RP_ID: 'vellivex.com',
    VELLIVEX_ACCOUNT_KEY: token(9), VELLIVEX_ACCOUNTS_ENABLED: 'true', VELLIVEX_VOLATILE_AUDIO_ENABLED: 'true',
    VOLATILE_CALLS: { idFromName: name => { equal(name, 'live-v1'); return name; }, get: () => ({ fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ scope: JSON.parse(request.headers.get('X-Vellivex-Scope')) }), { headers: { 'Content-Type': 'application/json' } });
    } }) }
  };
  const appCookie = `${APP_ACCESS_COOKIE}=${appToken}`;
  const strongCookie = `__Host-vellivex_session=${strongToken}`;
  const request = (path, cookie = appCookie, overrides = {}) => new Request(CALL_ORIGIN + path, {
    method: path === '/connect' || path === '/api/account' ? 'GET' : 'POST',
    headers: { cookie, origin: CALL_ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '192.0.2.1',
      'content-type': 'application/json', ...(path === '/connect' ? { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `vellivex-audio-v1, access.${token(10)}.${token(11)}` } : {}) },
    ...(path === '/connect' || path === '/api/account' ? {} : { body: '{"action":"allocate"}' }), ...overrides
  });
  const appScope = { id: user, epoch: 1, session: hash(appToken), appAccess: true };
  const strongScope = { id: strongUser, epoch: 1, session: hash(strongToken) };
  for (const path of ['/api/volatile', '/connect']) {
    const response = await worker.fetch(request(path, `${appCookie}; ${strongCookie}`), env);
    equal(response.status, 200);
    equal((await response.json()).scope, appScope);
    equal(new URL(forwarded.url).pathname, path === '/connect' ? '/connect' : '/operation');
  }
  db.db.prepare('UPDATE vx_sessions SET expires_at=?').run(now - 1);
  equal((await worker.fetch(request('/api/volatile', `${appCookie}; ${strongCookie}`), env)).status, 200, 'Stale strong cookie must not break app session.');
  db.db.prepare('UPDATE vx_sessions SET expires_at=?').run(now + 3600000);
  equal((await (await worker.fetch(request('/api/volatile', `${APP_ACCESS_COOKIE}=${token(12)}; ${strongCookie}`), env)).json()).scope, strongScope);
  equal((await worker.fetch(request('/api/volatile', `${APP_ACCESS_COOKIE}=${token(12)}; __Host-vellivex_session=${token(13)}`), env)).status, 401);
  const spoofed = request('/api/volatile', '');
  spoofed.headers.set('X-Vellivex-Scope', JSON.stringify(appScope));
  equal((await worker.fetch(spoofed, env)).status, 401, 'External scope headers never replace cookie authentication.');
  for (const path of ['/api/account', '/api/payphone/quote', '/api/payphone/call', '/api/payments/bitcoin', '/api/auth/logout']) {
    const [oldResult, freshResult] = await Promise.all([oldWorker.fetch(request(path), env), worker.fetch(request(path), env)]);
    equal(freshResult.status, 401, `${path} must require strong account auth.`);
    equal(await freshResult.text(), await oldResult.text());
  }
  for (const path of ['/', '/call.html', '/call.js', '/app.js', '/voice-worklet.js', '/voice-dsp.js', '/opus-capture-worklet.js', '/api/audio/status', '/api/status']) {
    const [oldResult, freshResult] = await Promise.all([oldWorker.fetch(new Request(CALL_ORIGIN + path), env), worker.fetch(new Request(CALL_ORIGIN + path), env)]);
    equal(freshResult.status, oldResult.status);
    equal([...freshResult.headers], [...oldResult.headers]);
    equal(await freshResult.text(), await oldResult.text(), `${path} bytes must remain intact.`);
  }

  const timers = { now: () => now, timeout: () => 1, cancelTimeout() {}, interval: () => 1, cancelInterval() {} };
  const actor = new VolatileCalls({}, env, timers);
  const operation = (scope, body) => actor.fetch(new Request('https://volatile.invalid/operation', { method: 'POST',
    headers: { 'X-Vellivex-Scope': JSON.stringify(scope), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  equal(await actor.validScope(appScope), true);
  equal(await actor.validScope(strongScope), true);
  const receiverToken = token(14), receiverUser = token(15), receiverSSO = token(16);
  db.db.prepare('INSERT INTO va_users(id,email_index,email_cipher,created_at,verified_at) VALUES(?,?,?,?,?)').run(receiverUser, token(17), 'unused', now, now);
  db.db.prepare('INSERT INTO va_sso_sessions(token_hash,user_id,epoch,created_at,expires_at) VALUES(?,?,1,?,?)').run(hash(receiverSSO), receiverUser, now, now + 3600000);
  db.db.prepare('INSERT INTO va_app_sessions(token_hash,sso_hash,user_id,epoch,audience,created_at,expires_at) VALUES(?,?,?,1,?,?,?)').run(hash(receiverToken), hash(receiverSSO), receiverUser, CALL_ORIGIN, now, now + 3600000);
  const receiverScope = { id: receiverUser, session: hash(receiverToken), epoch: 1, appAccess: true };
  const allocation = await operation(appScope, { action: 'allocate' });
  equal(allocation.status, 200);
  const room = await allocation.json();
  equal((await operation(appScope, { action: 'read', id: room.id, cap: room.cap })).status, 200);
  const joinToken = token(18);
  const joinHash = createHash('sha256').update('vellivex-audio-room-join-v1\n' + joinToken).digest('hex');
  const cipher = 'VSE1.' + 'A'.repeat(40);
  equal((await operation(appScope, { action: 'create', id: room.id, cap: room.cap, cipher, joinHash })).status, 200);
  const joined = await operation(receiverScope, { action: 'join', id: room.id, joinToken });
  equal(joined.status, 200);
  const receiver = await joined.json();
  equal((await operation(receiverScope, { action: 'answer', id: room.id, cap: receiver.cap, cipher })).status, 200);
  equal((await operation(appScope, { action: 'ticket', id: room.id, cap: room.cap })).status, 200);
  equal((await operation(receiverScope, { action: 'ticket', id: room.id, cap: receiver.cap })).status, 200);
  equal((await operation(appScope, { action: 'ticket', id: room.id, cap: room.cap })).status, 404, 'Existing one-use ticket rule is preserved.');
  equal((await operation({ ...appScope, appAccess: false }, { action: 'read', id: room.id, cap: room.cap })).status, 401);
  equal((await operation({ ...appScope, admin: true }, { action: 'read', id: room.id, cap: room.cap })).status, 401);
  equal(await actor.validScope({ ...strongScope, appAccess: true }), false, 'Legacy identity must not work in app tables.');
  const { appAccess: ignored, ...erasedScope } = appScope;
  equal(await actor.validScope(erasedScope), false, 'App identity must not work in legacy tables.');
  // Deliberately create the otherwise improbable same-id/session collision in
  // both databases: marker removal must still not confer room membership.
  db.db.prepare('INSERT INTO vx_users VALUES(?,?,?,?,1,0)').run(user, token(19), 'unused', 'email_totp');
  db.db.prepare('INSERT INTO vx_sessions VALUES(?,?,1,?,?)').run(hash(appToken), user, now + 3600000, now);
  equal(await actor.validScope(erasedScope), true);
  equal((await operation(erasedScope, { action: 'read', id: room.id, cap: room.cap })).status, 404);
  const collisionAllocation = await operation(erasedScope, { action: 'allocate' });
  equal(collisionAllocation.status, 200);
  db.db.prepare('UPDATE vx_users SET disabled=1 WHERE id=?').run(user);
  await actor.checkSessions();
  equal(actor.rooms.size, 1, 'Watchdog family keys must revoke only the invalid family on collision.');
  equal(actor.rooms.has(room.id), true);
  db.db.prepare('UPDATE va_users SET epoch=2 WHERE id=?').run(user);
  equal((await operation(appScope, { action: 'read', id: room.id, cap: room.cap })).status, 401);
  await actor.checkSessions();
  equal(actor.rooms.size, 0, 'App epoch revocation must close active rooms.');
  db.db.prepare('UPDATE va_users SET epoch=1 WHERE id=?').run(user);
  const strongAllocation = await operation(strongScope, { action: 'allocate' });
  equal(strongAllocation.status, 200);
  db.db.prepare('UPDATE vx_users SET disabled=1 WHERE id=?').run(strongUser);
  await actor.checkSessions();
  equal(actor.rooms.size, 0, 'Legacy revocation must still close active rooms.');
  equal(await actor.validScope(appScope), true);
  db.db.prepare('UPDATE va_app_sessions SET audience=?').run('https://notes.vellivex.com');
  equal(await actor.validScope(appScope), false, 'Another app audience cannot authorize calls.');
  db.db.prepare('UPDATE va_app_sessions SET audience=?').run(CALL_ORIGIN);
  db.db.prepare('DELETE FROM va_sso_sessions WHERE token_hash=?').run(hash(ssoToken));
  equal(await actor.validScope(appScope), false, 'Parent SSO logout must revoke derived call sessions.');
  db.db.close();
  console.log(JSON.stringify({ checks, baselineSha256: sha256(before), candidateSha256: sha256(after), result: 'pass' }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
