// Independent adversarial app-access review. All email transport is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerificationMailer} from '../server/app-access/mail.mjs';
import {createAppAccess, validateAppScope} from '../server/app-access/core.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

const syntheticKey = 're_synthetic_review_key';
const validMail = {email: 'review@example.test', code: '12345678', id: 'x'.repeat(43)};

test('review: verification mail is one transactional request without tracking or automatic retry', async () => {
  const calls = [];
  const send = createVerificationMailer(syntheticKey, {transport: async (url, init) => {
    calls.push({url, init});
    return Response.json({id: 'synthetic-message'});
  }});
  await send(validMail);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'va-signin-' + validMail.id);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, [validMail.email]);
  assert.match(body.text, /12345678/);
  assert.equal(body.html, undefined);
  assert.equal(body.tags, undefined);
  assert.equal(body.text.includes('\\n'), false);
});

test('review: malformed verification input never reaches the email provider', async () => {
  let calls = 0;
  const send = createVerificationMailer(syntheticKey, {transport: async () => {
    calls++; return Response.json({id: 'synthetic'});
  }});
  for (const patch of [
    {email: 'review@example.test\r\nBcc:other@example.test'},
    {email: 'review\0@example.test'},
    {code: '12345678\n'}, {code: '1234567'}, {code: 12345678},
    {id: 'x'.repeat(43) + '\n'}, {id: 'x'.repeat(42)}
  ]) await assert.rejects(send({...validMail, ...patch}), /Verification unavailable/);
  assert.equal(calls, 0);
  assert.equal(createVerificationMailer(''), null);
});

test('review: provider redirects, malformed receipts and oversized bodies never authenticate delivery', async () => {
  const responses = [
    () => new Response(null, {status: 302, headers: {location: 'https://outside.example.test/'}}),
    () => Response.json({id: 'synthetic'}, {status: 429}),
    () => new Response('{"id":"synthetic"}', {headers: {'content-type': 'text/html'}}),
    () => new Response('{"id":"synthetic"}', {headers: {'content-type': 'application/json', 'content-length': '9999'}}),
    () => new Response(new Uint8Array([0xff]), {headers: {'content-type': 'application/json'}}),
    () => Response.json({id: 'bad id'}),
    () => Response.json({accepted: true}),
    () => Response.json([{id: 'synthetic'}]),
    () => new Response('x'.repeat(2049), {headers: {'content-type': 'application/json'}})
  ];
  for (const response of responses) {
    let calls = 0;
    const send = createVerificationMailer(syntheticKey, {transport: async () => {calls++; return response();}});
    await assert.rejects(send(validMail), /^Error: Verification unavailable$/);
    assert.equal(calls, 1);
  }
});

test('review: noncooperative transport and endless zero chunks remain bounded', async () => {
  const started = performance.now();
  const never = createVerificationMailer(syntheticKey, {timeoutMs: 20, transport: () => new Promise(() => {})});
  await assert.rejects(never(validMail), /Verification unavailable/);
  assert.ok(performance.now() - started < 1000);
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  });
  const send = createVerificationMailer(syntheticKey, {timeoutMs: 100, transport: async () => new Response(stream, {headers: {'content-type': 'application/json'}})});
  await assert.rejects(send(validMail), /Verification unavailable/);
  assert.ok(pulls <= 131, `unexpected reads: ${pulls}`);
  assert.equal(cancelled, true);
});

