// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {withPhoneShop, PHONE_PRODUCTS, PHONE_SHOP_CSS, PHONE_LAUNCH_PATH, PHONE_SOCIAL_IMAGE, PHONE_PRODUCT_IMAGE} from '../server/phone-shop.mjs';
import liveConfig from '../server/phone-shop-config.mjs';
import {page} from '../server/pages.js';

const origin = 'https://www.vellivex.com';
const messengerApkPath = '/downloads/Vellivex-Messenger-0.1.0-alpha05-arm64.apk';
const messengerApkSource = 'https://github.com/Vellivex/v-security-suite/releases/download/messenger-v0.1.0-alpha05/Vellivex-Messenger-0.1.0-alpha05-arm64.apk';
const retiredMessengerApkPaths = [
  '/downloads/Vellivex-Messenger-0.1.0-alpha02-arm64.apk',
  '/downloads/Vellivex-Messenger-0.1.0-alpha03-arm64.apk',
  '/downloads/Vellivex-Messenger-0.1.0-alpha04-arm64.apk',
];
const links = {new:'https://buy.stripe.com/fixtureNew',refurb:'https://buy.stripe.com/fixtureRefurb'};
// Synthetic correspondence address: never a real owner or customer's details.
const seller = {name:'Vellivex Test Supplier',addressLines:['1 Example Street','Test City','ZZ1 1ZZ']};
const sellerEnv = {PHONE_SHOP_SELLER_JSON:JSON.stringify(seller)};
const request = (path, method='GET', host=origin) => new Request(host + path,{method});
const fallback = () => new Response('Preserved application',{headers:{'Content-Type':'text/plain','X-Existing':'yes'}});
const shop = (config={links}, original={fetch:fallback}) => withPhoneShop(original, config);
const html = async (path='/phones', config={links}, env=sellerEnv) => (await shop(config).fetch(request(path),env)).text();
const checkoutHrefs = text => [...text.matchAll(/href="(https:\/\/buy\.stripe\.com[^"\s]*)"/g)].map(match=>match[1]);
function structuredData(text){
  const scripts=[...text.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1,'one parseable structured-data block');
  const data=JSON.parse(scripts[0][1]);
  assert.equal(data['@context'],'https://schema.org');
  assert.ok(Array.isArray(data['@graph']));
  return {raw:scripts[0][1],graph:data['@graph']};
}
function assertNoInventedReviews(value){
  if(!value || typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    assert.ok(!['aggregateRating','review','ratingValue','reviewCount'].includes(key),'no invented review data');
    assertNoInventedReviews(item);
  }
}

test('phone purchase options match the advertised condition, total price and paid preorder contract',async()=>{
  assert.deepEqual(PHONE_PRODUCTS.map(({id,price})=>({id,price})),[{id:'new',price:479},{id:'refurb',price:375}]);
  const catalogue=await html();
  assert.deepEqual(checkoutHrefs(catalogue),[links.new,links.refurb]);
  assert.match(catalogue,/128GB · Obsidian · GrapheneOS/);
  assert.match(catalogue,/Preorder new Pixel 9a for £479/);
  assert.match(catalogue,/Preorder refurbished Pixel 9a for £375/);
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
  for(const path of ['/phones','/phones/','/phones/terms','/phones/privacy','/phones/thanks','/phones.css','/phones-promotion.css',PHONE_LAUNCH_PATH]){
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
    ['/blog/technical-vvault-envelope-design','GET',origin],['/blog/unknown-guide','GET',origin],
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
  const original='<!doctype html><html><head><title>Existing</title></head><body><nav id="navigation"><a href="/beta">Apps</a></nav><main><h1>Existing homepage</h1><a href="/apps/vault">Vault</a></main><footer><div>Existing footer</div></footer></body></html>';
  const csp="default-src 'none'; script-src 'self'; style-src 'self'";
  const originalWorker={fetch:()=>new Response(original,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'ETag':'old','Content-Length':String(original.length),'X-Existing':'yes'}})};
  const once=shop({links},originalWorker),twice=shop({links},once);
  const first=await once.fetch(request('/'),sellerEnv),second=await twice.fetch(request('/'),sellerEnv);
  const text=await first.text();
  assert.equal(await second.text(),text);
  assert.equal((text.match(/data-phone-shop-link/g)||[]).length,1);
  assert.equal((text.match(/id="vellivex-phone-promotion"/g)||[]).length,1);
  assert.equal((text.match(/id="vellivex-messenger-hero"/g)||[]).length,1);
  assert.equal((text.match(/href="\/phones-promotion\.css"/g)||[]).length,1);
  assert.match(text,/<h2 id="vellivex-phone-promotion-title">Vellivex Privacy Phones<\/h2>/);
  assert.match(text,/Paid preorders with tracked UK delivery included within 14 days of payment/);
  assert.match(text,/<img class="phone-promo-image" src="\/media\/pixel-9a-obsidian\.jpg"/);
  assert.match(text,/href="\/phones#new">\s*<span>New Pixel 9a<\/span>\s*<strong>£479<\/strong>/);
  assert.match(text,/href="\/phones#refurb">\s*<span>Refurbished Pixel 9a<\/span>\s*<strong>£375<\/strong>/);
  assert.doesNotMatch(text,/buy\.stripe\.com/);
  assert.match(text,/<h1>Existing homepage<\/h1>/);
  assert.match(text,/href="\/apps\/vault"/);
  assert.equal(first.headers.get('Content-Security-Policy'),csp);
  assert.equal(first.headers.get('X-Existing'),'yes');
  assert.equal(first.headers.get('ETag'),null);
  assert.equal(first.headers.get('Content-Length'),null);
});

