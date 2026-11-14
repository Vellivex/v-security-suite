// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtraPublicSmsApi } from '../server/public-sms-extra.mjs';

// All fixtures are fictional. Tests never contact a provider or read public SMS.
const number = '+447700900123';
const notice = 'Failed to fetch data. Please try again.';
const message = (text = 'Fictional delivery check', from = null) => ({ from, text, received: '2026-11-14 03:54:00Z' });
const request = () => new Request('https://www.vellivex.com/api/public-sms-extra?country=gb&number=7700900123');
function fixture(messages) {
  const calls = [];
  let current = messages;
  const api = createExtraPublicSmsApi({ now: () => 1794661200000, monotonic: () => 0, cooldownMs: 0,
    fetcher: async (url, options) => {
      const parsed = new URL(url); calls.push({ url: parsed, options });
      let data;
      if (parsed.pathname.endsWith('/countries')) data = { countries: [{ country_code: 'gb', country: 'United Kingdom', dial_code: '+44', numbers_online: 1 }] };
      else if (parsed.pathname.endsWith('/numbers')) data = { status: 'online', numbers: [{ online: true, country_code: 'gb', country: 'United Kingdom', dial_code: '+44', number, last_sms: null }] };
      else if (parsed.pathname.endsWith('/sms')) data = { number, messages: current };
      else throw Error('Unexpected fixture path');
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    }
  });
  return { api, calls, replace: value => { current = value; } };
}
for (const sender of [null, '']) test(`senderless provider failure (${JSON.stringify(sender)}) is unavailable, not SMS`, async () => {
  const f = fixture([message(notice, sender)]), response = await f.api(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.length, 3);
});
test('provider failure in a mixed or truncated page invalidates the whole inbox', async () => {
  for (const count of [1, 11]) {
    const f = fixture([...Array.from({ length: count }, (_, i) => message('Fictional ' + i, 'Example')), message(notice)]);
    const response = await f.api(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
  }
});
test('provider failure is not cached, and one later success recovers normally', async () => {
  const f = fixture([message(notice)]);
  assert.equal((await f.api(request())).status, 503);
  f.replace([message('Fictional recovered delivery', 'Example')]);
  const recovered = await f.api(request());
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).messages.map(m => m.text), ['Fictional recovered delivery']);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/sms')).length, 2);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/countries')).length, 1);
});
test('ordinary senderless messages and a genuine sender quoting the notice remain messages', async () => {
  const f = fixture([message('Fictional senderless delivery'), message(notice, 'Example')]);
  const response = await f.api(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).messages.map(m => [m.sender, m.text]), [['', 'Fictional senderless delivery'], ['Example', notice]]);
});
test('an empty inbox remains a valid empty result and unsupported rows remain omitted', async () => {
  for (const rows of [[], [null, { from: null, text: null, received: '' }]]) {
    const response = await fixture(rows).api(request());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.messages, []);
    assert.equal(data.omittedMessages, rows.length);
  }
});
test('successful responses preserve bounded read-only provider requests and cache reuse', async () => {
  const f = fixture([message('Fictional masked code ***', 'Example')]);
  const first = await f.api(request()), second = await f.api(request());
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), await second.json());
  assert.equal(f.calls.length, 3);
  for (const { url, options } of f.calls) {
    assert.equal(url.origin, 'https://getvirtualphonenumber.com');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Accept, 'application/json');
  }
  assert.equal(f.calls[2].url.searchParams.get('limit'), '10');
});
