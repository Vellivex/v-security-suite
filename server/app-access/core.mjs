import { CENTRAL_ORIGIN, allowedAudience, validReturnPath } from './registry.mjs';
import { renderAccessPage, accessUiAsset } from './ui.mjs';
import { createVerificationMailer } from './mail.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const FLOW_MS = 10 * MINUTE, SESSION_MS = 30 * DAY, HANDOFF_MS = MINUTE;
const CLEANUP_MS = 10 * MINUTE;
const INTERNAL_ORIGIN = 'https://app-access.internal';
const SSO_COOKIE = '__Host-vellivex_apps_sso';
const BROWSER_COOKIE = '__Host-vellivex_apps_browser';
const APP_COOKIE = '__Host-vellivex_app_access';
const encoder = new TextEncoder();
const SECURITY = {
  'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Strict-Transport-Security': 'max-age=31536000'
};
const messages = {
  invalid_request: 'The request could not be completed.',
  verification_failed: 'The code or sign-in request could not be verified. Request a new code and try again.',
  flow_expired: 'This sign-in link has expired. Open the app again to continue.',
  rate_limited: 'Too many requests. Please wait before trying again.',
  mail_limit: 'Verification emails have reached the free sending limit. Please try again later.',
  email_unavailable: 'The verification email could not be sent. Please try again later.',
  unavailable: 'Vellivex sign-in is temporarily unavailable.'
};
class AccessError extends Error {
  constructor(status, code) { super(messages[code]); this.status = status; this.code = code; }
}
const fail = (status = 401, code = 'verification_failed') => { throw new AccessError(status, code); };
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decode(value) {
  try { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { fail(); }
}
function validToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try { const bytes = decode(value); return bytes.length === 32 && encode(bytes) === value; } catch { return false; }
}
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => encode(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) fail(400, 'invalid_request');
  const email = value.trim().toLowerCase(), parts = email.split('@');
  if (parts.length !== 2 || parts[0].length < 1 || parts[0].length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..') ||
      parts[1].split('.').length < 2 || !parts[1].split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) fail(400, 'invalid_request');
  return email;
}
function newCode() {
  let n; do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= 4_200_000_000);
  return String(n % 100_000_000).padStart(8, '0');
}
class AccessCrypto {
  constructor(secret) {
    if (!validToken(secret)) fail(503, 'unavailable');
    this.master = crypto.subtle.importKey('raw', decode(secret), 'HKDF', false, ['deriveKey']);
    this.keys = new Map();
  }
  key(purpose, name) {
    const cache = `${purpose}:${name}`;
    if (!this.keys.has(cache)) this.keys.set(cache, this.master.then(key => crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('vellivex-app-access-v1'), info: encoder.encode(purpose) },
      key, name === 'HMAC' ? { name, hash: 'SHA-256' } : { name, length: 256 }, false,
      name === 'HMAC' ? ['sign', 'verify'] : ['encrypt', 'decrypt'])));
    return this.keys.get(cache);
  }
  async mac(purpose, value) { return encode(await crypto.subtle.sign('HMAC', await this.key(purpose, 'HMAC'), encoder.encode(value))); }
  async check(purpose, value, mac) {
    if (!validToken(mac)) return false;
    return crypto.subtle.verify('HMAC', await this.key(purpose, 'HMAC'), decode(mac), encoder.encode(value));
  }
  async seal(index, email) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(index), tagLength: 128 }, await this.key('email-at-rest', 'AES-GCM'), encoder.encode(email));
    return `va1.${encode(iv)}.${encode(cipher)}`;
  }
  async open(index, value) {
    try {
      const [version, iv, cipher, extra] = value.split('.');
      if (version !== 'va1' || extra !== undefined || decode(iv).length !== 12) fail(503, 'unavailable');
      return new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode(index), tagLength: 128 },
        await this.key('email-at-rest', 'AES-GCM'), decode(cipher)));
    } catch { fail(503, 'unavailable'); }
  }
}
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
function readCookie(request, name, required = true) {
  const parts = (request.headers.get('cookie') || '').split(';').map(p => p.trim()).filter(p => p.startsWith(`${name}=`));
  if (!parts.length && !required) return null;
  if (parts.length !== 1 || !validToken(parts[0].slice(name.length + 1))) fail();
  return parts[0].slice(name.length + 1);
}
function json(value, status = 200, cookies = []) {
  const headers = new Headers({ ...SECURITY, 'Content-Type': 'application/json; charset=utf-8' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  if (status === 429) headers.set('Retry-After', '60');
  return new Response(JSON.stringify(value), { status, headers });
}
function exactKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(400, 'invalid_request');
}
async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(400, 'invalid_request');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d{1,5}$/.test(length) || Number(length) > 4096)) fail(400, 'invalid_request');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'invalid_request');
  let timer;
  try {
    return await Promise.race([(async () => {
      const chunks = []; let bytes = 0, count = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (!(value instanceof Uint8Array) || ++count > 128 || (bytes += value.byteLength) > 4096) fail(400, 'invalid_request');
        chunks.push(value);
      }
      const all = new Uint8Array(bytes); let at = 0;
      for (const part of chunks) { all.set(part, at); at += part.length; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { fail(400, 'invalid_request'); }
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new AccessError(400, 'invalid_request')), 3000); })]);
  } finally { clearTimeout(timer); try { void reader.cancel().catch(() => {}); } catch {} }
}
function trustedIP(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 45 || !/^[a-fA-F0-9.:]+$/.test(ip)) fail(503, 'unavailable');
  return ip;
}
function validScope(scope) {
  return scope && typeof scope === 'object' && !Array.isArray(scope) &&
    Object.keys(scope).sort().join(',') === 'appAccess,epoch,id,session' && scope.appAccess === true &&
    validToken(scope.id) && validToken(scope.session) && Number.isSafeInteger(scope.epoch) && scope.epoch >= 1;
}
const firstResult = result => result?.results?.[0] ?? null;

