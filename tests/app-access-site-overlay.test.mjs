import test from 'node:test';
import assert from 'node:assert/strict';
import {page} from '../server/pages.js';
import vm from 'node:vm';
import {ACCESS_PRIVACY_HTML, MIGRATION_SCRIPT, transformSiteResponse} from '../server/app-access/site-overlay.mjs';

const UPSTREAM = 'https://vellivex-disposable-mail-pilot.vellivex-call.workers.dev';
const CSP = `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self' ${UPSTREAM}; frame-src https://challenges.cloudflare.com; form-action 'none'`;
const htmlResponse = (html, headers = {}) => new Response(html, {headers:{'Content-Type':'text/html; charset=utf-8', 'Content-Length':String(Buffer.byteLength(html)), ETag:'"current"', 'Cache-Control':'public, max-age=120', 'Content-Security-Policy':CSP, 'X-Existing':'preserved', ...headers}});
const apply = (path, response, method = 'GET', origin = 'https://www.vellivex.com') => transformSiteResponse(new Request(origin + path, {method}), response);

async function flush(){for(let i=0;i<18;i++)await Promise.resolve();}
function migrationClient({online=true,registration,lookup}={}){
  const listeners=new Map(),timers=new Map(),nodes=[],calls=[];let timer=0;
  const document={body:{prepend(node){nodes.push(node);}},querySelector(){return null;},createElement(){return {setAttribute(){},textContent:''};},addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type);}};
  class Channel{constructor(){this.port1={onmessage:null,close(){}};this.port2={peer:this.port1,close(){}};}}
  const active={state:'activated',scriptURL:'https://www.vellivex.com/sw.js',postMessage(value,ports){calls.push(['message',value.type]);ports[0].peer.onmessage({data:{version:'email-gate-v2'}});}};
  const defaultRegistration={scope:'https://www.vellivex.com/apps/',active,async update(){calls.push(['update']);}};
  const context={navigator:{onLine:online,serviceWorker:{async getRegistration(path){calls.push(['lookup',path]);return lookup?lookup():registration===null?null:registration||defaultRegistration;}}},document,location:{origin:'https://www.vellivex.com',href:'https://www.vellivex.com/'},URL,MessageChannel:Channel,setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},Promise,Error};
  vm.runInNewContext(MIGRATION_SCRIPT,context);
  return {listeners,timers,nodes,calls,click({href='https://www.vellivex.com/apps/vault',type='click',download=false,target='_blank',ctrlKey=false}={}){const anchor={href,target,hasAttribute(name){return name==='download'&&download;}};const event={target:{closest(){return anchor;}},ctrlKey,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};listeners.get(type)?.(event);return {prevented:event.defaultPrevented,anchor};},expire(){for(const {fn} of [...timers.values()])fn();}};
}

