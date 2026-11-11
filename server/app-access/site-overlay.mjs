// A small response overlay preserves the currently deployed site's layout and
// app/offline bytes. It is not an HTML sanitizer and only handles our public pages.
const MARKETING_PATHS = new Set(['/', '/index.html', '/beta', '/source', '/trust', '/blog',
  '/testing', '/feedback', '/security', '/brand', '/roadmap', '/privacy', '/terms']);
const SITE_ORIGINS = new Set(['https://vellivex.com', 'https://www.vellivex.com']);
const MAIL_UPSTREAM = 'https://vellivex-disposable-mail-pilot.vellivex-call.workers.dev';
const ACCOUNT_LINK = '<a href="https://call.vellivex.com/access" data-app-access-link="true">Sign in / account</a>';
export const ACCESS_PRIVACY_HTML = '<section id="vellivex-email-access-privacy"><h2>Verified email and app access</h2>' +
  '<p>To open Vellivex apps, enter your email address and verify the eight-digit code we send. We store your verified email and access records so you can sign in across the apps. No name or password is required for this app access.</p>' +
  '<p>Essential sign-in cookies keep your access on this browser for up to 30 days. Verification codes expire after ten minutes. Our email delivery and hosting providers process the address, delivery and network information needed to provide this service. Limited verification and quota records help prevent abuse.</p>' +
  '<h3>Updates and offers are optional</h3><p>The updates checkbox starts unticked. We use your email for Vellivex updates and offers only if you choose that separate option. Verifying your email for app access does not by itself subscribe you to marketing.</p>' +
  '<h3>Your existing local app data</h3><p>Signing in does not upload, synchronise, recover or clear existing local app files, keys or recordings. They stay on the device and browser where you created them. Keep your own backups. Features that already use a server, such as VMail, continue to process data as described in their own sections below.</p>' +
  '<p>Email-only app access is separate from account security and payments. <a href="https://call.vellivex.com/access">Manage your app sign-in or sign out</a>.</p></section>';

function publicMarkup(html, isPrivacy) {
  // Skip comments and raw-text elements: examples or script strings must not be
  // rewritten as though they were live navigation. Attribute quotes are retained.
  let result = html.replace(/<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    if (!/^<a\b/i.test(tag)) return tag;
    return tag.replace(/(\shref\s*=\s*)(["'])https:\/\/call\.vellivex\.com\/?\2/gi,
      (_, attribute, quote) => attribute + quote + 'https://call.vellivex.com/call.html' + quote);
  });
  result = result.replace(/<nav\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/nav\s*>/gi, nav => {
    const opening = nav.slice(0, nav.indexOf('>') + 1);
    if (!/\sid\s*=\s*(["'])navigation\1/i.test(opening) || /\sdata-app-access-link\s*=/.test(nav)) return nav;
    return nav.replace(/<\/nav\s*>$/i, ACCOUNT_LINK + '</nav>');
  });
  if (isPrivacy && !result.includes('id="vellivex-email-access-privacy"')) {
    // This is the current privacy page's content wrapper, after its existing lead.
    result = result.replace(/<div\s+class=(["'])wrap narrow content\1\s*>/i, opening => opening + ACCESS_PRIVACY_HTML);
  }
  return result;
}

function mailPolicy(value) {
  if (!value) return value;
  return value.replace(/(^|;)(\s*connect-src\s+)([^;]*)/gi, (directive, separator, prefix, sources) => {
    const entries = sources.trim().split(/\s+/);
    if (!entries.some(entry => entry === MAIL_UPSTREAM || entry === MAIL_UPSTREAM + '/')) return directive;
    return separator + prefix + [...new Set(entries.map(entry => entry === MAIL_UPSTREAM || entry === MAIL_UPSTREAM + '/' ? "'self'" : entry))].join(' ');
  });
}

export async function transformSiteResponse(request, response) {
  const url = new URL(request.url), path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
  if (!SITE_ORIGINS.has(url.origin) || !['GET', 'HEAD'].includes(request.method) || response.status !== 200 ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/html') return response;
  const isMail = path === '/apps/mail';
  const isMarketing = MARKETING_PATHS.has(path) || /^\/blog\/[a-z0-9-]+$/.test(path);
  if (!isMail && !isMarketing) return response;
  const headers = new Headers(response.headers);
  let changed = false;
  if (isMail) {
    const previous = headers.get('Content-Security-Policy'), next = mailPolicy(previous);
    if (next !== previous) { headers.set('Content-Security-Policy', next); changed = true; }
    // Mail's HTML is part of the preserved application release. Change only its
    // connection policy; the same-origin API client is supplied separately.
    if (!changed) return response;
    headers.delete('Content-Length'); headers.delete('ETag');
    return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
  }
  // A HEAD or compressed representation has no editable HTML text here.
  if (request.method === 'HEAD' || !response.body ||
      (headers.has('Content-Encoding') && headers.get('Content-Encoding') !== 'identity')) return response;
  const original = await response.clone().text();
  const html = publicMarkup(original, path === '/privacy');
  if (html === original) return response;
  headers.delete('Content-Length'); headers.delete('ETag');
  return new Response(html, {status:response.status, statusText:response.statusText, headers});
}
