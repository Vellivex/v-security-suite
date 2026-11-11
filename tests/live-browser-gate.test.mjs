import test from 'node:test';
import assert from 'node:assert/strict';
import {publicBrowserPreflight} from '../scripts/live-browser-gate.mjs';

const target='https://vkey.vellivex.com/';
function gate(headers={}) {
  return new Response(null,{headers:{'Content-Type':'text/html; charset=utf-8','X-Vellivex-App-Access':'required','Cache-Control':'no-store','Referrer-Policy':'no-referrer',...headers}});
}
test('healthy anonymous gate reports sign-in required and explicitly leaves browser functionality untested',async()=>{
  const messages=[],requests=[];
  const result=await publicBrowserPreflight('VKey',[target],{summaryPath:null,log:line=>messages.push(line),fetcher:async(url,init)=>{
    requests.push({url,init});return gate();
  }});
  assert.deepEqual(result,{deepChecks:'not-run',gateHealthy:true});
  assert.equal(requests.length,1);assert.equal(requests[0].init.method,'GET');
  assert.equal(requests[0].init.credentials,'omit');assert.equal(requests[0].init.redirect,'manual');
  assert.equal(requests[0].init.headers.Cookie,undefined);
  assert.match(messages.join('\n'),/AUTH GATE HEALTHY/);
  assert.match(messages.join('\n'),/SIGN-IN REQUIRED/);
  assert.match(messages.join('\n'),/Deep browser checks NOT RUN/);
  assert.equal(messages.some(line=>/\bPASS\b/.test(line)),false);
});
test('missing, cacheable, authenticated and redirected anonymous admission fail health instead of skipping as success',async()=>{
  for(const response of [
    gate({'X-Vellivex-App-Access':'verified'}),gate({'X-Vellivex-App-Access':''}),
    gate({'Cache-Control':'public, max-age=300'}),gate({'Referrer-Policy':'origin'}),
    new Response(null,{status:302,headers:{Location:'https://call.vellivex.com/access'}}),
    new Response(null,{status:503}),
  ]){
    const logs=[];
    await assert.rejects(publicBrowserPreflight('VKey',[target],{summaryPath:null,log:line=>logs.push(line),fetcher:async()=>response}),/availability contract/);
    assert.match(logs.join('\n'),/ADMISSION CHECK FAILED/);
    assert.match(logs.join('\n'),/Deep browser checks NOT RUN/);
  }
});
test('public preflight never accepts a private path, arbitrary host, query, fragment or non-app target',async()=>{
  let requests=0;
  for(const url of ['https://attacker.example/','https://vkey.vellivex.com/api/rooms',target+'?token=private',target+'#private','https://www.vellivex.com/'])
    await assert.rejects(publicBrowserPreflight('VKey',[url],{summaryPath:null,log:()=>{},fetcher:async()=>{requests++;return gate();}}),TypeError);
  assert.equal(requests,0);
});
test('a stalled response cancellation cannot hang the read-only gate report',async()=>{
  const result=await publicBrowserPreflight('VKey',[target],{summaryPath:null,log:()=>{},fetcher:async()=>({
    status:200,url:target,headers:gate().headers,body:{cancel:()=>new Promise(()=>{})}
  })});
  assert.equal(result.deepChecks,'not-run');
});
