import { MAIL_SITE_ORIGINS, MAIL_INTERNAL_ORIGIN, MAIL_PUBLIC_ORIGIN, forwardMailRequest, mailFailure } from './mail-transport.mjs';

const INBOX = /^\/api\/inbox\/[0-9a-f]{32}$/;

// Deploy this wrapper as the Mail entrypoint; retain the original worker module
// byte-for-byte. Only the site service binding may reach the creation lane.
export function guardMailBackend(core) {
  if (!core || typeof core.fetch !== 'function') throw new TypeError('Mail backend required.');
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.origin === MAIL_INTERNAL_ORIGIN) {
        if (url.search || url.hash) return mailFailure(404);
        const create = url.pathname === '/api/inbox' && request.method === 'POST';
        const existing = INBOX.test(url.pathname) && ['GET', 'DELETE'].includes(request.method);
        const status = url.pathname === '/api/status' && request.method === 'GET';
        if (!create && !existing && !status) return mailFailure(404);
        if (create && (!MAIL_SITE_ORIGINS.includes(request.headers.get('origin')) || request.headers.has('authorization'))) return mailFailure(403);
        return core.fetch(forwardMailRequest(request, MAIL_PUBLIC_ORIGIN + url.pathname), env, ctx);
      }
      // Every public creation spelling is blocked before the original backend.
      // Read/delete retain the existing bearer capability and expiry checks.
      if (request.method === 'POST') return mailFailure(403, 'app_access_required');
      return core.fetch(request, env, ctx);
    },
    ...(typeof core.email === 'function' ? { email: (...args) => core.email(...args) } : {}),
    ...(typeof core.scheduled === 'function' ? { scheduled: (...args) => core.scheduled(...args) } : {}),
    ...(typeof core.queue === 'function' ? { queue: (...args) => core.queue(...args) } : {})
  };
}
