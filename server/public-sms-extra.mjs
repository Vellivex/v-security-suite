// SPDX-License-Identifier: GPL-3.0-or-later
// Production extra-provider adapter retained for regression-tested live repairs.
export function createExtraPublicSmsApi(options = {}) {
  const fetcher = options.fetcher ?? ((...args) => fetch(...args));
  const now = options.now ?? (() => Date.now());
  const monotonic = options.monotonic ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? 8000;
  const ttlMs = options.ttlMs ?? 60000;
  const cooldownMs = options.cooldownMs ?? 500;
  const encoder = new TextEncoder();
  const cache = new Map(), pendingViews = new Map(), pendingSources = new Map();
  let networkOwner = null, networkNotBefore = 0, activeCalls = 0;
  const restrictions = 'Public, shared inboxes for adults aged 18 or over. Never use for banking, finance, payments, government, identity checks, account recovery, ban evasion, unlawful activity or deceptive bulk accounts. Do not overload or resell the provider service. Delivery and service acceptance are not guaranteed. Provider masking is preserved. Full terms: https://getvirtualphonenumber.com/terms';
  class ExtraSmsProblem extends Error {
    constructor(status, code, retryAfter = 0) { super(code); this.status = status; this.code = code; this.retryAfter = retryAfter; }
  }
  const problem = (status = 503, code = 'unavailable', retryAfter = 0) => new ExtraSmsProblem(status, code, retryAfter);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const countryCode = value => typeof value === 'string' && /^[a-z]{2}$/.test(value);
  const national = value => typeof value === 'string' && /^[0-9]{4,15}$/.test(value);
  const text = (value, limit) => typeof value === 'string' && value.isWellFormed() && encoder.encode(value).byteLength <= limit;
  const date = value => text(value, 48) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
  const instant = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw problem(); return value; };
  function respond(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), { status, headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...extra
    } });
  }
  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    const age = instant() - entry.checkedAt;
    if (age < 0 || age >= ttlMs) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, entry); return entry;
  }
  function remember(key, data) {
    const entry = { checkedAt: instant(), data };
    cache.delete(key); cache.set(key, entry);
    while (cache.size > 64) cache.delete(cache.keys().next().value);
    return entry;
  }
  function normalizeCountries(source) {
    if (!object(source) || !Array.isArray(source.countries) || source.countries.length > 100) throw problem();
    const result = [], seen = new Set();
    for (const item of source.countries) {
      if (!object(item) || !countryCode(item.country_code) || !text(item.country, 100) || !item.country.trim() ||
          typeof item.dial_code !== 'string' || !/^\+[1-9][0-9]{0,3}$/.test(item.dial_code) ||
          !Number.isSafeInteger(item.numbers_online) || item.numbers_online < 0 || item.numbers_online > 1000000 || seen.has(item.country_code)) throw problem();
      seen.add(item.country_code);
      if (item.numbers_online > 0) result.push({ code: item.country_code, name: item.country, dialCode: item.dial_code.slice(1) });
    }
    return result;
  }
  function normalizeNumbers(source, country) {
    if (!object(source) || !Array.isArray(source.numbers) || source.numbers.length > 1000 || source.status !== 'online') throw problem();
    const result = [], seen = new Set();
    for (const item of source.numbers) {
      if (result.length >= 500) break;
      if (!object(item) || item.online !== true || item.country_code !== country.code || item.country !== country.name || item.dial_code !== '+' + country.dialCode ||
          typeof item.number !== 'string' || !/^\+[1-9][0-9]{5,14}$/.test(item.number) || !item.number.startsWith('+' + country.dialCode) ||
          (item.last_sms !== null && !date(item.last_sms))) continue;
      const number = item.number.slice(1 + country.dialCode.length);
      if (!national(number) || seen.has(number)) continue;
      seen.add(number); result.push({ national: number, e164: item.number, lastActivity: item.last_sms === null ? 'No recorded SMS' : item.last_sms });
    }
    return result;
  }
  function normalizeMessages(source, selected) {
    if (!object(source) || source.number !== selected.e164 || !Array.isArray(source.messages) || source.messages.length > 1000) throw problem();
    // This provider can return its own fetch-failure notice as a senderless SMS.
    // Fail the inbox before caching or truncation; it is not a received message.
    if (source.messages.some(item => object(item) && (item.from === null || item.from === '') &&
        item.text === 'Failed to fetch data. Please try again.')) throw problem();
    const messages = [], seen = new Set(); let omittedMessages = 0;
    for (const [index, item] of source.messages.entries()) {
      const sender = object(item) && item.from === null ? '' : object(item) && Number.isSafeInteger(item.from) ? String(item.from) : item?.from;
      // Provider times are display text, not dates to parse or assign a timezone.
      if (!object(item) || !text(sender, 80) || !text(item.text, 4096) || !item.text.length || !text(item.received, 48) || messages.length >= 10) { omittedMessages++; continue; }
      const fingerprint = JSON.stringify([sender, item.text, item.received]);
      if (seen.has(fingerprint)) { omittedMessages++; continue; }
      seen.add(fingerprint);
      // The provider has no message ID. The bounded source index identifies this view.
      messages.push({ id: String(index), sender, text: item.text, receivedAt: item.received });
    }
    return { messages, omittedMessages };
  }
  async function fetchSource(kind, selector, owner, normalize) {
    const remaining = owner.deadline - monotonic();
    if (!Number.isFinite(remaining) || remaining <= 0) throw problem();
    const key = kind + '|' + selector, hit = cached(key);
    if (hit) return hit;
    if (pendingSources.has(key)) return pendingSources.get(key);
    if (networkOwner && networkOwner !== owner) throw problem(429, 'rate_limited', 2);
    if (!networkOwner && instant() < networkNotBefore) throw problem(429, 'rate_limited', Math.min(300, Math.max(1, Math.ceil((networkNotBefore - instant()) / 1000))));
    if (!networkOwner) owner.networkStartedAt = instant();
    networkOwner = owner;
    const job = (async () => {
      const endpoint = new URL('https://getvirtualphonenumber.com/api/v1/' + kind);
      if (kind === 'numbers') { endpoint.searchParams.set('country', selector); endpoint.searchParams.set('limit', '500'); }
      if (kind === 'sms') { endpoint.searchParams.set('number', selector); endpoint.searchParams.set('limit', '10'); }
      const control = new AbortController(); let timer, reader, complete = false, result;
      const expired = () => control.signal.aborted || monotonic() >= owner.deadline;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { control.abort(); reject(problem()); }, remaining); });
      const work = async () => {
        result = await fetcher(endpoint.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: control.signal, headers: { Accept: 'application/json' } });
        if (expired()) { try { Promise.resolve(result.body?.cancel()).catch(() => {}); } catch {} throw problem(); }
        if (result.status === 429) {
          const supplied = result.headers.get('retry-after');
          const wait = supplied && /^\d{1,3}$/.test(supplied) ? Math.min(300, Math.max(2, Number(supplied))) : 60;
          networkNotBefore = Math.max(networkNotBefore, instant() + wait * 1000); throw problem(429, 'rate_limited', wait);
        }
        const length = result.headers.get('content-length');
        if (result.status !== 200 || result.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
            (length !== null && (!/^\d{1,7}$/.test(length) || Number(length) > 262144)) || !result.body) throw problem();
        reader = result.body.getReader(); const chunks = []; let size = 0, count = 0;
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          if (!(item.value instanceof Uint8Array) || ++count > 4096 || (size += item.value.byteLength) > 262144) throw problem();
          chunks.push(item.value.slice());
        }
        complete = true;
        if (expired()) throw problem();
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const data = normalize(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (expired()) throw problem();
        return remember(key, data);
      };
      try { return await Promise.race([work(), deadline]); }
      catch (error) { if (error instanceof ExtraSmsProblem) throw error; throw problem(); }
      finally {
        clearTimeout(timer); control.abort();
        if (!complete) { try { Promise.resolve(reader ? reader.cancel() : result?.body?.cancel()).catch(() => {}); } catch {} }
        try { reader?.releaseLock(); } catch {}
      }
    })();
    pendingSources.set(key, job);
    try { return await job; } finally { if (pendingSources.get(key) === job) pendingSources.delete(key); }
  }
  async function resolveView(countryCode, number, owner) {
    const catalogue = await fetchSource('countries', '', owner, normalizeCountries);
    const countries = catalogue.data;
    const country = countries.find(item => item.code === (countryCode || 'gb')) ?? (!countryCode ? countries[0] : null);
    if (countryCode && !country) throw problem(400, 'invalid_request');
    const base = { provider: 'GetVirtualPhoneNumber', checkedAt: catalogue.checkedAt, countries, country: country?.code ?? '', numbers: [], number: null, messages: [], restrictions, omittedMessages: 0 };
    if (!country) return base;
    const inventory = await fetchSource('numbers', country.code, owner, source => normalizeNumbers(source, country));
    base.checkedAt = Math.min(base.checkedAt, inventory.checkedAt); base.numbers = inventory.data;
    const selected = number ? inventory.data.find(item => item.national === number) : inventory.data[0];
    if (number && !selected) throw problem(404, 'not_found');
    if (!selected) return base;
    const inbox = await fetchSource('sms', selected.e164, owner, source => normalizeMessages(source, selected));
    return { ...base, checkedAt: Math.min(base.checkedAt, inbox.checkedAt), number: selected.national, ...inbox.data };
  }
  return async function extraPublicSmsRequest(request) {
    let owner;
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/api/public-sms-extra') return respond({ error: 'not_found' }, 404);
      if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      if (url.protocol !== 'https:' || url.hash || url.search.length > 128 || request.body !== null || request.headers.has('transfer-encoding') ||
          (request.headers.has('content-length') && request.headers.get('content-length') !== '0') ||
          (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')) throw problem(400, 'invalid_request');
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw problem(403, 'origin_not_allowed');
      const names = [...url.searchParams.keys()];
      if (names.length > 2 || new Set(names).size !== names.length || names.some(name => !['country', 'number'].includes(name))) throw problem(400, 'invalid_request');
      const country = url.searchParams.get('country') ?? '', number = url.searchParams.get('number') ?? '';
      if ((url.searchParams.has('country') && !countryCode(country)) || (url.searchParams.has('number') && (!national(number) || !country))) throw problem(400, 'invalid_request');
      if (activeCalls >= 128) throw problem(429, 'rate_limited', 2);
      activeCalls++; owner = { deadline: monotonic() + timeoutMs, networkStartedAt: null };
      const key = country + '|' + number; let job = pendingViews.get(key);
      if (!job) {
        if (pendingViews.size >= 64) throw problem(429, 'rate_limited', 2);
        job = resolveView(country, number, owner); pendingViews.set(key, job);
        job.finally(() => { if (pendingViews.get(key) === job) pendingViews.delete(key); }).catch(() => {});
      }
      return respond(await job);
    } catch (error) {
      const safe = error instanceof ExtraSmsProblem ? error : problem();
      return respond({ error: safe.code, ...(safe.retryAfter ? { retryAfter: safe.retryAfter } : {}) }, safe.status, safe.retryAfter ? { 'Retry-After': String(safe.retryAfter) } : {});
    } finally {
      if (owner) {
        activeCalls--;
        if (networkOwner === owner) {
          networkOwner = null;
          try { networkNotBefore = Math.max(networkNotBefore, owner.networkStartedAt + cooldownMs); } catch { networkNotBefore = Number.MAX_SAFE_INTEGER; }
        }
      }
    }
  };
}