test('the homepage keeps Messenger first in main and both phone options in the footer', async () => {
  const worker = shop({links}, {fetch: req => new Response(page(new URL(req.url).pathname), {
    headers: {'Content-Type': 'text/html; charset=utf-8'},
  })});
  const text = await (await worker.fetch(request('/'), sellerEnv)).text();
  const main = text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
  const footer = text.match(/<\/main>\s*<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1] ?? '';
  assert.match(main, /^<section id="vellivex-messenger-hero"/);
  assert.doesNotMatch(main, /id="vellivex-phone-promotion"/);
  assert.match(main, /Android 8\.0\+ \(ARM64\) · Test alpha · Invite-only sign-in/);
  assert.ok(main.includes(`href="${messengerApkPath}">Free download</a>`));
  assert.match(main, /href="\/messenger">Setup guide/);
  for (const path of retiredMessengerApkPaths) assert.ok(!main.includes(path));
  assert.match(footer, /^<section id="vellivex-phone-promotion"/);
  assert.match(footer, /New Pixel 9a[\s\S]*£479[\s\S]*Refurbished Pixel 9a[\s\S]*£375/);
  assert.match(footer, /class="footer-links"/);

  const beta = await (await worker.fetch(request('/beta'), sellerEnv)).text();
  assert.doesNotMatch(beta, /id="vellivex-phone-promotion"|id="vellivex-messenger-hero"|\/phones-promotion\.css/);
});

