import { validateAppAccess } from './gate.mjs';
import { MAIL_SITE_ORIGINS, MAIL_INTERNAL_ORIGIN, forwardMailRequest, mailFailure } from './mail-transport.mjs';
export { MAIL_SITE_ORIGIN, MAIL_SITE_ORIGINS, MAIL_INTERNAL_ORIGIN, MAIL_PUBLIC_ORIGIN } from './mail-transport.mjs';
const INBOX = /^\/api\/mail\/inbox\/[0-9a-f]{32}$/;

export function createMailProxy({ validate = validateAppAccess } = {}) {
  return async function mailProxy(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/mail/')) return null;
    if (!MAIL_SITE_ORIGINS.includes(url.origin) || url.search || url.hash) return mailFailure(404);
    const create = url.pathname === '/api/mail/inbox' && request.method === 'POST';
    const existing = INBOX.test(url.pathname) && ['GET', 'DELETE'].includes(request.method);
    const status = url.pathname === '/api/mail/status' && request.method === 'GET';
    if (!create && !existing && !status) return mailFailure(404);
    if (create || request.method === 'DELETE') {
      if (request.headers.get('origin') !== url.origin ||
          ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) return mailFailure(403, 'origin_rejected');
    }
    if (create) {
      // The public client cannot enter the backend's separate pilot-token lane.
      if (request.headers.has('authorization')) return mailFailure(403);
      try { if (!await validate(request, env)) return mailFailure(401, 'app_access_required'); }
      catch { return mailFailure(503); }
    }
    if (!env.MAIL_API || typeof env.MAIL_API.fetch !== 'function') return mailFailure(503);
    try {
      const upstream = await env.MAIL_API.fetch(forwardMailRequest(request, MAIL_INTERNAL_ORIGIN + url.pathname.replace('/api/mail/', '/api/')));
      if (!(upstream instanceof Response) || upstream.status >= 300 && upstream.status < 400) return mailFailure(503);
      const headers = new Headers(upstream.headers);
      for (const name of [...headers.keys()]) if (name.startsWith('access-control-') || name === 'set-cookie' || name === 'location') headers.delete(name);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    } catch { return mailFailure(503); }
  };
}