// Real SQLite transactions exercise the conditional claims used by D1, rather
// than replacing their security predicates with a mock implementation.
const authOrigin = 'https://call.vellivex.com';
const siteOrigin = 'https://vellivex.com';
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const hashToken = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
function fixture(t, options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../server/app-access/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const prepare = (sql, values = []) => ({
    sql, values,
    bind(...args) { return prepare(sql, args); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() { const result = sqlite.prepare(sql).run(...values); return {success: true, meta: {changes: Number(result.changes)}}; }
  });
  const db = {prepare, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({sql, values}) => {
        const statement = sqlite.prepare(sql);
        if (statement.columns().length) return {success: true, results: statement.all(...values)};
        const result = statement.run(...values);
        return {success: true, results: [], meta: {changes: Number(result.changes)}};
      });
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
  let time = Date.UTC(2026, 0, 2, 12), cookieJar = new Map();
  const messages = [], env = {ACCOUNTS_DB: db, VELLIVEX_ACCOUNT_KEY: randomToken()};
  const service = createAppAccess({now: () => time, sendMail: async mail => {messages.push(mail); if(options.mailFailure) throw Error('synthetic failure');}, ...(options.budgets ? {budgets: options.budgets} : {})});
  const cookieHeader = () => [...cookieJar].map(([name,value]) => name + '=' + value).join('; ');
  async function request(path, body, {internal=false, cookies=cookieHeader(), headers={}, ip='192.0.2.10', method=body === undefined ? 'GET' : 'POST', rawBody} = {}) {
    const origin = internal ? 'https://app-access.internal' : authOrigin;
    const response = await service.fetch(new Request(origin + path, {method,
      headers: {'content-type':'application/json','cf-connecting-ip':ip, ...(internal ? {} : {origin:authOrigin,'sec-fetch-site':'same-origin',cookie:cookies}), ...headers},
      ...(method === 'POST' ? {body: rawBody ?? JSON.stringify(body)} : {})}), env);
    if(!internal && cookies === cookieHeader()) for (const item of response.headers.getSetCookie()) {
      const [pair] = item.split(';'), at = pair.indexOf('=');
      if(pair.slice(at+1)) cookieJar.set(pair.slice(0,at),pair.slice(at+1)); else cookieJar.delete(pair.slice(0,at));
    }
    return response;
  }
  async function flow(audience=siteOrigin, returnPath='/apps/vault', opts={}) {
    const state=randomToken(), verifier=randomToken();
    const response = await request('/__app_access/prepare', {audience,returnPath,state,verifierHash:await hashToken(verifier)}, {internal:true,...opts});
    assert.equal(response.status,200,await response.clone().text());
    const prepared = await response.json();
    const bootstrap = await request('/api/app-access/bootstrap?flow='+prepared.flowId, undefined, opts);
    assert.equal(bootstrap.status,200,await bootstrap.clone().text());
    return {...await bootstrap.json(),audience,returnPath,state,verifier};
  }
  const mutation = (action, f, body={}, opts={}) => request('/api/app-access/'+action,{flowId:f.flowId,csrf:f.csrf,...body},opts);
  async function code(f,email='review@example.test',opts={}) {
    const response=await mutation('request-code',f,{email,marketingOptIn:false},opts);
    assert.equal(response.status,202,await response.clone().text());
    return {...await response.json(),code:messages.at(-1).code};
  }
  async function verify(f,c,opts={}) { return mutation('verify-code',f,{challengeId:c.challengeId,code:c.code},opts); }
  function handoff(f,data) {const url=new URL(data.redirectTo);assert.equal(url.origin,f.audience);assert.equal(url.hash,'#_');return {code:url.searchParams.get('code'),state:f.state,audience:f.audience,verifier:f.verifier};}
  async function login(audience=siteOrigin,returnPath='/apps/vault',email='review@example.test') {
    const f=await flow(audience,returnPath), c=await code(f,email), result=await verify(f,c);
    assert.equal(result.status,200,await result.clone().text());
    const exchange=handoff(f,await result.json());
    const response=await request('/__app_access/redeem',exchange,{internal:true});
    assert.equal(response.status,200,await response.clone().text());
    return {flow:f,code:c,exchange,...await response.json()};
  }
  return {sqlite,env,messages,request,flow,mutation,code,verify,handoff,login,
    cookies:cookieHeader,advance:delta=>{time+=delta;},now:()=>time,
    internal:(action,body)=>request('/__app_access/'+action,body,{internal:true}),
    count:table=>sqlite.prepare('SELECT count(*) AS n FROM '+table).get().n};
}

test('review: concurrent correct OTP attempts create exactly one user and one session family', async t => {
  const f=fixture(t), flow=await f.flow(), code=await f.code(flow);
  const responses=await Promise.all(Array.from({length:12},()=>f.verify(flow,code)));
  assert.equal(responses.filter(r=>r.status===200).length,1);
  assert.equal(f.count('va_users'),1); assert.equal(f.count('va_sso_sessions'),1); assert.equal(f.count('va_handoffs'),1);
  assert.ok(f.sqlite.prepare('SELECT attempts FROM va_email_challenges').get().attempts<=5);
  assert.equal((await f.verify(flow,code)).status,401);
  const user=f.sqlite.prepare('SELECT * FROM va_users').get();
  assert.equal(user.updates_opt_in,0);assert.equal(user.updates_consent_at,null);
  assert.equal(JSON.stringify(user).includes('review@example.test'),false);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'vx_%'").get().n,0);
});

test('review: parallel wrong guesses exhaust five attempts without creating an account',async t=>{
  const f=fixture(t),flow=await f.flow(),code=await f.code(flow),wrong={...code,code:code.code==='00000000'?'00000001':'00000000'};
  const responses=await Promise.all(Array.from({length:10},()=>f.verify(flow,wrong)));
  assert.ok(responses.every(r=>r.status===401));
  assert.equal(f.sqlite.prepare('SELECT attempts FROM va_email_challenges').get().attempts,5);
  assert.equal((await f.verify(flow,code)).status,401);assert.equal(f.count('va_users'),0);
});

test('review: replacement code retires prior challenges, including another sign-in flow',async t=>{
  const f=fixture(t),first=await f.flow(),old=await f.code(first);
  f.advance(61_000);
  const second=await f.flow(),fresh=await f.code(second);
  assert.equal((await f.verify(first,old)).status,401);
  assert.equal((await f.verify(first,fresh)).status,401);
  assert.equal((await f.verify(second,old)).status,401);
  assert.equal((await f.verify(second,fresh)).status,200);
});

test('review: browser binding and exact origin prevent sibling-host and cross-browser login CSRF',async t=>{
  const f=fixture(t),flow=await f.flow(),code=await f.code(flow);
  const foreign='__Host-vellivex_apps_browser='+randomToken();
  assert.equal((await f.request('/api/app-access/bootstrap?flow='+flow.flowId,undefined,{cookies:foreign})).status,401);
  assert.equal((await f.verify(flow,code,{cookies:foreign})).status,401);
  assert.equal((await f.verify(flow,code,{cookies:''})).status,401);
  assert.equal((await f.verify({...flow,csrf:randomToken()},code)).status,401);
  for(const origin of ['https://vellivex.com','https://call.vellivex.com.attacker.test','null','http://call.vellivex.com']) {
    assert.equal((await f.verify(flow,code,{headers:{origin}})).status,400);
  }
  assert.equal((await f.verify(flow,code,{headers:{'sec-fetch-site':'same-site'}})).status,400);
  assert.equal((await f.verify(flow,code)).status,200);
});

test('review: handoff audience, state and verifier are all mandatory and concurrent redemption is single-use',async t=>{
  const f=fixture(t),flow=await f.flow(),code=await f.code(flow),verified=await f.verify(flow,code);
  const exchange=f.handoff(flow,await verified.json());
  for(const patch of [{audience:'https://vkey.vellivex.com'},{state:randomToken()},{verifier:randomToken()}])assert.equal((await f.internal('redeem',{...exchange,...patch})).status,401);
  assert.equal(f.count('va_app_sessions'),0);
  const replies=await Promise.all(Array.from({length:8},()=>f.internal('redeem',exchange)));
  assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal(f.count('va_app_sessions'),1);
  const session=await replies.find(r=>r.status===200).json();
  assert.equal((await f.internal('validate',{sessionToken:session.sessionToken,audience:'https://vkey.vellivex.com'})).status,401);
  const validation=await f.internal('validate',{sessionToken:session.sessionToken,audience:flow.audience});
  assert.equal(validation.status,200);
  const result=await validation.json();
  assert.equal(result.scope.appAccess,true);assert.equal(JSON.stringify(result).includes('review@example.test'),false);
  assert.equal(await validateAppScope(result.scope,f.env,{audience:flow.audience,now:f.now}),true);
  assert.equal(await validateAppScope({...result.scope,appAccess:false},f.env,{audience:flow.audience,now:f.now}),false);
});

test('review: logout revokes sessions on multiple hosts and outstanding handoffs as one family',async t=>{
  const f=fixture(t),first=await f.login();
  const second=await f.flow('https://vkey.vellivex.com','/');
  assert.equal(second.signedIn,true);
  const continued=await f.mutation('continue',second);assert.equal(continued.status,200);
  const response=await f.internal('redeem',f.handoff(second,await continued.json()));assert.equal(response.status,200);
  const secondSession=await response.json();
  const pendingFlow=await f.flow('https://private.vellivex.com','/');
  const pendingResponse=await f.mutation('continue',pendingFlow);assert.equal(pendingResponse.status,200);
  const pending=f.handoff(pendingFlow,await pendingResponse.json());
  const logoutFlow=await f.flow(),logout=await f.mutation('logout',logoutFlow);
  assert.equal(logout.status,200);assert.equal(f.count('va_sso_sessions'),0);assert.equal(f.count('va_app_sessions'),0);assert.equal(f.count('va_handoffs'),0);
  for(const [audience,sessionToken] of [[siteOrigin,first.sessionToken],[second.audience,secondSession.sessionToken]])assert.equal((await f.internal('validate',{audience,sessionToken})).status,401);
  assert.equal((await f.internal('redeem',pending)).status,401);
  assert.equal(f.count('va_users'),1);
});

test('review: disabled users, changed epochs and expiration invalidate already-issued app tokens',async t=>{
  const f=fixture(t),session=await f.login();
  const validate=()=>f.internal('validate',{audience:siteOrigin,sessionToken:session.sessionToken});
  assert.equal((await validate()).status,200);
  f.sqlite.exec('UPDATE va_users SET disabled=1');assert.equal((await validate()).status,401);
  f.sqlite.exec('UPDATE va_users SET disabled=0,epoch=epoch+1');assert.equal((await validate()).status,401);
  f.sqlite.exec('UPDATE va_users SET epoch=epoch-1');assert.equal((await validate()).status,200);
  f.advance(30*24*60*60*1000);assert.equal((await validate()).status,401);
});

test('review: public requests cannot call private broker endpoints or extend handoff expiration',async t=>{
  const f=fixture(t),flow=await f.flow(),code=await f.code(flow),verified=await f.verify(flow,code),exchange=f.handoff(flow,await verified.json());
  for(const action of ['prepare','redeem','validate'])assert.equal((await f.request('/__app_access/'+action,exchange)).status,404);
  f.advance(60_001);assert.equal((await f.internal('redeem',exchange)).status,401);assert.equal(f.count('va_app_sessions'),0);
});

test('review: failed email delivery and free sender quotas cannot create unverified accounts',async t=>{
  const failed=fixture(t,{mailFailure:true}),flow=await failed.flow();
  assert.equal((await failed.mutation('request-code',flow,{email:'review@example.test',marketingOptIn:false})).status,503);
  assert.equal(failed.count('va_users'),0);
  const challenge=failed.sqlite.prepare('SELECT * FROM va_email_challenges').get();assert.equal(challenge.delivery,'failed');assert.equal(challenge.used,1);
  const limited=fixture(t,{budgets:{daily:2,monthly:2}}),requests=[];
  for(let i=0;i<5;i++){const fresh=await limited.flow();requests.push(limited.mutation('request-code',fresh,{email:`review${i}@example.test`,marketingOptIn:false}));}
  const results=await Promise.all(requests);
  assert.equal(results.filter(r=>r.status===202).length,2);assert.equal(results.filter(r=>r.status===429).length,3);
  assert.equal(limited.messages.length,2);assert.equal(limited.count('va_users'),0);
  assert.ok(limited.sqlite.prepare('SELECT sent FROM va_mail_budget').all().every(row=>row.sent<=2));
});

test('review: account-management grant is single-use and cannot authorize an app or a later session',async t=>{
  const f=fixture(t),first=await f.login(),response=await f.request('/api/app-access/bootstrap');
  assert.equal(response.status,200);
  const grant=await response.json(),oldCookies=f.cookies();
  assert.equal(grant.management,true);assert.equal(grant.signedIn,true);
  assert.equal((await f.mutation('continue',grant)).status,401);
  assert.equal((await f.mutation('request-code',grant,{email:'review@example.test',marketingOptIn:false})).status,401);
  assert.equal(f.messages.length,1);
  const concurrent=await Promise.all(Array.from({length:6},()=>f.mutation('logout',grant,{}, {cookies:oldCookies})));
  assert.equal(concurrent.filter(r=>r.status===200).length,1);
  assert.equal(f.count('va_logout_flows'),0);assert.equal(f.count('va_sso_sessions'),0);
  assert.equal((await f.internal('validate',{audience:siteOrigin,sessionToken:first.sessionToken})).status,401);
  f.advance(61_000);
  const second=await f.login();
  assert.equal((await f.mutation('logout',grant)).status,401);
  assert.equal((await f.internal('validate',{audience:siteOrigin,sessionToken:second.sessionToken})).status,200);
});