test('Messenger setup and download support public GET and HEAD without trusting request parameters', async () => {
  const worker = shop();
  const guide = await worker.fetch(request('/messenger'), sellerEnv);
  const guideText = await guide.text();
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('Content-Security-Policy'), /form-action 'none'/);
  assert.match(guideText, /Android 8\.0\+ \(ARM64\) · Test alpha · Invite-only sign-in/);
  assert.match(guideText, /You’ll need an invited email address you can access/);
  assert.match(guideText, /This is an early test build\. Use test conversations during this alpha/);
  assert.match(guideText, /Downloading the app does not grant access to the messaging service/);
  assert.match(guideText, /To request an invitation, contact <a href="mailto:v@vellivex\.com">v@vellivex\.com<\/a>/);
  assert.match(guideText, /Testing on physical phones and an independent security review are not complete/);
  assert.match(guideText, /Message history warning:[\s\S]*In this alpha, recovery may not restore any earlier messages, including messages from contacts still using the same phone/);
  assert.match(guideText, /install it over the existing app and choose <strong>Update<\/strong>/);
  assert.match(guideText, /<strong>Update<\/strong> to keep your existing installation, session and message keys/);
  assert.match(guideText, /Keep the app signed in\. Do not uninstall it or sign out before updating/);
  assert.match(guideText, /connects to the Vellivex messaging service automatically.*Continue with email/);
  assert.match(guideText, /Enter your invited email address and tap <strong>Continue with email<\/strong>/);
  assert.match(guideText, /eight-digit code from your inbox.*Open Vellivex/);
  assert.match(guideText, /Secure your account[\s\S]*Create recovery key[\s\S]*Set up recovery[\s\S]*Save the key somewhere private/);
  assert.match(guideText, /Last 4 characters[\s\S]*I've saved my recovery key[\s\S]*before starting a conversation/);
  assert.match(guideText, /Only one phone can be active[\s\S]*old phone online[\s\S]*Sign out<\/strong> on that phone first/);
  assert.match(guideText, /same email address[\s\S]*Recover your account[\s\S]*saved <strong>Recovery key<\/strong>[\s\S]*Recover account<\/strong> to restore your account’s encryption keys/);
  assert.match(guideText, /Earlier conversations may remain unreadable after recovery[\s\S]*keep the existing installation and remain signed in/);
  assert.match(guideText, /Without your saved recovery key, you cannot recover your account’s encryption keys after losing this installation/);
  assert.match(guideText, /New conversation[\s\S]*Verify contact[\s\S]*They match[\s\S]*Send message/);
  assert.doesNotMatch(guideText, /Test server settings|lost phone/i);
  assert.ok(guideText.includes(`href="${messengerApkPath}">Free download</a>`));
  for (const path of retiredMessengerApkPaths) assert.ok(!guideText.includes(path));

  for (const method of ['GET', 'HEAD']) {
    const download = await worker.fetch(request(`${messengerApkPath}?next=https://other.example`, method), sellerEnv);
    assert.equal(download.status, 302);
    assert.equal(download.headers.get('Location'), messengerApkSource);
    assert.equal(download.headers.get('Cache-Control'), 'no-store');
    assert.equal(await download.text(), '');
    for (const path of retiredMessengerApkPaths) {
      const retired = await worker.fetch(request(`${path}?next=https://other.example`, method), sellerEnv);
      assert.equal(retired.status, 303);
      assert.equal(retired.headers.get('Location'), '/messenger');
      assert.equal(retired.headers.get('Cache-Control'), 'no-store');
      assert.equal(await retired.text(), '');
    }
  }
  const guideHead = await worker.fetch(request('/messenger', 'HEAD'), sellerEnv);
  assert.equal(guideHead.status, 200);
  assert.equal(await guideHead.text(), '');
  for (const path of ['/messenger', messengerApkPath, ...retiredMessengerApkPaths]) {
    const post = await worker.fetch(request(path, 'POST'), sellerEnv);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Allow'), 'GET, HEAD');
    const offHost = await worker.fetch(request(path, 'GET', 'https://other.example'), sellerEnv);
    assert.equal(await offHost.text(), 'Preserved application');
  }
});

test('Messenger keeps its setup guide available when no public APK target is configured', async () => {
  for (const target of ['', messengerApkSource.replace('https:', 'http:'), `${messengerApkSource}?token=fixture`,
    messengerApkSource.replace('github.com', 'fixture.example'), messengerApkSource.replace('Vellivex/', 'other/'),
    messengerApkSource.replace('.apk', '.zip')]) {
    const config = {links, messengerApkSource: target};
    const guide = await html('/messenger', config);
    assert.match(guide, /APK download is currently unavailable/);
    assert.doesNotMatch(guide, /Free download/);
    const download = await shop(config).fetch(request(messengerApkPath), sellerEnv);
    assert.equal(download.status, 503);
    assert.equal(download.headers.get('Location'), null);
  }
});

test('sitemap adds only public phone pages and thanks cannot assert payment success',async()=>{
  const original='<?xml version="1.0"?><urlset><url><loc>https://www.vellivex.com/</loc></url></urlset>';
  const worker=shop({links},{fetch:()=>new Response(original,{headers:{'Content-Type':'application/xml','ETag':'old'}})});
  const wrapped=shop({links},worker);
  const sitemap=await (await wrapped.fetch(request('/sitemap.xml'),sellerEnv)).text();
  for(const path of ['/phones',PHONE_LAUNCH_PATH]) assert.equal(sitemap.split('<loc>'+origin+path+'</loc>').length-1,1,path);
  assert.doesNotMatch(sitemap,/phones\/(?:thanks|terms|privacy)/);
  const response=await worker.fetch(request('/phones/thanks?payment_status=paid&session_id=pretend'),sellerEnv);
  assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
  const text=await response.text();
  assert.match(text,/Visiting this page alone does not confirm that payment succeeded/);
  assert.match(text,/If your payment completed/);
  assert.doesNotMatch(text,/pretend|Your payment was successful/);
});

