// SPDX-License-Identifier: GPL-3.0-or-later
import {CENTRAL_ORIGIN, allowedAudience, validReturnPath, classifyAppRequest} from './registry.mjs';

export const APP_COOKIE = '__Host-vellivex_app_access';
export const FLOW_COOKIE_PREFIX = '__Host-vellivex_flow_';
const SESSION_MAX_SECONDS = 30 * 86400;
const FLOW_SECONDS = 600;
const INTERNAL_ORIGIN = 'https://app-access.internal';
const baseHeaders = Object.freeze({
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow', 'X-Vellivex-App-Access': 'required',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
});
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function validAccessToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try { const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/')); return raw.length === 32 && encode(Uint8Array.from(raw, c => c.charCodeAt(0))) === value; }
  catch { return false; }
}
const randomToken = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const cookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const flowCookie = state => FLOW_COOKIE_PREFIX + state.slice(0, 12);
function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  if (header.length > 16384) return null;
  const values = header.split(';').map(value => value.trim()).filter(value => value.slice(0, value.indexOf('=')) === name);
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return validAccessToken(value) ? value : null;
}
function response(body, status = 200, headers = {}) {
  return new Response(body, {status, headers: {...baseHeaders, ...headers}});
}
function json(value, status, headers) { return response(JSON.stringify(value), status, {'Content-Type': 'application/json; charset=utf-8', ...headers}); }
function redirect(location, cookies = []) {
  const headers = new Headers({...baseHeaders, Location: location, 'Content-Type': 'text/plain; charset=utf-8'});
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, {status: 303, headers});
}
function failure(status, api = false) {
  const unavailable = status >= 500;
  const message = status === 429 ? 'Too many sign-in attempts. Please wait a minute and try again.' : unavailable ? 'Email sign-in is temporarily unavailable. Please try again shortly.' : 'This sign-in link is invalid or expired. Return to the app and start again.';
  return api ? json({error: unavailable ? 'app_access_unavailable' : 'app_sign_in_required'}, status) : response(
    message, status, {'Content-Type': 'text/plain; charset=utf-8', ...(unavailable || status === 429 ? {'Retry-After': status === 429 ? '60' : '30'} : {})});
}
export class AppAccessUnavailable extends Error {
  constructor() { super('App access is temporarily unavailable'); this.name = 'AppAccessUnavailable'; }
}
async function boundedJson(reply, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(reply.headers.get('Content-Type') || '')) throw new AppAccessUnavailable();
  if (Number(reply.headers.get('Content-Length') || 0) > 4096) throw new AppAccessUnavailable();
  const reader = reply.body?.getReader();
  if (!reader) throw new AppAccessUnavailable();
  let length = 0, text = '', count = 0, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new AppAccessUnavailable()); signal.addEventListener('abort', rejectAbort, {once: true}); if (signal.aborted) rejectAbort(); });
  const decoder = new TextDecoder('utf-8', {fatal: true});
  try {
    for (;;) {
      if (++count > 128) throw new AppAccessUnavailable();
      const {done, value} = await Promise.race([reader.read(), aborted]);
      if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new AppAccessUnavailable();
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppAccessUnavailable();
    return data;
  } finally { signal.removeEventListener('abort', rejectAbort); void reader.cancel().catch(() => {}); }
}
async function brokerCall(request, env, route, body, broker) {
  const headers = {'Content-Type': 'application/json'};
  if (route === 'prepare') {
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip && /^[A-Fa-f0-9:.]{3,64}$/.test(ip)) headers['CF-Connecting-IP'] = ip;
  }
  const controller = new AbortController();
  const internal = new Request(INTERNAL_ORIGIN + '/__app_access/' + route, {method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal});
  let timer;
  try {
    const send = broker ? () => broker(internal, env) : () => env.APP_ACCESS.fetch(internal);
    if (!broker && typeof env?.APP_ACCESS?.fetch !== 'function') throw new AppAccessUnavailable();
    return await Promise.race([(async () => {
      const reply = await send();
      if (!(reply instanceof Response)) throw new AppAccessUnavailable();
      if (!reply.ok) return {status: reply.status, data: null};
      return {status: reply.status, data: await boundedJson(reply, controller.signal)};
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AppAccessUnavailable()); }, 8000); timer.unref?.(); })]);
  } catch { throw new AppAccessUnavailable(); }
  finally { clearTimeout(timer); controller.abort(); }
}
const keys = (value, expected) => Object.keys(value).sort().join(',') === expected;
export async function validateAppAccess(request, env, {broker, now = Date.now} = {}) {
  const audience = new URL(request.url).origin;
  if (!allowedAudience(audience)) return null;
  const sessionToken = readCookie(request, APP_COOKIE);
  if (!sessionToken) return null;
  const result = await brokerCall(request, env, 'validate', {audience, sessionToken}, broker);
  if (result.status === 401) return null;
  const data = result.data, scope = data?.scope;
  if (result.status !== 200 || !data || !keys(data, 'expiresAt,scope,valid') || data.valid !== true ||
      !scope || typeof scope !== 'object' || Array.isArray(scope) || !keys(scope, 'appAccess,epoch,id,session') ||
      scope.appAccess !== true || !validAccessToken(scope.id) ||
      !Number.isSafeInteger(scope.epoch) || scope.epoch < 1 || !validAccessToken(scope.session) ||
      !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now()) throw new AppAccessUnavailable();
  return Object.freeze({...scope});
}
function scriptPage(script, message) {
  const nonce = randomToken();
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  return response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vellivex · Email sign-in</title><style nonce="${nonce}">body{margin:0;padding:3rem 1.5rem;background:#0a101b;color:#edf6ff;font:18px system-ui}main{max-width:34rem;margin:10vh auto}p{line-height:1.6;color:#c4d6e5}strong{color:#b5dded}</style><main><strong>VELLIVEX</strong><h1>Email access for every app.</h1><p id="status">${message}</p><noscript>Enable JavaScript to continue securely with email.</noscript></main><script nonce="${nonce}">${script}</script></html>`, 200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy});
}
function bootstrap(path) {
  const state = randomToken();
  const target = '/__access/start?state=' + state + '&next=' + encodeURIComponent(path) + '#_';
  return scriptPage(`(()=>{const state=${JSON.stringify(state)},path=${JSON.stringify(path)},key='vellivex-access-fragment:'+state;try{const fragment=location.hash==='#_'?'':location.hash;if(fragment.length>65536)throw Error();sessionStorage.setItem(key,JSON.stringify({path,fragment}));history.replaceState(null,'',path+'#_');location.replace(${JSON.stringify(target)});}catch{document.getElementById('status').textContent='Your browser could not preserve this invitation. Allow temporary site storage, then reopen the original invitation.';}})();`, 'Opening your email sign-in…');
}
function returnPage(state, path) {
  return scriptPage(`(()=>{const key='vellivex-access-fragment:'+${JSON.stringify(state)},path=${JSON.stringify(path)};try{let fragment='';const raw=sessionStorage.getItem(key);if(raw!==null){const saved=JSON.parse(raw);if(!saved||saved.path!==path||typeof saved.fragment!=='string'||saved.fragment.length>65536||saved.fragment&&!saved.fragment.startsWith('#'))throw Error();fragment=saved.fragment;sessionStorage.removeItem(key);}location.replace(path+(fragment||'#_'));}catch{document.getElementById('status').textContent='Sign-in is complete, but this browser could not restore the invitation. Reopen your original app link.';}})();`, 'Returning to your app…');
}
function exactQuery(url, names) {
  if (url.href.length > 900 || url.username || url.password || url.hash) return false;
  const present = [...url.searchParams.keys()];
  return present.length === names.length && new Set(present).size === names.length && names.every(name => present.includes(name));
}
function validAuthorizeUrl(value, flowId) {
  if (!validAccessToken(flowId) || typeof value !== 'string') return false;
  try { const u = new URL(value); return u.origin === CENTRAL_ORIGIN && u.pathname === '/access' && !u.username && !u.password && u.hash === '#_' && [...u.searchParams.keys()].join(',') === 'flow' && u.searchParams.get('flow') === flowId; }
  catch { return false; }
}
export function createAppAccessGate({broker, now = Date.now} = {}) {
  return {async handle(request, env) {
    const url = new URL(request.url), classification = classifyAppRequest(request);
    if (classification?.kind === 'alternate') return failure(403);
    if (!allowedAudience(url.origin)) return null;
    if (url.pathname.startsWith('/__access/')) {
      if (request.method !== 'GET') return failure(405);
      const state = url.searchParams.get('state');
      if (!validAccessToken(state)) return failure(400);
      if (url.pathname === '/__access/start') {
        const next = url.searchParams.get('next'), origin = request.headers.get('Origin'), site = request.headers.get('Sec-Fetch-Site');
        if (!exactQuery(url, ['state', 'next']) || !validReturnPath(url.origin, next) || site !== 'same-origin' || origin && origin !== url.origin) return failure(403);
        const verifier = randomToken();
        let result;
        try { result = await brokerCall(request, env, 'prepare', {audience: url.origin, returnPath: next, state, verifierHash: await hash(verifier)}, broker); }
        catch { return failure(503); }
        const data = result.data;
        if (result.status !== 200) return failure(result.status === 429 ? 429 : 503);
        if (!data || !keys(data, 'authorizeUrl,flowId') || !validAuthorizeUrl(data.authorizeUrl, data.flowId)) return failure(503);
        return redirect(data.authorizeUrl, [cookie(flowCookie(state), verifier, FLOW_SECONDS)]);
      }
      if (url.pathname === '/__access/finish') {
        const code = url.searchParams.get('code'), verifier = readCookie(request, flowCookie(state));
        if (!exactQuery(url, ['code', 'state']) || !validAccessToken(code) || !verifier) return failure(401);
        let result;
        try { result = await brokerCall(request, env, 'redeem', {code, state, audience: url.origin, verifier}, broker); }
        catch { return failure(503); }
        const data = result.data;
        if (result.status !== 200) return failure(result.status === 401 ? 401 : 503);
        if (!data || !keys(data, 'expiresIn,returnPath,sessionToken,state') || !validAccessToken(data.sessionToken) || data.state !== state || !validReturnPath(url.origin, data.returnPath) || !Number.isSafeInteger(data.expiresIn) || data.expiresIn < 1 || data.expiresIn > SESSION_MAX_SECONDS) return failure(503);
        return redirect('/__access/return?state=' + state + '&next=' + encodeURIComponent(data.returnPath) + '#_', [cookie(APP_COOKIE, data.sessionToken, data.expiresIn), cookie(flowCookie(state), '', 0)]);
      }
      if (url.pathname === '/__access/return') {
        const next = url.searchParams.get('next');
        if (!exactQuery(url, ['state', 'next']) || !validReturnPath(url.origin, next)) return failure(400);
        return returnPage(state, next);
      }
      return failure(404);
    }
    if (!classification) return null;
    try { if (await validateAppAccess(request, env, {broker, now})) return null; }
    catch { return failure(503, classification.kind === 'api'); }
    if (classification.kind === 'api') return failure(401, true);
    // A GET navigation receives a same-origin bootstrap. It captures any private
    // fragment before a central redirect; server requests never receive it.
    const page = bootstrap(classification.returnPath);
    if (request.method === 'HEAD') return new Response(null, {status: page.status, headers: page.headers});
    return page;
  }};
}
export function markAuthorizedAppDocument(request, original) {
  const path = new URL(request.url).pathname, type = original.headers.get('Content-Type') || '';
  const documentType = /^text\/html(?:\s*;|$)/i.test(type) || path.startsWith('/offline/') && /^text\/plain(?:\s*;|$)/i.test(type);
  if (classifyAppRequest(request)?.kind !== 'document' || original.status !== 200 || !documentType) return original;
  const headers = new Headers(original.headers);
  headers.set('X-Vellivex-App-Access', 'verified');
  const cachePolicy = headers.get('Cache-Control') || '';
  headers.set('Cache-Control', 'no-store' + (/\bno-transform\b/i.test(cachePolicy) ? ', no-transform' : ''));
  return new Response(original.body, {status: original.status, statusText: original.statusText, headers});
}
