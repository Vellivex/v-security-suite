// SPDX-License-Identifier: GPL-3.0-or-later
export const CENTRAL_ORIGIN = 'https://call.vellivex.com';
export const APP_AUDIENCES = Object.freeze({
  'https://vellivex.com': 'site',
  'https://www.vellivex.com': 'site',
  [CENTRAL_ORIGIN]: 'call',
  'https://vphone.vellivex.com': 'vphone',
  'https://vdecoy.vellivex.com': 'vdecoy',
  'https://vkey.vellivex.com': 'vkey',
  'https://private.vellivex.com': 'private',
});
const SITE_DOCUMENTS = Object.freeze({
  '/apps/guard': 'guard', '/apps/vault': 'vault', '/apps/relay': 'relay',
  '/apps/cipher': 'cipher', '/apps/cipher/vault': 'cipher', '/apps/cipher/relay': 'cipher',
  '/apps/mail': 'mail', '/apps/sms': 'number',
  '/offline/vault': 'vault', '/offline/relay': 'relay',
  '/offline/cipher/vault': 'cipher', '/offline/cipher/relay': 'cipher',
});
const STANDALONE_DOCUMENTS = Object.freeze({
  call: Object.freeze(['/call.html']),
  vphone: Object.freeze(['/', '/index.html']),
  vdecoy: Object.freeze(['/', '/index.html']),
  vkey: Object.freeze(['/']),
  private: Object.freeze(['/', '/live', '/live/']),
});
// These old owner/development destinations are not alternative public entrances.
// The wrapper denies them; it never sends a private URL fragment to another host.
export const LEGACY_APP_ORIGINS = Object.freeze({
  'https://vellivex-site-migration.vellivex-call.workers.dev': 'https://www.vellivex.com',
  'https://vellivex-accounts.vellivex-call.workers.dev': CENTRAL_ORIGIN,
  'https://vellivex-vphone-independent-staging.vellivex-call.workers.dev': 'https://vphone.vellivex.com',
  'https://vellivex-vdecoy-independent-staging.vellivex-call.workers.dev': 'https://vdecoy.vellivex.com',
  'https://vellivex-vkey-independent-staging.vellivex-call.workers.dev': 'https://vkey.vellivex.com',
  'https://vellivex-vphone-private-independent-staging.vellivex-call.workers.dev': 'https://private.vellivex.com',
});
const APK = /^\/downloads\/VGuard-\d+\.\d+\.\d+(?:-candidate)?\.apk$/;
export function allowedAudience(origin) {
  return typeof origin === 'string' && Object.hasOwn(APP_AUDIENCES, origin);
}
export function validReturnPath(audience, path) {
  if (!allowedAudience(audience) || typeof path !== 'string' || path.length > 180 || /[\\?#%\x00-\x20\x7f]/.test(path)) return false;
  const app = APP_AUDIENCES[audience];
  return app === 'site' ? Object.hasOwn(SITE_DOCUMENTS, path) || APK.test(path) : STANDALONE_DOCUMENTS[app].includes(path);
}
export function classifyAppRequest(request) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (Object.hasOwn(LEGACY_APP_ORIGINS, url.origin)) return {kind: 'alternate', canonicalOrigin: LEGACY_APP_ORIGINS[url.origin]};
  if (!allowedAudience(url.origin)) return null;
  const family = APP_AUDIENCES[url.origin], path = url.pathname, method = request.method;
  if (['GET', 'HEAD'].includes(method)) {
    if (family === 'site') {
      // The site itself canonicalizes a single trailing slash.
      const canonical = path.endsWith('/') ? path.slice(0, -1) : path;
      if (Object.hasOwn(SITE_DOCUMENTS, canonical)) return {app: SITE_DOCUMENTS[canonical], kind: 'document', returnPath: canonical};
      if (APK.test(path)) return {app: 'guard', kind: 'download', returnPath: path};
      if (['/api/public-sms', '/api/public-sms-extra'].includes(path)) return {app: 'number', kind: 'api', admission: 'feed'};
    } else if (STANDALONE_DOCUMENTS[family].includes(path)) return {app: family, kind: 'document', returnPath: path};
  }
  if (method === 'POST' && family === 'site' && path === '/api/mail/inbox') return {app: 'mail', kind: 'api', admission: 'create'};
  if (method === 'POST' && ['vkey', 'private'].includes(family) && ['/api/rooms', '/api/ice'].includes(path)) return {app: family, kind: 'api', admission: 'create'};
  // Existing capability-authorized room/inbox operations, including cleanup,
  // remain the responsibility of their unchanged capability handlers.
  return null;
}
