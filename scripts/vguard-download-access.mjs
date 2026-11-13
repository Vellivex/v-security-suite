// SPDX-License-Identifier: GPL-3.0-or-later
// Anonymous admission check only. It never downloads an authenticated APK,
// requests a verification email, reads cookies or follows a sign-in redirect.
import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const VGUARD_DOWNLOAD_URL = 'https://www.vellivex.com/downloads/VGuard-0.1.4-candidate.apk';
export const APK_NOT_RUN = 'APK checksum, signature, Android installation and network behavior: NOT RUN (a legitimately downloaded APK is required).';

export async function checkVGuardDownloadAccess({fetcher = fetch, timeoutMs = 10000} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid check deadline.');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Download access check timed out.')); }, timeoutMs);
  });
  try {
    const response = await Promise.race([Promise.resolve().then(() => fetcher(VGUARD_DOWNLOAD_URL, {
      method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: {Accept: 'application/vnd.android.package-archive'}, signal: controller.signal,
    })).then(reply => {
      // Do not read/save APK or HTML bytes. Cancel even a late response after
      // timeout so the monitoring task cannot keep downloading a large file.
      try { void reply?.body?.cancel().catch(() => {}); } catch {}
      if (controller.signal.aborted) throw new Error('Download access check timed out.');
      return reply;
    }), timeout]);
    if (!(response instanceof Response)) throw new Error('Download access did not return an HTTP response.');
    if (response.status !== 200 || response.redirected || response.url && response.url !== VGUARD_DOWNLOAD_URL) throw new Error('Download access returned an unexpected status or redirect.');
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/html' ||
        response.headers.get('X-Vellivex-App-Access') !== 'required') throw new Error('The anonymous download did not require email sign-in.');
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') || '') ||
        response.headers.get('Referrer-Policy') !== 'no-referrer' || response.headers.has('Content-Disposition')) {
      throw new Error('The download sign-in gate did not meet its privacy policy.');
    }
    return {gate: 'pass',apkIntegrity: 'not-run',signature: 'not-run',android: 'not-run'};
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function runVGuardDownloadAccess({summaryPath = process.env.GITHUB_STEP_SUMMARY, log = console.log, ...options} = {}) {
  await checkVGuardDownloadAccess(options);
  log('PASS VGuard: anonymous installer download requires the uncached email sign-in gate.');
  log(APK_NOT_RUN);
  if (summaryPath) await appendFile(summaryPath, 'VGuard download access: PASS.\n\n' + APK_NOT_RUN + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runVGuardDownloadAccess(); }
  catch (error) { console.error('FAIL VGuard download access: ' + error.message); process.exitCode = 1; }
}