test('public migration script is served on its exact route even when the preserved original returns 404',async()=>{
 const response=await apply('/app-access-migration.js',new Response('Not found',{status:404}));assert.equal(response.status,200);assert.equal(await response.text(),MIGRATION_SCRIPT);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Type'),/javascript/);
 assert.equal(await (await apply('/app-access-migration.js',new Response(null,{status:404}),'HEAD')).text(),'');
 const other=new Response('Not found',{status:404});assert.equal(await apply('/app-access-migration.js?unknown=1',other),other);
});
test('homepage explicitly upgrades an existing controller before allowing ordinary target-blank app clicks',async()=>{
 const r=migrationClient();const click=r.click();assert.equal(click.prevented,true);assert.equal(click.anchor.target,'_blank');assert.match(r.nodes[0].textContent,/select the app again/);
 await flush();assert.deepEqual(r.calls,[['lookup','/apps/'],['update'],['message','VELLIVEX_APP_ACCESS_POLICY']]);assert.equal(r.listeners.size,0);assert.equal(r.timers.size,0);assert.equal(r.click().prevented,false);
});
test('migration checks never register a new offline worker and leave other apps, downloads and offline pages alone',async()=>{
 const r=migrationClient({registration:null});assert.equal(r.click({href:'https://vkey.vellivex.com/'}).prevented,false);assert.equal(r.click({download:true}).prevented,false);await flush();assert.deepEqual(r.calls,[['lookup','/apps/']]);assert.equal(r.listeners.size,0);
 const offline=migrationClient({online:false});await flush();assert.equal(offline.calls.length,0);assert.equal(offline.listeners.size,0);
});
test('modified and middle clicks retain their native behavior after migration, without asynchronous popup creation',async()=>{
 const r=migrationClient();assert.equal(r.click({type:'auxclick',ctrlKey:true}).prevented,true);await flush();const click=r.click({type:'auxclick',ctrlKey:true});assert.equal(click.prevented,false);assert.equal(click.anchor.target,'_blank');assert.equal(r.click({ctrlKey:true}).prevented,false);
});
test('a legacy worker without the new policy handshake times out visibly instead of reporting successful admission',async()=>{
 const registration={scope:'https://www.vellivex.com/apps/',active:{state:'activated',scriptURL:'https://www.vellivex.com/sw.js',postMessage(){}},async update(){}};
 const r=migrationClient({registration});await flush();assert.equal([...r.timers.values()][0].ms,12000);r.expire();await flush();assert.equal(r.click().prevented,true);assert.match(r.nodes[0].textContent,/could not be updated/);assert.equal(r.timers.size,0);
});
test('late registration lookup after timeout cannot start a background update or claim success',async()=>{
 let resolve,updates=0;const registration=new Promise(r=>resolve=r),r=migrationClient({lookup:()=>registration});r.expire();await flush();resolve({scope:'https://www.vellivex.com/apps/',active:{state:'activated',scriptURL:'https://www.vellivex.com/sw.js'},async update(){updates++;}});await flush();assert.equal(updates,0);assert.equal(r.click().prevented,true);assert.match(r.nodes[0].textContent,/could not be updated/);
});
test('unexpected registration scope or worker script cannot be updated or acknowledge readiness',async()=>{
 for(const incorrect of ['scope','script']){
  let updates=0;
  const registration={scope:incorrect==='scope'?'https://www.vellivex.com/':'https://www.vellivex.com/apps/',active:{state:'activated',scriptURL:incorrect==='script'?'https://www.vellivex.com/other.js':'https://www.vellivex.com/sw.js'},async update(){updates++;}};
  const r=migrationClient({registration});await flush();assert.equal(updates,0);assert.equal(r.click().prevented,true);assert.match(r.nodes[0].textContent,/could not be updated/);assert.equal(r.timers.size,0);
 }
});
test('a replaced active worker cannot complete the handshake with a late policy acknowledgment',async()=>{
 const registration={scope:'https://www.vellivex.com/apps/',async update(){}};
 registration.active={state:'activated',scriptURL:'https://www.vellivex.com/sw.js',postMessage(value,ports){registration.active={state:'activated',scriptURL:'https://www.vellivex.com/sw.js'};ports[0].peer.onmessage({data:{version:'email-gate-v2'}});}};
 const r=migrationClient({registration});await flush();assert.equal(r.timers.size,1);r.expire();await flush();assert.equal(r.click().prevented,true);assert.match(r.nodes[0].textContent,/could not be updated/);
});

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
  assert.equal((html.match(/<script\b/g) || []).length, (original.match(/<script\b/g) || []).length + 1);
  assert.equal((html.match(/src="\/app-access-migration.js"/g) || []).length, 1);
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
  const withoutAdditions = html.replace(ACCESS_PRIVACY_HTML, '').replace(/<a href="https:\/\/call\.vellivex\.com\/access" data-app-access-link="true">Sign in \/ account<\/a>/, '').replace('<script defer src="/app-access-migration.js"></script>', '');
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
