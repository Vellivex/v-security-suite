import test from 'node:test';
import assert from 'node:assert/strict';
import {transformSiteResponse} from '../server/app-access/site-overlay.mjs';

const ACCESS_NOTE = 'You can read this guide without signing in. Opening VVault may ask for an email code.';
const REPORT_HELP = 'For file-saving tests, tell us whether the download started, whether it was saved in Downloads or another folder (or could not be found), and whether you reopened that actual file. Leave out full file paths, filenames, file contents and passphrases.';
const htmlResponse = (html, headers = {}, status = 200) => new Response(html, {status, headers: {
  'Content-Type':'text/html; charset=utf-8', 'Content-Length':String(Buffer.byteLength(html)),
  ETag:'"before-copy"', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; form-action 'self'",
  'Cache-Control':'public, max-age=120', ...headers,
}});
const apply = (path, response, method = 'GET', origin = 'https://www.vellivex.com') =>
  transformSiteResponse(new Request(origin + path, {method}), response);
const render = async (path, html) => (await apply(path, htmlResponse(html))).text();

function withoutCommunityCopy(html) {
  return html.replace(/<p class="fine" id="vellivex-vvault-access-note-\d+">[^<]*<\/p>/g, '')
    .replace(/ aria-describedby="vellivex-vvault-access-note-\d+"/g, '')
    .replace(/<li id="vellivex-file-test-checks">[^<]*<\/li>/g, '')
    .replace(/<small id="vellivex-file-report-help">[^<]*<\/small>/g, '')
    .replace(/ aria-describedby="vellivex-file-report-help"/g, '');
}

