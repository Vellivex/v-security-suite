export const MAIL_SITE_ORIGIN = 'https://www.vellivex.com';
export const MAIL_SITE_ORIGINS = Object.freeze([MAIL_SITE_ORIGIN, 'https://vellivex.com']);
export const MAIL_INTERNAL_ORIGIN = 'https://mail-access.internal';
export const MAIL_PUBLIC_ORIGIN = 'https://mail-api.vellivex.info';
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'content-encoding',
  'transfer-encoding', 'cf-connecting-ip', 'origin', 'sec-fetch-site'];

export function mailFailure(status, error = 'mail_unavailable') {
  return new Response(JSON.stringify({ error }), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY'
  } });
}

export function forwardMailRequest(request, url) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  return new Request(url, { method: request.method, headers, redirect: 'manual',
    ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}) });
}
