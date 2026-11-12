// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {withPhoneShop, PHONE_PRODUCTS, PHONE_SHOP_CSS} from '../server/phone-shop.mjs';
import liveConfig from '../server/phone-shop-config.mjs';

const origin = 'https://www.vellivex.com';
const links = {new:'https://buy.stripe.com/fixtureNew',refurb:'https://buy.stripe.com/fixtureRefurb'};
// Synthetic correspondence address: never a real owner or customer's details.
const seller = {name:'Vellivex Test Supplier',addressLines:['1 Example Street','Test City','ZZ1 1ZZ']};
const sellerEnv = {PHONE_SHOP_SELLER_JSON:JSON.stringify(seller)};
const request = (path, method='GET', host=origin) => new Request(host + path,{method});
const fallback = () => new Response('Preserved application',{headers:{'Content-Type':'text/plain','X-Existing':'yes'}});
const shop = (config={links}, original={fetch:fallback}) => withPhoneShop(original, config);
const html = async (path='/phones', config={links}, env=sellerEnv) => (await shop(config).fetch(request(path),env)).text();
const checkoutHrefs = text => [...text.matchAll(/href="(https:\/\/buy\.stripe\.com[^"\s]*)"/g)].map(match=>match[1]);

test('phone purchase options match the advertised condition, total price and paid preorder contract',async()=>{
  assert.deepEqual(PHONE_PRODUCTS.map(({id,price})=>({id,price})),[{id:'new',price:429},{id:'refurb',price:349}]);
  const catalogue=await html();
  assert.deepEqual(checkoutHrefs(catalogue),[links.new,links.refurb]);
  assert.match(catalogue,/128GB · Obsidian · GrapheneOS/);
  assert.match(catalogue,/Preorder new Pixel 9a for £429/);
  assert.match(catalogue,/Preorder refurbished Pixel 9a for £349/);
  assert.match(catalogue,/opened only to install and configure/);
  assert.match(catalogue,/Cosmetic wear is possible; battery health is at least 80%/);
  assert.match(catalogue,/UK tracked delivery included/);
  assert.match(catalogue,/14 calendar days/);
  assert.match(catalogue,/Paid preorder · prepared to order/);
  assert.match(catalogue,/Vellivex is not VAT registered; no VAT is added/);
  assert.match(catalogue,/International delivery takes longer/);
  assert.match(catalogue,/before paying/);
});

test('physical phone terms preserve cancellation, delivery and beta-app limitations',async()=>{
  const text=await html('/phones/terms');
  assert.match(text,/full amount is paid upfront through Stripe as a preorder/);
  assert.match(text,/within 14 calendar days of payment/);
  assert.match(text,/choose a full refund instead of accepting a revised date/);
  assert.match(text,/within 14 days after receiving the phone/);
  assert.match(text,/another 14 days to send the phone back/);
  assert.match(text,/whichever happens first/);
  assert.match(text,/statutory rights under UK consumer law are unaffected/);
  assert.match(text,/Vellivex apps remain beta; provider calling and SMS are not included/);
  assert.match(text,/Vellivex Test Supplier/);
  assert.match(text,/1 Example Street/);
  const catalogue=await html();
  assert.match(catalogue,/VNumber is a public shared SMS inbox, not private messaging/);
  assert.match(catalogue,/VPhone provider calling and SMS are currently disabled/);
  assert.match(catalogue,/Ordinary carrier calls and SMS are not made end-to-end encrypted/);
});