// Selected sections of the public HTML captured on 18 November 2026. The
// deployed guide includes the seven-step saved-file task absent from pages.js.
const FIRST_TASK = "<section class=\"panel\" aria-labelledby=\"first-vvault-test\"><span class=\"tag\">FIRST TASK / VVAULT</span><h2 id=\"first-vvault-test\">Can you reopen the note you encrypted?</h2><p>Use a made-up sentence and a fresh disposable passphrase. The test covers the saved file, the recovered text and the wrong-passphrase response. No independent security audit has been completed.</p><ol><li>Open VVault and record the app version, device, OS and browser. Choose <strong>Encrypt a message</strong> and enter fictional text, such as “The paper kite is blue.”</li><li>Enter and confirm a fresh test passphrase of at least 14 characters. Select <strong>Encrypt on this device</strong>, then <strong>Save encrypted file</strong>. Check that the download exists before leaving the tab.</li><li>Open VRelay. Select <strong>Load a .vvault file (optional)</strong> and choose that actual download. Select <strong>Check package format</strong>, then <strong>Copy package</strong>.</li><li>Return to VVault. First choose <strong>Unlock an encrypted package</strong>, then paste the package copied from the file. Enter the original test passphrase and select <strong>Unlock on this device</strong>.</li><li>Compare every character with your original fictional text, including spaces and punctuation.</li><li>Select <strong>Clear session</strong>. Paste the file-derived package into unlock mode again, reloading it through VRelay if needed, and try a wrong test passphrase. Check that the note is not revealed.</li><li>Report PASS, FAIL or BLOCKED with the exact step and your device/browser. If saving or loading fails, report that step instead of substituting the original on-screen package.</li></ol><div class=\"actions\"><a class=\"button\" href=\"/blog/test-local-message-encryption\">Read the detailed VVault steps ↗</a><a class=\"button secondary\" href=\"/apps/vault\">Open VVault ↗</a><a class=\"text-link\" href=\"/feedback?product=VVault&amp;kind=test\">Report this VVault test ↗</a></div><p class=\"fine\">The tools clear their session when hidden or after two minutes without input. Save or copy the encrypted package before switching. Keep the passphrase separate; leave all test contents out of feedback.</p></section>";
const VVAULT_CARD = "<article class=\"product\"><span class=\"tag\">VVault</span><h3>Save, reopen, then unlock</h3><p>Start with the fictional test below. Save the encrypted file, load that file in VRelay, then unlock its copied package in VVault. Compare the text and check a wrong passphrase.</p><div class=\"actions\"><a class=\"button small\" href=\"/apps/vault\">Open VVault</a><a class=\"text-link\" href=\"/blog/test-local-message-encryption\">Read the steps ↗</a></div><p><a href=\"/feedback?product=VVault&kind=test\">Report this test ↗</a></p></article>";
const VRELAY_CARD = "<article class=\"product\"><span class=\"tag\">VRelay</span><h3>Check and transfer a package</h3><p>Load a saved fictional VVault package or paste its encrypted text. Check its format, then copy, save or share it. Never enter a passphrase in VRelay. A format check does not authenticate a sender or verify the contents.</p><div class=\"actions\"><a class=\"button small\" href=\"/apps/relay\">Open VRelay</a><a class=\"text-link\" href=\"/blog/transfer-ciphertext-without-sharing-the-passphrase\">Read the steps ↗</a></div><p><a href=\"/feedback?product=VRelay&kind=test\">Report this test ↗</a></p></article>";
const REPORT_SECTION = "<section class=\"panel\"><h2>Make your report reproducible</h2><ol><li>Choose the product and “Device test result” in the feedback form.</li><li>Include app version, device, OS and browser version.</li><li>Write the task, exact steps, expected result and actual result. State PASS, FAIL or BLOCKED and whether you reopened an actual saved file.</li><li>Keep the confirmation reference so you can identify the result later.</li></ol><p>Use fictional examples only. Do not include private messages, encrypted packages, keys, passphrases, account details or personal traffic logs. Reports are stored privately; do not assume they are anonymous. For vulnerability details, use the <a href=\"/security\">security reporting route</a>.</p><a class=\"button\" href=\"/feedback?kind=test\">Send a test result ↗</a></section>";
const FEEDBACK_FORM = "<form id=\"feedback-form\" class=\"panel\"><div class=\"fields-two\"><label class=\"field\"><span>Product</span><select name=\"product\" required><option value=\"VGuard\">VGuard</option><option value=\"VVault\">VVault</option><option value=\"VRelay\">VRelay</option><option value=\"VCipher\">V Cipher</option><option value=\"VMail\">VMail</option><option value=\"VNumber\">VNumber</option><option value=\"Website\">Website</option></select></label><label class=\"field\"><span>Report type</span><select name=\"kind\" required><option value=\"bug\">Bug or unexpected behaviour</option><option value=\"idea\">Improvement idea</option><option value=\"test\">Device test result</option><option value=\"security\">Security issue (private)</option><option value=\"deletion\">Delete an earlier report</option></select></label></div><label class=\"field\"><span>Device operating system</span><select name=\"os\" required><option value=\"Android\">Android</option><option value=\"iPhone/iPad\">iPhone / iPad</option><option value=\"Desktop\">Desktop browser</option><option value=\"Other\">Other / not applicable</option></select></label><label class=\"field\"><span>Your feedback</span><textarea name=\"message\" required minlength=\"20\" maxlength=\"3000\" placeholder=\"Tool version and OS version; expected result; actual result; steps to reproduce. Use test data only.\"></textarea><small>20–3,000 characters. For deletion, include the reference shown after your original submission.</small></label><label class=\"honeypot\" aria-hidden=\"true\">Website<input name=\"website\" tabindex=\"-1\" autocomplete=\"off\"></label><label class=\"check\"><input type=\"checkbox\" name=\"safe\" required><span>I have removed passwords, keys, personal details and sensitive content. I understand this report is saved privately as described in the <a href=\"/privacy\"><u>privacy information</u></a>.</span></label><button id=\"feedback-submit\" class=\"button\" type=\"submit\">Send private report ↗</button><p id=\"feedback-status\" class=\"status\" role=\"status\" aria-live=\"polite\"></p></form>";

const TESTING_SECTIONS = FIRST_TASK + VVAULT_CARD + VRELAY_CARD + REPORT_SECTION;