test('catalogue and buying guide publish canonical social previews without copying query strings',async()=>{
  for(const [path,type] of [['/phones','website'],[PHONE_LAUNCH_PATH,'article']]){
    const text=await (await shop().fetch(request(path+'?campaign=untrusted-tracking','GET','https://vellivex.com'),sellerEnv)).text();
    assert.ok(text.includes('<link rel="canonical" href="'+origin+path+'">'));
    assert.ok(text.includes('<meta property="og:url" content="'+origin+path+'">'));
    assert.ok(text.includes('<meta property="og:type" content="'+type+'">'));
    for(const property of ['og:image','twitter:image']){
      const attribute=property.startsWith('og:')?'property':'name';
      assert.ok(text.includes('<meta '+attribute+'="'+property+'" content="'+origin+PHONE_SOCIAL_IMAGE+'">'));
    }
    assert.match(text,/<meta name="twitter:card" content="summary_large_image">/);
    assert.match(text,/<meta property="og:image:width" content="1200">/);
    assert.match(text,/<meta property="og:image:height" content="630">/);
    assert.match(text,/<meta name="description" content="[^"]*(?:£375|£479)/);
    assert.match(text,/<title>[^<]*GrapheneOS[^<]*UK/i);
    assert.doesNotMatch(text,/untrusted-tracking/);
  }
});

test('product structured data describes the two preorder conditions and suppresses unavailable offers',async()=>{
  const {graph}=structuredData(await html());
  const group=graph.find(item=>item['@type']==='ProductGroup');
  assert.ok(group);
  assert.equal(group.url,origin+'/phones');
  assert.equal(PHONE_PRODUCT_IMAGE,'/media/pixel-9a-obsidian.jpg');
  assert.equal(group.image,origin+PHONE_PRODUCT_IMAGE);
  assert.equal(group.hasVariant.length,2);
  for(const [index,[id,price,condition]] of [['new',479,'NewCondition'],['refurb',375,'RefurbishedCondition']].entries()){
    const variant=group.hasVariant[index],offer=variant.offers;
    assert.equal(variant['@type'],'Product');
    assert.equal(variant.url,origin+'/phones#'+id);
    assert.equal(variant.image,group.image);
    assert.equal(variant.itemCondition,'https://schema.org/'+condition);
    assert.equal(offer['@type'],'Offer');
    assert.equal(offer.price,price);
    assert.equal(offer.priceCurrency,'GBP');
    assert.equal(offer.availability,'https://schema.org/PreOrder');
    assert.equal(offer.itemCondition,variant.itemCondition);
    assert.equal(offer.url,variant.url);
    assert.equal(offer.shippingDetails.shippingDestination.addressCountry,'GB');
    assert.equal(offer.shippingDetails.shippingRate.value,0);
    assert.equal(offer.shippingDetails.shippingRate.currency,'GBP');
  }
  assertNoInventedReviews(graph);
  for(const env of [{},{PHONE_SHOP_SELLER_JSON:'malformed'},{PHONE_SHOP_SELLER_JSON:'{}'}]){
    const data=structuredData(await html('/phones',{links},env));
    assert.ok(data.graph.find(item=>item['@type']==='ProductGroup').hasVariant.every(item=>!Object.hasOwn(item,'offers')));
  }
  const partial=structuredData(await html('/phones',{links:{new:links.new,refurb:'https://invalid.example/checkout'}}));
  const variants=partial.graph.find(item=>item['@type']==='ProductGroup').hasVariant;
  assert.ok(variants[0].offers);
  assert.ok(!Object.hasOwn(variants[1],'offers'));
});

