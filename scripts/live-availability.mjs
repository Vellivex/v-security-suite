// SPDX-License-Identifier: GPL-3.0-or-later
// Public-only, bounded availability test. Never requests accounts, messages or media.
const PAGES = Object.freeze([
  ['Website', 'https://www.vellivex.com/'],
  ['Beta testing', 'https://www.vellivex.com/testing'],
  ['Disposable inbox landing', 'https://www.vellivex.com/apps/mail'],
  ['Public SMS landing', 'https://www.vellivex.com/apps/sms'],
  ['VKey', 'https://vkey.vellivex.com/'],
  ['Private', 'https://private.vellivex.com/'],
  ['VDecoy', 'https://vdecoy.vellivex.com/'],
  ['VPhone', 'https://vphone.vellivex.com/'],
  ['Vellivex Call', 'https://call.vellivex.com/'],
]);

export { PAGES };
export async function checkPage(name, target, { fetcher = fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
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
    try { await response.body?.cancel(); } catch {}
    const finalUrl = new URL(response.url || url.href);
    const type = response.headers.get('content-type') || '';
    const ok = response.status === 200 && finalUrl.origin === url.origin &&
      type.toLowerCase().includes('text/html');
    return {
      name,
      ok,
      status: response.status,
      problem: ok ? null : 'Unexpected HTTP status, origin or content type',
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

async function main() {
  const results = await checkAll();
  for (const result of results)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.status ?? 'no response'}${result.problem ? ' - ' + result.problem : ''}`);
  const failures = results.filter(result => !result.ok);
  console.log(`Checked ${results.length} public pages; ${failures.length} failed. No logins, messages, phone calls or large media fetched.`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