test('captured guide gets visible, associated email expectations beside both VVault entry points', async () => {
  const html = await render('/testing', TESTING_SECTIONS);
  assert.equal(html.split(ACCESS_NOTE).length - 1, 2);
  const links = [...html.matchAll(/<a\b[^>]*href="\/apps\/vault"[^>]*>Open VVault(?: ↗)?<\/a>/g)];
  assert.equal(links.length, 2);
  for (const [index, link] of links.entries()) {
    const id = 'vellivex-vvault-access-note-' + (index + 1);
    assert.ok(link[0].includes('aria-describedby="' + id + '"'));
    assert.ok(html.includes('</div><p class="fine" id="' + id + '">' + ACCESS_NOTE + '</p>'));
  }
  const task = html.match(/<section class="panel" aria-labelledby="first-vvault-test">[\s\S]*?<\/section>/)[0];
  assert.equal((task.match(/<li>/g) || []).length, 7);
  assert.ok(html.includes(VRELAY_CARD));
  assert.equal(withoutCommunityCopy(html), TESTING_SECTIONS);
});

test('guide asks for download start, folder category and reopening without asking for private paths or contents', async () => {
  const html = await render('/testing?source=community', TESTING_SECTIONS);
  assert.ok(html.includes('<li id="vellivex-file-test-checks">' + REPORT_HELP + '</li><li>Keep the confirmation reference'));
  assert.match(REPORT_HELP, /whether the download started/);
  assert.match(REPORT_HELP, /Downloads or another folder \(or could not be found\)/);
  assert.match(REPORT_HELP, /whether you reopened that actual file/);
  assert.match(REPORT_HELP, /Leave out full file paths, filenames, file contents and passphrases/);
  assert.ok(html.includes('Reports are stored privately; do not assume they are anonymous.'));
});