test('JSON-LD is permitted only by the exact data-block hash without executable inline-script permissions',async()=>{
  const worker=shop();
  for(const path of ['/phones',PHONE_LAUNCH_PATH]){
    const get=await worker.fetch(request(path),sellerEnv),head=await worker.fetch(request(path,'HEAD'),sellerEnv);
    const text=await get.text(),{raw,graph}=structuredData(text);
    const expected="'sha256-"+createHash('sha256').update(raw,'utf8').digest('base64')+"'";
    const directives=get.headers.get('Content-Security-Policy').split(';').map(value=>value.trim());
    assert.equal(directives.filter(value=>value.startsWith('script-src ')).length,1);
    assert.ok(directives.includes('script-src '+expected));
    assert.doesNotMatch(get.headers.get('Content-Security-Policy'),/unsafe-inline|unsafe-eval|script-src[^;]*https:/);
    assert.equal(head.headers.get('Content-Security-Policy'),get.headers.get('Content-Security-Policy'));
    assert.equal(await head.text(),'');
    assert.equal((text.match(/<script\b/g)||[]).length,1);
    assert.doesNotMatch(raw,/[<>&\u2028\u2029]/);
    assertNoInventedReviews(graph);
  }
});

test('the buying guide has article schema and is added once to the existing blog without replacing old guides',async()=>{
  const article=await html(PHONE_LAUNCH_PATH),{graph}=structuredData(article);
  const post=graph.find(item=>item['@type']==='BlogPosting');
  assert.ok(post);
  assert.equal(post.url,origin+PHONE_LAUNCH_PATH);
  assert.equal(post.mainEntityOfPage['@id'],post.url);
  assert.equal(post.image.url,origin+PHONE_SOCIAL_IMAGE);
  assert.equal(post.author.name,'Vellivex');
  assert.equal(post.datePublished,'2026-11-12');
  assert.match(article,/paid preorders, prepared after payment/);
  assert.match(article,/International delivery takes longer and needs a separate quote before payment/);
  assert.match(article,/Vellivex apps remain beta/);
  assert.ok(article.includes('href="/phones#new"'));
  assert.ok(article.includes('href="/phones#refurb"'));
  assert.ok((await html()).includes('href="'+PHONE_LAUNCH_PATH+'"'));
  const original=page('/blog');
  const oldLinks=[...original.matchAll(/href="(\/blog\/[^"#]+)"/g)].map(match=>match[1]);
  assert.ok(oldLinks.length>0);
  const originalWorker={fetch:()=>new Response(original,{headers:{'Content-Type':'text/html; charset=utf-8'}})};
  const once=shop({links},originalWorker),twice=shop({links},once);
  const first=await (await once.fetch(request('/blog'),sellerEnv)).text();
  assert.equal(await (await twice.fetch(request('/blog'),sellerEnv)).text(),first);
  assert.equal((first.match(/id="vellivex-phone-launch-post"/g)||[]).length,1);
  assert.ok(first.includes('href="'+PHONE_LAUNCH_PATH+'"'));
  for(const link of oldLinks)assert.ok(first.includes('href="'+link+'"'),link);
  const existing=page('/blog/technical-vvault-envelope-design');
  const response=new Response(existing,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  const unchanged=await shop({links},{fetch:()=>response}).fetch(request('/blog/technical-vvault-envelope-design'),sellerEnv);
  assert.equal(unchanged,response);
  assert.equal(await unchanged.text(),existing);
});

test('the social preview is served as the original PNG bytes and HEAD retains accurate image metadata',async()=>{
  const expected=await readFile(new URL('../assets/phone-launch/vellivex-privacy-phones.png',import.meta.url));
  const worker=shop();
  const get=await worker.fetch(request(PHONE_SOCIAL_IMAGE),sellerEnv);
  assert.equal(get.status,200);
  assert.equal(get.headers.get('Content-Type'),'image/png');
  assert.equal(get.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(Number(get.headers.get('Content-Length')),expected.length);
  const body=Buffer.from(await get.arrayBuffer());
  assert.deepEqual(body,expected,'image must never pass through a text/html response transform');
  assert.deepEqual([...body.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(body.subarray(12,16).toString('ascii'),'IHDR');
  assert.equal(body.readUInt32BE(16),1200);
  assert.equal(body.readUInt32BE(20),630);
  const head=await worker.fetch(request(PHONE_SOCIAL_IMAGE,'HEAD'),sellerEnv);
  assert.equal(head.status,200);
  assert.equal(head.headers.get('Content-Type'),get.headers.get('Content-Type'));
  assert.equal(head.headers.get('Content-Length'),get.headers.get('Content-Length'));
  assert.equal(head.headers.get('ETag'),get.headers.get('ETag'));
  assert.equal((await head.arrayBuffer()).byteLength,0);
  const range=await worker.fetch(new Request(origin+PHONE_SOCIAL_IMAGE,{headers:{Range:'bytes=0-7'}}),sellerEnv);
  assert.equal(range.status,206);
  assert.equal(range.headers.get('Content-Range'),'bytes 0-7/'+expected.length);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()),expected.subarray(0,8));
  const post=await worker.fetch(request(PHONE_SOCIAL_IMAGE,'POST'),sellerEnv);
  assert.equal(post.status,405);
  assert.equal(post.headers.get('Allow'),'GET, HEAD');
  for(const path of [PHONE_SOCIAL_IMAGE,'/media/unknown-image.png']){
    const preserved=fallback();
    const host=path===PHONE_SOCIAL_IMAGE?'https://unregistered.example':origin;
    const response=await shop({links},{fetch:()=>preserved}).fetch(request(path,'GET',host),sellerEnv);
    assert.equal(response,preserved);
  }
});

test('robots additions permit only the phone paths in the wildcard group and preserve all original rules',async()=>{
  const original=['# Existing crawler policy','User-agent: BlockedBot','Disallow: /','','User-agent: *','Allow: /blog','Disallow: /','Crawl-delay: 2','','User-agent: OtherBot','Disallow: /media/','Sitemap: https://www.vellivex.com/sitemap.xml',''].join('\n');
  const additions=['Allow: /phones','Allow: /media/vellivex-privacy-phones','Allow: /media/pixel-9a-obsidian.jpg'];
  const base={fetch:()=>new Response(original,{headers:{'Content-Type':'text/plain; charset=utf-8','ETag':'old','Content-Length':String(original.length),'X-Existing':'yes'}})};
  const once=shop({links},base),twice=shop({links},once);
  const response=await once.fetch(request('/robots.txt'),sellerEnv),text=await response.text();
  assert.equal(await (await twice.fetch(request('/robots.txt'),sellerEnv)).text(),text);
  const lines=text.split('\n');
  assert.equal(lines.filter(line=>!additions.includes(line)).join('\n'),original);
  const star=text.indexOf('User-agent: *'),nextAgent=text.indexOf('User-agent: OtherBot');
  for(const addition of additions){
    assert.equal(lines.filter(line=>line===addition).length,1,addition);
    assert.ok(text.indexOf(addition)>star && text.indexOf(addition)<nextAgent,addition);
  }
  assert.doesNotMatch(text,/^Allow:\s*\/(?:media\/)?\s*$/m);
  assert.equal(response.headers.get('ETag'),null);
  assert.equal(response.headers.get('Content-Length'),null);
  assert.equal(response.headers.get('X-Existing'),'yes');
});

test('robots shared-agent groups remain intact rather than silently changing either agent policy',async()=>{
  for(const agentLines of [
    ['User-agent: *','User-agent: SpecialBot'],
    ['User-agent: SpecialBot','User-agent: *'],
    ['User-agent: *','','# Both agents share the following rules','User-agent: SpecialBot'],
    ['User-agent: SpecialBot','# Shared group','User-agent: *']
  ]){
    const original=[...agentLines,'Allow: /blog','Disallow: /',''].join('\n');
    const worker=shop({links},{fetch:()=>new Response(original,{headers:{'Content-Type':'text/plain'}})});
    assert.equal(await (await worker.fetch(request('/robots.txt'),sellerEnv)).text(),original);
  }
});

test('the product photograph is the original JPEG and its public route matches product structured data',async()=>{
  const expected=await readFile(new URL('../assets/phone-launch/pixel-9a-obsidian.jpg',import.meta.url));
  const worker=shop(),get=await worker.fetch(request(PHONE_PRODUCT_IMAGE),sellerEnv);
  assert.equal(get.status,200);
  assert.equal(get.headers.get('Content-Type'),'image/jpeg');
  assert.equal(Number(get.headers.get('Content-Length')),expected.length);
  const body=Buffer.from(await get.arrayBuffer());
  assert.deepEqual(body,expected);
  assert.deepEqual([...body.subarray(0,3)],[255,216,255]);
  assert.deepEqual([...body.subarray(-2)],[255,217]);
  const head=await worker.fetch(request(PHONE_PRODUCT_IMAGE,'HEAD'),sellerEnv);
  assert.equal(head.status,200);
  assert.equal(head.headers.get('Content-Type'),'image/jpeg');
  assert.equal(head.headers.get('Content-Length'),get.headers.get('Content-Length'));
  assert.equal((await head.arrayBuffer()).byteLength,0);
  const catalogue=await html();
  assert.equal((catalogue.match(new RegExp('src="'+PHONE_PRODUCT_IMAGE+'"','g'))||[]).length,2);
});


test('phone legal disclosures remain available but carry noindex for GET and HEAD', async()=>{
  for(const path of ['/phones/terms','/phones/privacy']) {
    const response=await shop().fetch(request(path),sellerEnv);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('X-Robots-Tag'),'noindex, follow');
    const body=await response.text();
    assert.match(body,/<meta name="robots" content="noindex,follow">/);
    assert.match(body,/Vellivex Test Supplier/);
    assert.match(body,/1 Example Street/);
    const head=await shop().fetch(request(path+'/', 'HEAD'),sellerEnv);
    assert.equal(head.headers.get('X-Robots-Tag'),'noindex, follow');
    assert.equal(await head.text(),'');
  }
});

test('sitemap removes existing legal entries while preserving unrelated metadata', async()=>{
  const original='<urlset><url><loc>https://www.vellivex.com/phones/terms</loc></url><url><loc>https://www.vellivex.com/phones/privacy/</loc></url><url><loc>https://www.vellivex.com/blog/keep</loc><lastmod>2026-11-12</lastmod></url></urlset>';
  const response=await shop({links},{fetch:async()=>new Response(original,{headers:{'Content-Type':'application/xml'}})}).fetch(request('/sitemap.xml'),sellerEnv);
  const body=await response.text();
  assert.doesNotMatch(body,/phones\/(?:terms|privacy)/);
  assert.match(body,/<loc>https:\/\/www\.vellivex\.com\/blog\/keep<\/loc><lastmod>2026-11-12<\/lastmod>/);
});

test('Messenger publishes the signed Android app association on the canonical host', async () => {
  const path = '/.well-known/assetlinks.json';
  const worker = shop();
  const association = await worker.fetch(request(path), {});
  assert.equal(association.status, 200);
  assert.equal(association.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await association.json(), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app', package_name: 'com.vellivex.messenger.alpha',
      sha256_cert_fingerprints: ['3A:AC:05:CA:DC:D0:CB:90:DF:F2:47:41:18:58:6D:53:7C:E4:5C:F1:77:F2:37:AA:90:A8:4A:6E:D3:40:0D:F2'],
    },
  }]);
  for (const route of [path, '/invite']) {
    assert.equal((await worker.fetch(request(route, 'HEAD'), {})).status, 200);
    assert.equal(await (await worker.fetch(request(route, 'HEAD'), {})).text(), '');
    assert.equal((await worker.fetch(request(route, 'PUT'), {})).status, 405);
    assert.equal(await (await worker.fetch(request(route, 'GET', 'https://vellivex.com'), {})).text(), 'Preserved application');
  }
});

test('Messenger fallback is a first-party page with a hash-pinned private contact reader', async () => {
  const worker = shop();
  const page = await worker.fetch(request('/invite#/@example:example.org'), {});
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  const body = await page.text();
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const digest = createHash('sha256').update(scripts[0][1]).digest('base64');
  assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.ok(page.headers.get('Content-Security-Policy').includes("script-src 'sha256-" + digest + "'"));
  assert.match(body, /href="\/messenger">Get Vellivex Messenger for Android/);
  assert.doesNotMatch(body, /example\.org|matrix\.to|https?:\/\/|localStorage|sessionStorage|sendBeacon|fetch\(/);
  assert.match(await html('/messenger'), /If an older QR code opens a list of Matrix apps/);
});
