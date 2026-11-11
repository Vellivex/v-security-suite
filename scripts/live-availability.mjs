// SPDX-License-Identifier: GPL-3.0-or-later
// Public-only, bounded availability test. Never requests accounts, messages or media.
const PAGES = Object.freeze([
  ['Website', 'https://www.vellivex.com/'],
  ['Beta testing', 'https://www.vellivex.com/testing'],
  ['VGuard', 'https://www.vellivex.com/apps/guard'],
  ['VVault', 'https://www.vellivex.com/apps/vault'],
  ['VRelay', 'https://www.vellivex.com/apps/relay'],
  ['V Cipher', 'https://www.vellivex.com/apps/cipher'],
  ['Disposable inbox landing', 'https://www.vellivex.com/apps/mail'],
  ['Public SMS landing', 'https://www.vellivex.com/apps/sms'],
  ['VKey', 'https://vkey.vellivex.com/'],
  ['Private', 'https://private.vellivex.com/'],
  ['VDecoy', 'https://vdecoy.vellivex.com/'],
  ['VPhone', 'https://vphone.vellivex.com/'],
  ['Vellivex Call', 'https://call.vellivex.com/call.html'],
]);
const FIXED_PAGE_URLS = new Set(PAGES.map(([, url]) => url));
const SIGN_IN_PAGES = new Set(PAGES.slice(2).map(([, url]) => url));

const BRAND_ICONS = Object.freeze([
  ['Vellivex Call icon', 'https://www.vellivex.com/brand/apps/call.svg'],
  ['VPhone icon', 'https://www.vellivex.com/brand/apps/phone.svg'],
  ['VDecoy icon', 'https://www.vellivex.com/brand/apps/decoy.svg'],
  ['VKey icon', 'https://www.vellivex.com/brand/apps/key.svg'],
  ['VPhone Private icon', 'https://www.vellivex.com/brand/apps/private.svg'],
]);

const APP_FAVICONS = Object.freeze([
  ['Vellivex Call app favicon', 'https://call.vellivex.com/brand/apps/call.svg'],
  ['VPhone app favicon', 'https://vphone.vellivex.com/favicon.svg'],
  ['VDecoy app favicon', 'https://vdecoy.vellivex.com/brand-icon.svg'],
  ['VKey app favicon', 'https://vkey.vellivex.com/favicon.svg'],
  ['VPhone Private app favicon', 'https://private.vellivex.com/favicon.svg'],
]);
const FIXED_PUBLIC_ICON_URLS = new Set([...BRAND_ICONS, ...APP_FAVICONS].map(([, url]) => url));

export { PAGES, BRAND_ICONS, APP_FAVICONS };
export async function checkPage(name, target, { fetcher = fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !FIXED_PAGE_URLS.has(url.href))
    throw new TypeError('Only fixed public HTTPS page URLs are permitted.');
  try {
    const response = await fetcher(url.href, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'text/html' },
    });
    // Deliberately do not download or print page bodies or use any auth tokens.
    try { void response.body?.cancel().catch(() => {}); } catch {}
    const finalUrl = response.url || url.href;
    const type = response.headers.get('content-type') || '';
    const needsSignIn = SIGN_IN_PAGES.has(url.href);
    const marker = response.headers.get('X-Vellivex-App-Access');
    const validGate = marker === 'required' &&
      /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') || '') &&
      response.headers.get('Referrer-Policy') === 'no-referrer';
    const ok = response.status === 200 && finalUrl === url.href &&
      type.split(';')[0].trim().toLowerCase() === 'text/html' &&
      (needsSignIn ? validGate : marker === null);
    return {
      name,
      ok,
      status: response.status,
      availability: ok ? needsSignIn ? 'sign-in-required' : 'public-page' : 'unavailable',
      appTested: false,
      problem: ok ? null : needsSignIn ? 'Expected the private, uncached email sign-in gate' : 'Unexpected public page status, URL, content type or access marker',
    };
  } catch (error) {
    return { name, ok: false, status: null, problem: error?.name === 'TimeoutError' ? 'Timeout' : 'Network error' };
  }
}

export async function checkAll({ fetcher = fetch, timeoutMs = 10000, pages = PAGES } = {}) {
  const results = [];
  // Sequential, bounded requests avoid unnecessary load on this experimental beta.
  for (const [name, url] of pages) results.push(await checkPage(name, url, { fetcher, timeoutMs }));
  return results;
}

// Verify live SVG icon endpoints without reading or logging their contents.
export async function checkSvg(name, target, { fetcher = fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !FIXED_PUBLIC_ICON_URLS.has(url.href))
    throw new TypeError('Only Vellivex public app SVG icons are permitted.');
  try {
    const response = await fetcher(url.href, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'image/svg+xml' },
    });
    try { await response.body?.cancel(); } catch {}
    const type = (response.headers.get('content-type') || '').toLowerCase();
    const ok = response.status === 200 && (response.url || url.href) === url.href &&
      type.includes('image/svg+xml');
    return { name, ok, status: response.status,
      problem: ok ? null : 'Unexpected SVG HTTP status, origin or content type' };
  } catch (error) {
    return { name, ok: false, status: null,
      problem: error?.name === 'TimeoutError' ? 'Timeout' : 'Network error' };
  }
}

export async function checkBrandIcons({ fetcher = fetch, timeoutMs = 10000, icons = BRAND_ICONS } = {}) {
  const results = [];
  for (const [name, url] of icons) results.push(await checkSvg(name, url, { fetcher, timeoutMs }));
  return results;
}

export async function checkAppFavicons({ fetcher = fetch, timeoutMs = 10000, icons = APP_FAVICONS } = {}) {
  const results = [];
  for (const [name, url] of icons) results.push(await checkSvg(name, url, { fetcher, timeoutMs }));
  return results;
}

async function main() {
  const pages = await checkAll();
  const icons = await checkBrandIcons();
  const favicons = await checkAppFavicons();
  for (const result of [...pages, ...icons, ...favicons])
    console.log(`${result.ok ? result.availability === 'sign-in-required' ? 'SIGN-IN REQUIRED' : 'AVAILABLE' : 'FAIL'} ${result.name}: ${result.status ?? 'no response'}${result.problem ? ' - ' + result.problem : ''}`);
  const failures = [...pages, ...icons, ...favicons].filter(result => !result.ok);
  console.log(`Checked ${pages.length} public pages and sign-in gates, ${icons.length} cards and ${favicons.length} app favicons; ${failures.length} failed. Signed-in application functionality NOT TESTED. No logins, emails, messages, phone calls or large media downloaded.`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