test('only configured HTTPS Stripe payment links are offered and absent or unsafe links never become CTAs',async()=>{
  for(const value of [undefined,'','javascript:alert(1)','http://buy.stripe.com/fixture','https://buy.stripe.com.evil.example/fixture','https://evil.example/fixture','https://user@buy.stripe.com/fixture','https://buy.stripe.com:8443/fixture','https://buy.stripe.com/fixture#unsafe','https://buy.stripe.com/fixture?redirect=elsewhere','https://buy.stripe.com/','https://buy.stripe.com/fixture/extra']){
    const text=await html('/phones',{links:{new:value,refurb:value}});
    assert.deepEqual(checkoutHrefs(text),[],String(value));
    assert.doesNotMatch(text,/<a[^>]+aria-label="Preorder/);
    assert.match(text,/Contact us about this phone/);
  }
  for(const value of Object.values(liveConfig.links)){
    const url=new URL(value);
    assert.equal(url.origin,'https://buy.stripe.com');
    assert.match(url.pathname,/^\/[A-Za-z0-9]+$/);
    assert.equal(url.search,'');
    assert.equal(url.hash,'');
  }
});

test('checkout requires a valid supplier address and malformed runtime data cannot disclose unrelated environment fields',async()=>{
  const invalid=[undefined,'not json','[]','null','{}',JSON.stringify({name:'Example',addressLines:[]}),JSON.stringify({name:'Example',addressLines:['']}),JSON.stringify({...seller,name:' '}),JSON.stringify({...seller,name:'x'.repeat(121)}),JSON.stringify({...seller,addressLines:['Only one line']}),JSON.stringify({...seller,addressLines:['Line 1','Line\n2']}),'x'.repeat(2001)];
  for(const value of invalid){
    const env={OTHER_PRIVATE_VALUE:'unrelated-fixture-must-not-render',...(value===undefined?{}:{PHONE_SHOP_SELLER_JSON:value})};
    for(const path of ['/phones','/phones/terms','/phones/privacy']){
      const text=await html(path,{links},env);
      assert.deepEqual(checkoutHrefs(text),[],String(value).slice(0,70));
      assert.doesNotMatch(text,/unrelated-fixture-must-not-render/);
    }
  }
  const escaped=await html('/phones/terms',{links},{PHONE_SHOP_SELLER_JSON:JSON.stringify({...seller,name:'Example & Sons',addressLines:['<img src=x onerror=alert(1)>','Test City']})});
  assert.doesNotMatch(escaped,/<img src=x/);
  assert.match(escaped,/Example &amp; Sons/);
  assert.match(escaped,/&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('phone GET and HEAD routes have strict document policies and state-changing methods are refused',async()=>{
  const worker=shop();
  for(const path of ['/phones','/phones/','/phones/terms','/phones/privacy','/phones/thanks','/phones.css','/phones-promotion.css']){
    const get=await worker.fetch(request(path),sellerEnv),head=await worker.fetch(request(path,'HEAD'),sellerEnv);
    assert.equal(get.status,200,path);
    assert.equal(head.status,200,path);
    assert.equal(await head.text(),'');
    assert.equal(get.headers.get('Cache-Control'),'no-store');
    assert.equal(get.headers.get('X-Content-Type-Options'),'nosniff');
    assert.equal(get.headers.get('X-Frame-Options'),'DENY');
    assert.match(get.headers.get('Content-Security-Policy'),/default-src 'none'/);
    assert.match(get.headers.get('Content-Security-Policy'),/form-action 'none'/);
    const post=await worker.fetch(request(path,'POST'),sellerEnv);
    assert.equal(post.status,405,path);
    assert.equal(post.headers.get('Allow'),'GET, HEAD');
  }
  const css=await worker.fetch(request('/phones.css'),sellerEnv);
  assert.match(css.headers.get('Content-Type'),/text\/css/);
  assert.equal(await css.text(),PHONE_SHOP_CSS);
});

test('application, auth, download, API and unknown-host responses retain their exact response object and request arguments',async()=>{
  for(const [path,method,host] of [
    ['/apps/vault','GET',origin],['/apps/relay','HEAD',origin],['/apps/mail','GET',origin],
    ['/__access/start?next=%2Fapps%2Fvault','GET',origin],['/api/app-access/code','POST',origin],
    ['/api/feedback','POST',origin],['/downloads/VGuard-0.1.4-candidate.apk','GET',origin],
    ['/sw.js','GET',origin],['/offline/vault','GET',origin],['/unknown','GET',origin],
    ['/phones','GET','https://unregistered.example'],['/phones','GET','http://www.vellivex.com'],
    ['/phones','GET','https://www.vellivex.com:8443']
  ]){
    const response=fallback(),env={sentinel:'env'},ctx={sentinel:'ctx'},calls=[];
    const worker=shop({links},{fetch(...args){calls.push(args);return response;}});
    const req=request(path,method,host);
    assert.equal(await worker.fetch(req,env,ctx),response,path);
    assert.deepEqual(calls,[[req,env,ctx]],path);
  }
  const scheduled=()=>{},email=()=>{},queue=()=>{};
  const wrapped=shop({links},{fetch:fallback,scheduled,email,queue});
  assert.equal(wrapped.scheduled,scheduled);
  assert.equal(wrapped.email,email);
  assert.equal(wrapped.queue,queue);
});

test('public homepage promotion is idempotent and preserves existing content and security policy',async()=>{
  const original='<!doctype html><html><head><title>Existing</title></head><body><nav id="navigation"><a href="/beta">Apps</a></nav><main><h1>Existing homepage</h1><a href="/apps/vault">Vault</a></main></body></html>';
  const csp="default-src 'none'; script-src 'self'; style-src 'self'";
  const originalWorker={fetch:()=>new Response(original,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'ETag':'old','Content-Length':String(original.length),'X-Existing':'yes'}})};
  const once=shop({links},originalWorker),twice=shop({links},once);
  const first=await once.fetch(request('/'),sellerEnv),second=await twice.fetch(request('/'),sellerEnv);
  const text=await first.text();
  assert.equal(await second.text(),text);
  assert.equal((text.match(/data-phone-shop-link/g)||[]).length,1);
  assert.equal((text.match(/id="vellivex-phone-promotion"/g)||[]).length,1);
  assert.match(text,/<h1>Existing homepage<\/h1>/);
  assert.match(text,/href="\/apps\/vault"/);
  assert.equal(first.headers.get('Content-Security-Policy'),csp);
  assert.equal(first.headers.get('X-Existing'),'yes');
  assert.equal(first.headers.get('ETag'),null);
  assert.equal(first.headers.get('Content-Length'),null);
});

test('sitemap adds only public phone pages and thanks cannot assert payment success',async()=>{
  const original='<?xml version="1.0"?><urlset><url><loc>https://www.vellivex.com/</loc></url></urlset>';
  const worker=shop({links},{fetch:()=>new Response(original,{headers:{'Content-Type':'application/xml','ETag':'old'}})});
  const wrapped=shop({links},worker);
  const sitemap=await (await wrapped.fetch(request('/sitemap.xml'),sellerEnv)).text();
  for(const path of ['/phones','/phones/terms','/phones/privacy']) assert.equal(sitemap.split('<loc>'+origin+path+'</loc>').length-1,1,path);
  assert.doesNotMatch(sitemap,/phones\/thanks/);
  const response=await worker.fetch(request('/phones/thanks?payment_status=paid&session_id=pretend'),sellerEnv);
  assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
  const text=await response.text();
  assert.match(text,/Visiting this page alone does not confirm that payment succeeded/);
  assert.match(text,/If your payment completed/);
  assert.doesNotMatch(text,/pretend|Your payment was successful/);
});
