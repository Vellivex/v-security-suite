import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, BRAND_ICONS, APP_FAVICONS, checkPage, checkAll, checkSvg, checkBrandIcons, checkAppFavicons } from '../scripts/live-availability.mjs';

function response({ status = 200, type = 'text/html; charset=utf-8', url = 'https://vkey.vellivex.com/', headers = {'X-Vellivex-App-Access':'required','Cache-Control':'no-store','Referrer-Policy':'no-referrer'} } = {}) {
  return { status, url, headers: new Headers({ 'content-type': type, ...headers }), body: { async cancel() {} } };
}

test('availability allowlist covers all eleven public apps and the two site pages', () => {
  assert.deepEqual(PAGES.map(([, url]) => url).sort(), [
    'https://call.vellivex.com/call.html',
    'https://private.vellivex.com/',
    'https://vdecoy.vellivex.com/',
    'https://vkey.vellivex.com/',
    'https://vphone.vellivex.com/',
    'https://www.vellivex.com/',
    'https://www.vellivex.com/apps/cipher',
    'https://www.vellivex.com/apps/guard',
    'https://www.vellivex.com/apps/mail',
    'https://www.vellivex.com/apps/relay',
    'https://www.vellivex.com/apps/sms',
    'https://www.vellivex.com/apps/vault',
    'https://www.vellivex.com/testing',
  ]);
  for (const [label, url] of PAGES) {
    assert.ok(label);
    assert.equal(new URL(url).protocol, 'https:');
    assert.ok(!new URL(url).search && !new URL(url).hash);
    assert.ok(!/\/api\//.test(url));
  }
});

test('availability check distinguishes the expected sign-in gate from app functionality', async () => {
  const result = await checkPage('VKey', 'https://vkey.vellivex.com/', {
    fetcher: async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      return response({ url });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.availability,'sign-in-required');
  assert.equal(result.appTested,false);
});

test('a generic HTML success, authenticated marker or cacheable gate is not healthy anonymous app admission',async()=>{
  for(const headers of [{},{'X-Vellivex-App-Access':'verified'},{'X-Vellivex-App-Access':'required'},
    {'X-Vellivex-App-Access':'required','Cache-Control':'public, max-age=3600','Referrer-Policy':'no-referrer'},
    {'X-Vellivex-App-Access':'required','Cache-Control':'no-store','Referrer-Policy':'origin'}]){
    const result=await checkPage('VKey','https://vkey.vellivex.com/',{fetcher:async()=>response({headers})});
    assert.equal(result.ok,false);assert.equal(result.appTested,false);
  }
  const wrongPath=await checkPage('VKey','https://vkey.vellivex.com/',{fetcher:async()=>response({url:'https://vkey.vellivex.com/access'})});
  assert.equal(wrongPath.ok,false);
});

test('public information remains available without being reported as an app test',async()=>{
  const url='https://www.vellivex.com/';
  const result=await checkPage('Website',url,{fetcher:async()=>response({url,headers:{}})});
  assert.equal(result.ok,true);assert.equal(result.availability,'public-page');assert.equal(result.appTested,false);
  assert.equal((await checkPage('Website',url,{fetcher:async()=>response({url})})).ok,false);
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


test('five distinct Vellivex app icons are HTTPS SVG resources', () => {
  assert.equal(BRAND_ICONS.length, 5);
  assert.equal(new Set(BRAND_ICONS.map(x => x[1])).size, 5);
  for (const [name, url] of BRAND_ICONS) {
    assert.ok(name.includes('icon'));
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://www.vellivex.com');
    assert.match(parsed.pathname, /^\/brand\/apps\/[a-z-]+\.svg$/);
  }
});

test('app icon check requests the SVG without credentials and accepts HTTP 200', async () => {
  const url = BRAND_ICONS[0][1];
  const result = await checkSvg('Vellivex Call icon', url, {
    fetcher: async (uri, init) => {
      assert.equal(uri, url);
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Accept, 'image/svg+xml');
      return response({ url, type: 'image/svg+xml; charset=utf-8' });
    },
  });
  assert.equal(result.ok, true);
});

test('app icon check rejects missing assets, redirects, wrong types and locations', async () => {
  const url = BRAND_ICONS[0][1];
  for (const sample of [
    response({ url, status: 404, type: 'image/svg+xml' }),
    response({ url, status: 302, type: 'image/svg+xml' }),
    response({ url, type: 'text/html' }),
    response({ url: 'https://other.example/brand/apps/call.svg', type: 'image/svg+xml' }),
  ]) {
    assert.equal((await checkSvg('Call icon', url, { fetcher: async () => sample })).ok, false);
  }
  await assert.rejects(checkSvg('Invalid', 'https://www.vellivex.com/brand/apps/call.svg?token=secret'), TypeError);
});

test('app icon check keeps error details private and checks known icons sequentially', async () => {
  const urls = BRAND_ICONS.slice(0, 2);
  const seen = [];
  const values = await checkBrandIcons({ icons: urls, fetcher: async url => {
    seen.push(url);
    return response({url, type:'image/svg+xml'});
  } });
  assert.deepEqual(seen, urls.map(x => x[1]));
  assert.deepEqual(values.map(x => x.ok), [true, true]);
  const failed = await checkSvg('VKey icon', BRAND_ICONS[3][1], {
    fetcher: async () => { throw new Error('Untrusted remote failure with secret URL'); },
  });
  assert.equal(failed.problem, 'Network error');
});


test('five application browser icons have fixed, separate HTTPS URLs', () => {
  assert.equal(APP_FAVICONS.length,5);
  assert.equal(new Set(APP_FAVICONS.map(x=>x[1])).size,5);
  for (const [name,url] of APP_FAVICONS) {
    assert.match(name,/favicon/);
    const u=new URL(url);
    assert.equal(u.protocol,'https:');
    assert.equal(u.search,'');
    assert.equal(u.hash,'');
    assert.match(u.pathname,/\.svg$/);
  }
});

test('app browser icon checks accept only the exact five fixed URLs', async () => {
  for (const [name,url] of APP_FAVICONS) {
    const result=await checkSvg(name,url,{fetcher: async (actual,init)=>{
      assert.equal(actual,url);
      assert.equal(init.credentials,'omit');
      assert.equal(init.method,'GET');
      assert.equal(init.redirect,'manual');
      return response({url,type:'image/svg+xml; charset=utf-8'});
    }});
    assert.equal(result.ok,true);
  }
  for (const target of [
    'https://vkey.vellivex.com/favicon.svg?secret=true',
    'https://vkey.vellivex.com/internal',
    'http://vkey.vellivex.com/favicon.svg',
    'https://private.vellivex.com/api/rooms',
  ]) {
    await assert.rejects(checkSvg('Invalid icon',target),TypeError);
  }
});

test('app browser icon list is bounded, fail-closed and read-only', async () => {
  const icons=APP_FAVICONS.slice(0,2);
  const seen=[];
  const results=await checkAppFavicons({icons,fetcher:async url=>{
    seen.push(url);
    return response({url,type:'image/svg+xml',status:url===icons[0][1]?200:404});
  }});
  assert.deepEqual(seen,icons.map(x=>x[1]));
  assert.deepEqual(results.map(x=>x.ok),[true,false]);
});
