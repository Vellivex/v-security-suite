// Email app access is deliberately limited to free Internet Call admission.
// Account, owner, recovery and financial routes must keep their existing auth.
export const CALL_ORIGIN = 'https://call.vellivex.com';
export const APP_ACCESS_COOKIE = '__Host-vellivex_app_access';

function denied() {
  return Object.assign(new Error('Sign in to use Internet Call.'), { status: 401, code: 'verification_failed' });
}

function token(value) {
  // A 32-byte, unpadded, canonical base64url token has 43 characters.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

export function normalizeCallScope(scope, deny = denied) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw deny();
  const app = Object.hasOwn(scope, 'appAccess');
  const fields = Object.keys(scope).sort().join(',');
  if (fields !== (app ? 'appAccess,epoch,id,session' : 'epoch,id,session') ||
      app && scope.appAccess !== true || !token(scope.id) || !token(scope.session) ||
      !Number.isSafeInteger(scope.epoch) || scope.epoch < 1) throw deny();
  return { id: scope.id, epoch: scope.epoch, session: scope.session, ...(app ? { appAccess: true } : {}) };
}

export function readCallScope(request, deny = denied) {
  const header = request.headers.get('X-Vellivex-Scope');
  if (!header || header.length > 512) throw deny();
  let scope;
  try { scope = JSON.parse(header); } catch { throw deny(); }
  return normalizeCallScope(scope, deny);
}

export function sameCallScope(a, b) {
  return Boolean(a && b && a.id === b.id && a.session === b.session && a.epoch === b.epoch &&
    (a.appAccess === true) === (b.appAccess === true));
}

export function callScopeKey(scope) {
  return (scope.appAccess === true ? 'app:' : 'account:') + scope.session;
}

function hasAppToken(request) {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(APP_ACCESS_COOKIE + '='));
  return cookies.length === 1 && token(cookies[0].slice(APP_ACCESS_COOKIE.length + 1));
}

// The callbacks retain their own independent cookie readers and session stores.
// A stale cookie in one auth family must not invalidate a valid other family.
export async function resolveFreeCallScope(request, env, legacyAuthenticate, appAuthenticate, deny = denied) {
  const url = new URL(request.url);
  if (url.origin !== CALL_ORIGIN || env.VELLIVEX_ORIGIN !== CALL_ORIGIN || url.search ||
      !((url.pathname === '/api/volatile' && request.method === 'POST') ||
        (url.pathname === '/connect' && request.method === 'GET'))) throw deny();
  let infrastructureError;
  if (hasAppToken(request)) {
    try {
      const scope = normalizeCallScope(await appAuthenticate(request, env), deny);
      if (scope.appAccess !== true) throw deny();
      return scope;
    } catch (error) {
      if (error?.status !== 401 && error?.status !== 403) infrastructureError = error;
    }
  }
  try {
    const scope = normalizeCallScope(await legacyAuthenticate(), deny);
    if (Object.hasOwn(scope, 'appAccess')) throw deny();
    return scope;
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) infrastructureError ??= error;
  }
  if (infrastructureError) throw infrastructureError;
  throw deny();
}
