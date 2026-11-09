import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, checkPage, checkAll } from '../scripts/live-availability.mjs';

function response({ status = 200, type = 'text/html; charset=utf-8', url = 'https://vkey.vellivex.com/' } = {}) {
  return { status, url, headers: new Headers({ 'content-type': type }), body: { async cancel() {} } };
}

test('availability allowlist contains public HTTPS landing pages only', () => {
  assert.equal(PAGES.length, 9);
  for (const [label, url] of PAGES) {
    assert.ok(label);
    assert.equal(new URL(url).protocol, 'https:');
    assert.ok(!new URL(url).search && !new URL(url).hash);
    assert.ok(!/\/api\//.test(url));
  }
});

test('availability check passes only matching-origin HTML 200', async () => {
  const result = await checkPage('VKey', 'https://vkey.vellivex.com/', {
    fetcher: async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      return response({ url });
    },
  });
  assert.equal(result.ok, true);
});

test('availability check rejects redirects, challenges, non-HTML and wrong-origin responses', async () => {
  for (const r of [response({ status: 302 }), response({ status: 403 }), response({ type: 'application/json' }), response({ url: 'https://attacker.example/' })]) {
    assert.equal((await checkPage('VKey','https://vkey.vellivex.com/',{fetcher: async()=>r})).ok,false);
  }
});

test('availability check network errors fail closed without leaking error details', async () => {
  const result = await checkPage('VKey','https://vkey.vellivex.com/',{fetcher:async()=>{throw new Error('secret network details')}});
  assert.deepEqual(result, { name: 'VKey', ok: false, status: null, problem: 'Network error' });
});

test('availability check refuses credentials, fragments and query parameters', async () => {
  for (const uri of ['http://example.com/', 'https://user:password@example.com/', 'https://example.com/?token=secret', 'https://example.com/#secret']) {
    await assert.rejects(checkPage('Unsafe', uri), TypeError);
  }
});

test('availability aggregate checks are sequential and bounded', async () => {
  const urls = ['https://vkey.vellivex.com/', 'https://private.vellivex.com/'];
  const seen = [];
  const all = await checkAll({ pages: urls.map((u,i)=>[String(i),u]), fetcher: async url => { seen.push(url); return response({url}); } });
  assert.deepEqual(seen,urls);
  assert.deepEqual(all.map(v=>v.ok),[true,true]);
});
