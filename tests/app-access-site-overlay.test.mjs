import test from 'node:test';
import assert from 'node:assert/strict';
import {page} from '../server/pages.js';
import {ACCESS_PRIVACY_HTML, transformSiteResponse} from '../server/app-access/site-overlay.mjs';

const UPSTREAM = 'https://vellivex-disposable-mail-pilot.vellivex-call.workers.dev';
const CSP = `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self' ${UPSTREAM}; frame-src https://challenges.cloudflare.com; form-action 'none'`;
const htmlResponse = (html, headers = {}) => new Response(html, {headers:{'Content-Type':'text/html; charset=utf-8', 'Content-Length':String(Buffer.byteLength(html)), ETag:'"current"', 'Cache-Control':'public, max-age=120', 'Content-Security-Policy':CSP, 'X-Existing':'preserved', ...headers}});
const apply = (path, response, method = 'GET', origin = 'https://www.vellivex.com') => transformSiteResponse(new Request(origin + path, {method}), response);

test('public navigation gets one central account link and root Call links open the gated Call app', async () => {
  const original = page('/').replace('</main>', '<a class="call-card" href="https://call.vellivex.com">Call</a><a href=\'https://call.vellivex.com/\'>Call again</a><a href="https://call.vellivex.com/call.html">Already correct</a><a href="https://call.vellivex.com/?owner=1">Owner link</a></main>');
  const result = await apply('/', htmlResponse(original));
  const html = await result.clone().text();
  assert.equal((html.match(/data-app-access-link="true"/g) || []).length, 1);
  assert.match(html, /href="https:\/\/call\.vellivex\.com\/access" data-app-access-link="true">Sign in \/ account<\/a>/);
  assert.equal((html.match(/href=["']https:\/\/call\.vellivex\.com\/call\.html["']/g) || []).length, 3);
  assert.match(html, /href="https:\/\/call\.vellivex\.com\/\?owner=1"/);
  assert.equal(result.headers.get('ETag'), null);
  assert.equal(result.headers.get('Content-Length'), null);
  assert.equal(result.headers.get('Cache-Control'), 'public, max-age=120');
  assert.equal(result.headers.get('Content-Security-Policy'), CSP);
  assert.equal(result.headers.get('X-Existing'), 'preserved');
  const again = await apply('/', result);
  assert.equal(await again.text(), html);
  assert.equal((html.match(/<script\b/g) || []).length, (original.match(/<script\b/g) || []).length);
});

test('privacy adds precise email, separate optional consent and local-data copy while retaining all original content', async () => {
  const original = page('/privacy');
  const result = await apply('/privacy', htmlResponse(original));
  const html = await result.clone().text();
  assert.ok(html.includes(ACCESS_PRIVACY_HTML));
  assert.match(html, /checkbox starts unticked/);
  assert.match(html, /does not upload, synchronise, recover or clear existing local app files, keys or recordings/);
  assert.match(html, /up to 30 days/);
  assert.match(html, /separate from account security and payments/);
  const withoutAdditions = html.replace(ACCESS_PRIVACY_HTML, '').replace(/<a href="https:\/\/call\.vellivex\.com\/access" data-app-access-link="true">Sign in \/ account<\/a>/, '');
  assert.equal(withoutAdditions, original);
  const second = await apply('/privacy', result);
  assert.equal(await second.text(), html);
});

test('public marketing pages use the shared navigation, including blog articles', async () => {
  for (const path of ['/source', '/beta', '/trust', '/testing', '/feedback', '/privacy/', '/blog/a-guide']) {
    const result = await apply(path, htmlResponse(page('/')));
    assert.match(await result.text(), /data-app-access-link="true"/);
  }
});

test('Mail changes only its connect-src upstream and preserves all Turnstile permissions and HTML bytes', async () => {
  const original = '<!doctype html><html><body><div id="mail-app" data-api-origin="' + UPSTREAM + '">Current release</div></body></html>';
  const result = await apply('/apps/mail', htmlResponse(original));
  assert.equal(await result.text(), original);
  assert.equal(result.headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self'; frame-src https://challenges.cloudflare.com; form-action 'none'");
  assert.equal(result.headers.get('X-Existing'), 'preserved');
  assert.equal(result.headers.get('ETag'), null);
  assert.equal(result.headers.get('Content-Length'), null);
  const onlyUpstream = await apply('/apps/mail', htmlResponse(original, {'Content-Security-Policy':`connect-src ${UPSTREAM} https://challenges.cloudflare.com; img-src ${UPSTREAM}`}));
  assert.equal(onlyUpstream.headers.get('Content-Security-Policy'), `connect-src 'self' https://challenges.cloudflare.com; img-src ${UPSTREAM}`);
});

test('app and offline documents, non-HTML, redirects, POST and foreign origins remain identical responses', async () => {
  for (const path of ['/apps/vault', '/apps/relay', '/apps/cipher', '/apps/sms', '/offline/cipher/vault.html', '/offline/vault.html', '/unknown']) {
    const original = htmlResponse(page('/'));
    assert.equal(await apply(path, original), original, path);
    assert.equal(original.bodyUsed, false);
  }
  const json = new Response('{"unchanged":true}', {headers:{'Content-Type':'application/json'}});
  assert.equal(await apply('/', json), json);
  const redirect = new Response(null, {status:302, headers:{Location:'/apps/vault', 'Content-Type':'text/html'}});
  assert.equal(await apply('/', redirect), redirect);
  const post = htmlResponse(page('/'));
  assert.equal(await apply('/', post, 'POST'), post);
  const foreign = htmlResponse(page('/'));
  assert.equal(await apply('/', foreign, 'GET', 'https://private.vellivex.com'), foreign);
  const compressed = htmlResponse(page('/'), {'Content-Encoding':'gzip'});
  assert.equal(await apply('/', compressed), compressed);
});

test('unrecognised markup and already-correct Mail policy retain body and validators', async () => {
  const original = htmlResponse('<!doctype html><p>Different layout.</p>');
  assert.equal(await apply('/', original), original);
  assert.equal(original.headers.get('ETag'), '"current"');
  assert.equal(original.bodyUsed, false);
  const mail = htmlResponse('<p>Mail</p>', {'Content-Security-Policy':"default-src 'none'; connect-src 'self'"});
  assert.equal(await apply('/apps/mail', mail), mail);
});

test('raw script strings, comments, examples and data-href are not Call navigation', async () => {
  const examples = '<script>const example = `<a href="https://call.vellivex.com/">example</a>`;</script><!-- <a href="https://call.vellivex.com/">comment</a> --><textarea><a href="https://call.vellivex.com/">text</a></textarea><a data-href="https://call.vellivex.com/" href="/source">source</a>';
  const original = htmlResponse(examples);
  const result = await apply('/', original);
  assert.equal(await result.text(), examples);
});