class AppAccess {
  constructor(env, { now, sendMail, mailTransport, budgets }) {
    if (!env?.ACCOUNTS_DB?.prepare || !env.ACCOUNTS_DB.batch) fail(503, 'unavailable');
    this.db = env.ACCOUNTS_DB; this.crypto = new AccessCrypto(env.VELLIVEX_ACCOUNT_KEY);
    this.now = now; this.mail = sendMail ?? createVerificationMailer(env.VELLIVEX_RESEND_KEY, { transport: mailTransport });
    this.budgets = budgets;
  }
  stmt(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async clean() {
    const now = this.now(), key = await this.crypto.mac('expiry-cleanup', 'global');
    // A database claim bounds cleanup across requests and Worker instances. Keep the
    // claim outside the purge transaction so a failed purge cannot create a retry storm.
    try {
      const claimed = await this.stmt('INSERT INTO va_limits(key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE expires_at<=? RETURNING hits', key, now + CLEANUP_MS, now).first();
      if (!claimed) return;
      // Explicit dependency order also supports D1 databases with foreign keys disabled.
      await this.db.batch([
        this.stmt('DELETE FROM va_app_sessions WHERE expires_at<=? OR sso_hash IN (SELECT token_hash FROM va_sso_sessions WHERE expires_at<=?)', now, now),
        this.stmt('DELETE FROM va_handoffs WHERE expires_at<=? OR sso_hash IN (SELECT token_hash FROM va_sso_sessions WHERE expires_at<=?)', now, now),
        ...['va_sso_sessions', 'va_email_challenges', 'va_email_state', 'va_flows', 'va_logout_flows', 'va_mail_budget'].map(table => this.stmt(`DELETE FROM ${table} WHERE expires_at<=?`, now)),
        // Retain the maintenance lease so delayed requests cannot recreate an old claim.
        this.stmt('DELETE FROM va_limits WHERE expires_at<=? AND key<>?', now, key)
      ]);
    } catch {
      // Every authorization query enforces expiry independently. Defer physical
      // cleanup without admitting expired credentials or failing a valid sign-in.
      // A failed/ambiguous claim never falls back to running an unclaimed purge.
      console.warn('App-access expiry cleanup deferred');
    }
  }
  async limit(scope, value, max, windowMs) {
    const now = this.now(), bucket = Math.floor(now / windowMs);
    const key = await this.crypto.mac('rate-limit', `${scope}\0${bucket}\0${value}`);
    const row = await this.stmt('INSERT INTO va_limits(key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 WHERE hits<? RETURNING hits', key, (bucket + 1) * windowMs, max).first();
    if (!row) fail(429, 'rate_limited');
  }
  async prepare(body, request) {
    exactKeys(body, ['audience', 'returnPath', 'state', 'verifierHash']);
    if (!allowedAudience(body.audience) || !validReturnPath(body.audience, body.returnPath) || !validToken(body.state) || !validToken(body.verifierHash)) fail(400, 'invalid_request');
    const ip = trustedIP(request);
    await this.limit('prepare-ip-minute', ip, 20, MINUTE);
    await this.limit('prepare-ip-hour', ip, 60, HOUR);
    await this.limit('prepare-global-minute', 'all', 300, MINUTE);
    await this.limit('prepare-global-day', 'all', 5000, DAY);
    await this.clean();
    const flowId = random(), now = this.now();
    await this.stmt('INSERT INTO va_flows(id,audience,return_path,state,verifier_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      await digest(flowId), body.audience, body.returnPath, body.state, body.verifierHash, now, now + FLOW_MS).run();
    return { flowId, authorizeUrl: `${CENTRAL_ORIGIN}/access?flow=${flowId}#_` };
  }
  async flow(flowId, browserHash) {
    if (!validToken(flowId)) fail(401, 'flow_expired');
    const row = await this.stmt('SELECT * FROM va_flows WHERE id=? AND used=0 AND expires_at>? AND browser_hash=?', await digest(flowId), this.now(), browserHash).first();
    if (!row) fail(401, 'flow_expired');
    return row;
  }
  async sso(request, required = true) {
    const token = readCookie(request, SSO_COOKIE, required); if (!token) return null;
    const row = await this.stmt(`SELECT s.token_hash,s.user_id,s.epoch,s.expires_at,u.email_index,u.email_cipher
      FROM va_sso_sessions s JOIN va_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND s.epoch=u.epoch AND u.disabled=0`, await digest(token), this.now()).first();
    if (!row && required) fail();
    return row;
  }
  async bootstrap(flowId, request) {
    if (flowId !== null && !validToken(flowId)) fail(401, 'flow_expired');
    await this.limit('bootstrap-ip-minute', trustedIP(request), 60, MINUTE);
    let browser = readCookie(request, BROWSER_COOKIE, false); if (!browser) browser = random();
    const browserHash = await digest(browser), now = this.now();
    if (flowId === null) {
      await this.limit('management-ip-hour', trustedIP(request), 120, HOUR);
      await this.limit('management-global-minute', 'all', 200, MINUTE);
      await this.limit('management-global-day', 'all', 5000, DAY);
      await this.clean();
      const session = await this.sso(request, false), currentToken = readCookie(request, SSO_COOKIE, false);
      const id = random(), idHash = await digest(id), ssoHash = currentToken ? await digest(currentToken) : '';
      await this.stmt('INSERT INTO va_logout_flows(id,browser_hash,sso_hash,expires_at) VALUES(?,?,?,?)', idHash, browserHash, ssoHash, now + FLOW_MS).run();
      return json({ flowId: id, management: true, appName: 'Vellivex apps',
        csrf: await this.crypto.mac('logout-csrf', `${idHash}\0${browserHash}\0${ssoHash}`), signedIn: Boolean(session),
        ...(session ? { email: await this.crypto.open(session.email_index, session.email_cipher) } : {}), expiresAt: now + FLOW_MS
      }, 200, [cookie(BROWSER_COOKIE, browser, 600)]);
    }
    const flowHash = await digest(flowId);
    const flow = await this.stmt(`UPDATE va_flows SET browser_hash=? WHERE id=? AND expires_at>? AND used=0
      AND (browser_hash IS NULL OR browser_hash=?) RETURNING *`, browserHash, flowHash, now, browserHash).first();
    if (!flow) fail(401, 'flow_expired');
    const session = await this.sso(request, false);
    return json({ flowId, appName: 'Vellivex apps', csrf: await this.crypto.mac('csrf', `${flowHash}\0${browserHash}`),
      signedIn: Boolean(session), ...(session ? { email: await this.crypto.open(session.email_index, session.email_cipher) } : {}), expiresAt: flow.expires_at
    }, 200, [cookie(BROWSER_COOKIE, browser, 600)]);
  }
  async browserMutation(body, request) {
    if (!validToken(body?.flowId) || !validToken(body?.csrf)) fail();
    const browserHash = await digest(readCookie(request, BROWSER_COOKIE));
    const flowHash = await digest(body.flowId);
    if (!await this.crypto.check('csrf', `${flowHash}\0${browserHash}`, body.csrf)) fail();
    return { browserHash, flow: await this.flow(body.flowId, browserHash) };
  }
  async reserveMail() {
    const now = this.now(), date = new Date(now), monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const result = await this.db.batch([
      this.stmt('INSERT INTO va_mail_budget(key,sent,expires_at) SELECT ?,1,? WHERE ?>0 ON CONFLICT(key) DO UPDATE SET sent=sent+1 WHERE sent<? RETURNING sent', 'd:' + date.toISOString().slice(0, 10), Math.floor(now / DAY + 1) * DAY, this.budgets.daily, this.budgets.daily),
      this.stmt('INSERT INTO va_mail_budget(key,sent,expires_at) SELECT ?,1,? WHERE ?>0 ON CONFLICT(key) DO UPDATE SET sent=sent+1 WHERE sent<? RETURNING sent', 'm:' + date.toISOString().slice(0, 7), monthEnd, this.budgets.monthly, this.budgets.monthly)
    ]);
    if (result.some(item => !firstResult(item))) fail(429, 'mail_limit');
  }
  async requestCode(body, request) {
    exactKeys(body, ['flowId', 'csrf', 'email', 'marketingOptIn']);
    if (typeof body.marketingOptIn !== 'boolean') fail(400, 'invalid_request');
    const { browserHash, flow } = await this.browserMutation(body, request);
    const email = emailAddress(body.email), emailIndex = await this.crypto.mac('email-lookup', email);
    if (!this.mail) fail(503, 'email_unavailable');
    await this.limit('email-send', emailIndex, 3, HOUR);
    await this.limit('email-ip', trustedIP(request), 6, HOUR);
    const now = this.now(), challengeId = random(), challengeHash = await digest(challengeId);
    const reserved = await this.stmt(`INSERT INTO va_email_state(email_index,latest_challenge,last_requested_at,expires_at) VALUES(?,?,?,?)
      ON CONFLICT(email_index) DO UPDATE SET latest_challenge=excluded.latest_challenge,last_requested_at=excluded.last_requested_at,expires_at=excluded.expires_at
      WHERE last_requested_at<=? RETURNING email_index`, emailIndex, challengeHash, now, now + DAY, now - MINUTE).first();
    if (!reserved) fail(429, 'rate_limited');
    await this.reserveMail();
    const code = newCode(), cipher = await this.crypto.seal(emailIndex, email);
    const codeMac = await this.crypto.mac('email-code', `${challengeHash}\0${emailIndex}\0${flow.id}\0${browserHash}\0${code}`);
    await this.stmt(`INSERT INTO va_email_challenges(id,flow_id,browser_hash,email_index,email_cipher,code_mac,updates_opt_in,delivery,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,'pending',?,?)`, challengeHash, flow.id, browserHash, emailIndex, cipher, codeMac, body.marketingOptIn ? 1 : 0, now, now + FLOW_MS).run();
    try {
      await this.mail({ email, code, id: challengeHash });
      const sent = await this.stmt(`UPDATE va_email_challenges SET delivery='sent' WHERE id=? AND used=0 AND delivery='pending'
        AND expires_at>? AND EXISTS(SELECT 1 FROM va_email_state WHERE email_index=? AND latest_challenge=?) RETURNING id`, challengeHash, this.now(), emailIndex, challengeHash).first();
      if (!sent) fail(503, 'email_unavailable');
    } catch {
      await this.stmt("UPDATE va_email_challenges SET delivery='failed',used=1 WHERE id=?", challengeHash).run();
      fail(503, 'email_unavailable');
    }
    return json({ challengeId, expiresIn: 600, resendAfter: 60 }, 202);
  }
  callback(flow, code) {
    return `${flow.audience}/__access/finish?code=${code}&state=${flow.state}#_`;
  }
  async verifyCode(body, request) {
    exactKeys(body, ['flowId', 'csrf', 'challengeId', 'code']);
    const { browserHash, flow } = await this.browserMutation(body, request);
    if (!validToken(body.challengeId) || typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) fail();
    await this.limit('email-check-ip', trustedIP(request), 20, 15 * MINUTE);
    const challengeHash = await digest(body.challengeId), now = this.now();
    const row = await this.stmt(`UPDATE va_email_challenges SET attempts=attempts+1 WHERE id=? AND flow_id=? AND browser_hash=?
      AND expires_at>? AND used=0 AND delivery='sent' AND attempts<5
      AND EXISTS(SELECT 1 FROM va_email_state e WHERE e.email_index=va_email_challenges.email_index AND e.latest_challenge=va_email_challenges.id) RETURNING *`, challengeHash, flow.id, browserHash, now).first();
    if (!row || !await this.crypto.check('email-code', `${challengeHash}\0${row.email_index}\0${flow.id}\0${browserHash}\0${body.code}`, row.code_mac)) fail();
    const claim = random(), userId = random(), ssoToken = random(), code = random();
    const ssoHash = await digest(ssoToken), codeHash = await digest(code);
    const claimExists = 'EXISTS(SELECT 1 FROM va_email_challenges WHERE id=? AND claim_nonce=?)';
    const result = await this.db.batch([
      this.stmt(`UPDATE va_email_challenges SET used=1,claim_nonce=? WHERE id=? AND used=0 AND delivery='sent' AND expires_at>?
        AND EXISTS(SELECT 1 FROM va_email_state e WHERE e.email_index=va_email_challenges.email_index AND e.latest_challenge=va_email_challenges.id)
        AND EXISTS(SELECT 1 FROM va_flows f WHERE f.id=? AND f.used=0 AND f.expires_at>? AND f.browser_hash=?) RETURNING id`, claim, challengeHash, now, flow.id, now, browserHash),
      this.stmt(`INSERT INTO va_users(id,email_index,email_cipher,created_at,verified_at,updates_opt_in,updates_consent_at,updates_consent_version)
        SELECT ?,?,?,?,?,?,?,? WHERE ${claimExists}
        ON CONFLICT(email_index) DO UPDATE SET verified_at=excluded.verified_at,
        updates_opt_in=CASE WHEN excluded.updates_opt_in=1 THEN 1 ELSE va_users.updates_opt_in END,
        updates_consent_at=CASE WHEN excluded.updates_opt_in=1 THEN excluded.updates_consent_at ELSE va_users.updates_consent_at END,
        updates_consent_version=CASE WHEN excluded.updates_opt_in=1 THEN excluded.updates_consent_version ELSE va_users.updates_consent_version END`,
        userId, row.email_index, row.email_cipher, now, now, row.updates_opt_in, row.updates_opt_in ? now : null, row.updates_opt_in ? 'va-updates-v1' : null, challengeHash, claim),
      this.stmt(`INSERT INTO va_sso_sessions(token_hash,user_id,epoch,created_at,expires_at)
        SELECT ?,u.id,u.epoch,?,? FROM va_users u WHERE u.email_index=? AND u.disabled=0 AND ${claimExists}`,
        ssoHash, now, now + SESSION_MS, row.email_index, challengeHash, claim),
      this.stmt(`INSERT INTO va_handoffs(code_hash,flow_id,sso_hash,user_id,epoch,audience,return_path,state,verifier_hash,created_at,expires_at)
        SELECT ?,?,s.token_hash,s.user_id,s.epoch,?,?,?,?,?,? FROM va_sso_sessions s WHERE s.token_hash=? AND ${claimExists}`,
        codeHash, flow.id, flow.audience, flow.return_path, flow.state, flow.verifier_hash, now, now + HANDOFF_MS, ssoHash, challengeHash, claim),
      this.stmt(`UPDATE va_flows SET used=1 WHERE id=? AND ${claimExists} AND EXISTS(SELECT 1 FROM va_handoffs WHERE code_hash=?) RETURNING id`, flow.id, challengeHash, claim, codeHash)
    ]);
    if (!firstResult(result[0]) || !firstResult(result[4])) fail();
    return json({ redirectTo: this.callback(flow, code) }, 200, [cookie(SSO_COOKIE, ssoToken, SESSION_MS / 1000)]);
  }
  async continue(body, request) {
    exactKeys(body, ['flowId', 'csrf']);
    const { flow } = await this.browserMutation(body, request), sso = await this.sso(request);
    const code = random(), codeHash = await digest(code), now = this.now();
    const result = await this.db.batch([
      this.stmt(`INSERT INTO va_handoffs(code_hash,flow_id,sso_hash,user_id,epoch,audience,return_path,state,verifier_hash,created_at,expires_at)
        SELECT ?,f.id,s.token_hash,s.user_id,s.epoch,f.audience,f.return_path,f.state,f.verifier_hash,?,?
        FROM va_flows f JOIN va_sso_sessions s JOIN va_users u ON u.id=s.user_id
        WHERE f.id=? AND f.used=0 AND f.expires_at>? AND s.token_hash=? AND s.expires_at>? AND u.disabled=0 AND u.epoch=s.epoch`,
        codeHash, now, Math.min(now + HANDOFF_MS, sso.expires_at), flow.id, now, sso.token_hash, now),
      this.stmt('UPDATE va_flows SET used=1 WHERE id=? AND used=0 AND EXISTS(SELECT 1 FROM va_handoffs WHERE code_hash=?) RETURNING id', flow.id, codeHash)
    ]);
    if (!firstResult(result[1])) fail(401, 'flow_expired');
    return json({ redirectTo: this.callback(flow, code) });
  }
  async redeem(body) {
    exactKeys(body, ['code', 'state', 'audience', 'verifier']);
    if (!allowedAudience(body.audience) || !validToken(body.code) || !validToken(body.state) || !validToken(body.verifier)) fail(400, 'invalid_request');
    const now = this.now(), codeHash = await digest(body.code), verifierHash = await digest(body.verifier), claim = random(), token = random(), tokenHash = await digest(token);
    const result = await this.db.batch([
      this.stmt(`UPDATE va_handoffs SET used=1,claim_nonce=? WHERE code_hash=? AND used=0 AND expires_at>? AND audience=? AND state=? AND verifier_hash=?
        AND EXISTS(SELECT 1 FROM va_sso_sessions s JOIN va_users u ON u.id=s.user_id WHERE s.token_hash=va_handoffs.sso_hash
          AND s.user_id=va_handoffs.user_id AND s.epoch=va_handoffs.epoch AND s.epoch=u.epoch AND s.expires_at>? AND u.disabled=0) RETURNING *`,
        claim, codeHash, now, body.audience, body.state, verifierHash, now),
      this.stmt(`INSERT INTO va_app_sessions(token_hash,sso_hash,user_id,epoch,audience,created_at,expires_at)
        SELECT ?,h.sso_hash,h.user_id,h.epoch,h.audience,?,s.expires_at FROM va_handoffs h JOIN va_sso_sessions s ON s.token_hash=h.sso_hash
        WHERE h.code_hash=? AND h.claim_nonce=?`, tokenHash, now, codeHash, claim)
    ]);
    const handoff = firstResult(result[0]); if (!handoff) fail();
    const session = await this.stmt('SELECT expires_at FROM va_app_sessions WHERE token_hash=?', tokenHash).first();
    if (!session || session.expires_at <= now) fail();
    return { sessionToken: token, expiresIn: Math.floor((session.expires_at - now) / 1000), returnPath: handoff.return_path, state: handoff.state };
  }
  async validate(body) {
    exactKeys(body, ['audience', 'sessionToken']);
    if (!allowedAudience(body.audience) || !validToken(body.sessionToken)) fail(400, 'invalid_request');
    const hash = await digest(body.sessionToken), row = await sessionByHash(this.db, hash, body.audience, this.now());
    if (!row) fail();
    return { valid: true, scope: { id: row.user_id, epoch: row.epoch, session: hash, appAccess: true }, expiresAt: row.expires_at };
  }
  async logout(body, request) {
    exactKeys(body, ['flowId', 'csrf']);
    if (!validToken(body.flowId) || !validToken(body.csrf)) fail();
    const token = readCookie(request, SSO_COOKIE, false);
    const browserHash = await digest(readCookie(request, BROWSER_COOKIE)), flowHash = await digest(body.flowId), ssoHash = token ? await digest(token) : '';
    if (await this.crypto.check('logout-csrf', `${flowHash}\0${browserHash}\0${ssoHash}`, body.csrf)) {
      const exists = 'EXISTS(SELECT 1 FROM va_logout_flows WHERE id=? AND browser_hash=? AND sso_hash=? AND expires_at>?)';
      const args = [flowHash, browserHash, ssoHash, this.now()];
      const result = await this.db.batch([
        this.stmt(`DELETE FROM va_app_sessions WHERE sso_hash=? AND ${exists}`, ssoHash, ...args),
        this.stmt(`DELETE FROM va_handoffs WHERE sso_hash=? AND ${exists}`, ssoHash, ...args),
        this.stmt(`DELETE FROM va_sso_sessions WHERE token_hash=? AND ${exists}`, ssoHash, ...args),
        this.stmt('DELETE FROM va_logout_flows WHERE id=? AND browser_hash=? AND sso_hash=? AND expires_at>? RETURNING id', ...args)
      ]);
      if (!firstResult(result[3])) fail();
    } else {
      await this.browserMutation(body, request);
      if (token) await this.db.batch([
        this.stmt('DELETE FROM va_app_sessions WHERE sso_hash=?', ssoHash),
        this.stmt('DELETE FROM va_handoffs WHERE sso_hash=?', ssoHash),
        this.stmt('DELETE FROM va_sso_sessions WHERE token_hash=?', ssoHash)
      ]);
    }
    return json({ ok: true }, 200, [cookie(SSO_COOKIE, '', 0)]);
  }
}

async function sessionByHash(db, hash, audience, now) {
  return db.prepare(`SELECT a.user_id,a.epoch,a.expires_at FROM va_app_sessions a
    JOIN va_sso_sessions s ON s.token_hash=a.sso_hash JOIN va_users u ON u.id=a.user_id
    WHERE a.token_hash=? AND a.audience=? AND a.expires_at>? AND s.expires_at>?
      AND a.user_id=s.user_id AND a.epoch=s.epoch AND a.epoch=u.epoch AND u.disabled=0`).bind(hash, audience, now, now).first();
}

export async function validateAppScope(scope, env, { now = Date.now, audience = CENTRAL_ORIGIN } = {}) {
  if (!validScope(scope) || !allowedAudience(audience) || !env?.ACCOUNTS_DB?.prepare) return false;
  const timestamp = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return false;
  try {
    const row = await sessionByHash(env.ACCOUNTS_DB, scope.session, audience, timestamp);
    return Boolean(row && row.user_id === scope.id && row.epoch === scope.epoch);
  } catch { return false; }
}
export async function appCallScope(request, env) {
  if (new URL(request.url).origin !== CENTRAL_ORIGIN) fail();
  const hash = await digest(readCookie(request, APP_COOKIE));
  const row = await sessionByHash(env.ACCOUNTS_DB, hash, CENTRAL_ORIGIN, Date.now());
  if (!row) fail();
  return { id: row.user_id, epoch: row.epoch, session: hash, appAccess: true };
}
export async function validateAppCallScope(env, scope, now = Date.now()) {
  return validateAppScope(scope, env, { now, audience: CENTRAL_ORIGIN });
}

export function createAppAccess({ renderPage = renderAccessPage, assets = accessUiAsset, sendMail, mailTransport = fetch, now = Date.now, budgets = { daily: 90, monthly: 2800 } } = {}) {
  if (!Number.isSafeInteger(budgets.daily) || budgets.daily < 0 || budgets.daily > 90 ||
      !Number.isSafeInteger(budgets.monthly) || budgets.monthly < 0 || budgets.monthly > 2800) throw Error('Invalid verification mail budget');
  return { async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.username || url.password || url.hash || ![CENTRAL_ORIGIN, INTERNAL_ORIGIN].includes(url.origin)) fail(400, 'invalid_request');
      if (url.origin === INTERNAL_ORIGIN) {
        if (request.method !== 'POST' || url.search || !['/__app_access/prepare', '/__app_access/redeem', '/__app_access/validate'].includes(url.pathname)) fail(400, 'invalid_request');
        const service = new AppAccess(env, { now, sendMail, mailTransport, budgets }), body = await readJson(request);
        return json(await service[url.pathname.slice('/__app_access/'.length)](body, request));
      }
      if (url.pathname.startsWith('/__app_access/')) return json({ error: 'invalid_request', message: messages.invalid_request }, 404);
      if (request.method === 'GET' && url.pathname === '/access') {
        if ([...url.searchParams.keys()].some(k => k !== 'flow') || url.searchParams.getAll('flow').length > 1) fail(400, 'invalid_request');
        return new Response(renderPage({ appName: 'Vellivex apps' }), { headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      const asset = assets(url.pathname);
      if (asset && ['GET', 'HEAD'].includes(request.method) && !url.search) return new Response(request.method === 'HEAD' ? null : asset.body, { headers: { ...SECURITY, 'Content-Type': asset.type } });
      const service = new AppAccess(env, { now, sendMail, mailTransport, budgets });
      if (request.method === 'GET' && url.pathname === '/api/app-access/bootstrap') {
        if (url.searchParams.size > 1 || [...url.searchParams.keys()].some(key => key !== 'flow')) fail(400, 'invalid_request');
        const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
        if ((origin !== null && origin !== CENTRAL_ORIGIN) || (site !== null && site !== 'same-origin') || (origin === null && site !== 'same-origin')) fail();
        return await service.bootstrap(url.searchParams.get('flow'), request);
      }
      if (request.method !== 'POST' || url.search || request.headers.get('origin') !== CENTRAL_ORIGIN ||
          ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) fail(400, 'invalid_request');
      const actions = { '/api/app-access/request-code': 'requestCode', '/api/app-access/verify-code': 'verifyCode', '/api/app-access/continue': 'continue', '/api/app-access/logout': 'logout' };
      const action = actions[url.pathname]; if (!action) return json({ error: 'invalid_request', message: messages.invalid_request }, 404);
      return await service[action](await readJson(request), request);
    } catch (error) {
      return error instanceof AccessError ? json({ error: error.code, message: error.message }, error.status) : json({ error: 'unavailable', message: messages.unavailable }, 503);
    }
  } };
}