test('captured feedback form adds one visible description below the message without changing fields or submission controls', async () => {
  const html = await render('/feedback?product=VVault&kind=test', FEEDBACK_FORM);
  assert.ok(html.includes('aria-describedby="vellivex-file-report-help"'));
  assert.ok(html.includes('</textarea><small id="vellivex-file-report-help">' + REPORT_HELP + '</small><small>20–3,000 characters.'));
  assert.equal(withoutCommunityCopy(html), FEEDBACK_FORM);
  const names = source => [...source.matchAll(/\sname="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(names(html), ['product', 'kind', 'os', 'message', 'website', 'safe']);
  assert.equal(html.split(REPORT_HELP).length - 1, 1);
  assert.equal(html.includes(ACCESS_NOTE), false);
});

test('copy is idempotent on both public origins, including query parameters and trailing slashes', async () => {
  for (const origin of ['https://www.vellivex.com', 'https://vellivex.com']) {
    for (const [path, source] of [['/testing/?from=forum', TESTING_SECTIONS], ['/feedback?product=VVault&kind=test', FEEDBACK_FORM]]) {
      const first = await apply(path, htmlResponse(source), 'GET', origin);
      const html = await first.clone().text();
      assert.equal(first.headers.get('ETag'), null);
      assert.equal(first.headers.get('Content-Length'), null);
      assert.equal(first.headers.get('Cache-Control'), 'public, max-age=120');
      assert.equal(first.headers.get('Content-Security-Policy'), "default-src 'self'; script-src 'self'; form-action 'self'");
      const second = await apply(path, first, 'GET', origin);
      assert.equal(second, first);
      assert.equal(await second.text(), html);
    }
  }
});

test('existing accessible descriptions and quoted attributes survive the new descriptions', async () => {
  const actions = '<div class="actions"><a title="Save > reopen" aria-describedby=\'existing-help\' href="/apps/vault">Open VVault</a></div>';
  const guide = await render('/testing', actions);
  assert.ok(guide.includes('title="Save > reopen" aria-describedby=\'existing-help vellivex-vvault-access-note-1\''));
  assert.equal(await render('/testing', guide), guide);
  const form = '<form id=\'feedback-form\'><textarea aria-describedby=\'existing-limit\' name=\'message\'>Keep this fictional text exactly.</textarea></form>';
  const feedback = await render('/feedback', form);
  assert.ok(feedback.includes('aria-describedby=\'existing-limit vellivex-file-report-help\''));
  assert.ok(feedback.includes('>Keep this fictional text exactly.</textarea>'));
  assert.equal(await render('/feedback', feedback), feedback);
});

test('comments, scripts, styles, examples and templates containing target markup are byte-preserved', async () => {
  const embedded = TESTING_SECTIONS + FEEDBACK_FORM;
  const examples = '<!--' + embedded + '-->' +
    '<script type="application/json">' + JSON.stringify({example:embedded}) + '</script>' +
    '<style>/* ' + embedded + ' */</style>' +
    '<pre>' + embedded + '</pre><code>' + embedded + '</code><template>' + embedded + '</template>' +
    '<textarea name="example">' + FIRST_TASK + '<form id="feedback-form"></form></textarea>';
  for (const path of ['/testing', '/feedback']) {
    const html = await render(path, examples + embedded);
    assert.ok(html.startsWith(examples));
    assert.equal(withoutCommunityCopy(html.slice(examples.length)), embedded);
    assert.equal(withoutCommunityCopy(html), examples + embedded);
  }
});

test('feedback respects form boundaries and preserves literal textarea contents and unrelated textareas', async () => {
  const outside = '<textarea name="message">Outside the form.</textarea>';
  const otherForm = '<form id="another-form"><textarea name="message">Another form.</textarea></form>';
  const otherField = '<textarea name="notes">Another field.</textarea>';
  const contents = '<form id="feedback-form"></form><div class="actions"><a href="/apps/vault">Open VVault</a></div> &amp; fictional text';
  const feedback = '<form id="feedback-form">' + otherField + '<textarea name="message">' + contents + '</textarea></form>';
  const original = outside + otherForm + feedback + outside;
  const html = await render('/feedback', original);
  assert.ok(html.startsWith(outside + otherForm));
  assert.ok(html.endsWith(outside));
  assert.ok(html.includes(otherField));
  assert.ok(html.includes('>' + contents + '</textarea>'));
  assert.equal(html.split(REPORT_HELP).length - 1, 1);
  assert.equal(withoutCommunityCopy(html), original);
});

test('community copy stays off other routes and preserves unsupported responses untouched', async () => {
  const source = TESTING_SECTIONS + FEEDBACK_FORM;
  for (const path of ['/security', '/privacy', '/source', '/blog/example', '/apps/vault', '/offline/vault.html', '/testing-extra', '/feedback-extra']) {
    const response = htmlResponse(source);
    assert.equal(await apply(path, response), response, path);
    assert.equal(response.bodyUsed, false);
  }
  for (const path of ['/testing', '/feedback']) {
    for (const method of ['POST', 'HEAD']) {
      const response = htmlResponse(source);
      assert.equal(await apply(path, response, method), response);
    }
    for (const response of [htmlResponse(source, {'Content-Encoding':'gzip'}), htmlResponse(source, {'Content-Type':'application/json'}), htmlResponse(source, {}, 503)]) {
      assert.equal(await apply(path, response), response);
    }
    const foreign = htmlResponse(source);
    assert.equal(await apply(path, foreign, 'GET', 'https://private.vellivex.com'), foreign);
  }
  assert.equal((await render('/testing', source)).includes('id="vellivex-file-report-help"'), false);
  assert.equal((await render('/feedback', source)).includes('id="vellivex-vvault-access-note-1"'), false);
});

test('unrecognised controls and external lookalike links do not acquire copy or lose validators', async () => {
  const source = '<div class="actions"><a href="https://example.com/apps/vault">Open VVault</a></div>' +
    '<a href="/apps/vault">Open VVault</a><textarea name="message">No feedback form.</textarea>' +
    '<section><h2>Make your report reproducible</h2><ol><li>Different template.</li></ol></section>';
  for (const path of ['/testing', '/feedback']) {
    const response = htmlResponse(source);
    assert.equal(await apply(path, response), response);
    assert.equal(response.headers.get('ETag'), '"before-copy"');
    assert.equal(response.bodyUsed, false);
  }
});
