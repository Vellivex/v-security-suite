// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const mail=await readFile(new URL('../web/mail-ui.js',import.meta.url),'utf8');
const sms=await readFile(new URL('../web/sms-ui.js',import.meta.url),'utf8');
function mailClient(respond){
 const calls=[];
 const context=vm.createContext({URL,TextDecoder,Uint8Array,fetch:async(url,options)=>{calls.push({url,options});return respond(url,options);}});
 const transport=mail.slice(mail.indexOf('async function readResponse('),mail.indexOf('async function operation('));
 vm.runInContext("const origin='https://www.vellivex.com';const maximumResponseBytes=2000000;"+transport+';globalThis.mailRequest=request;',context);
 return {request:context.mailRequest,calls};
}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('mail status and inbox creation use the protected same-origin proxy and retain the bot proof',async()=>{
 const client=mailClient((url,options)=>json({ok:true},options.method==='POST'?201:200));
 await client.request('/api/status');await client.request('/api/inbox',{method:'POST',jsonBody:{turnstileToken:'proof'}});
 assert.deepEqual(client.calls.map(call=>call.url),['https://www.vellivex.com/api/mail/status','https://www.vellivex.com/api/mail/inbox']);
 for(const {options} of client.calls){assert.equal(options.credentials,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.headers.Authorization,undefined);}
 assert.equal(client.calls[1].options.body,'{"turnstileToken":"proof"}');
});
test('mail inbox reads and deletion retain their independent bearer capability',async()=>{
 const id='a'.repeat(32),token='b'.repeat(64),client=mailClient((url,options)=>options.method==='DELETE'?new Response(null,{status:204}):json({messages:[]}));
 assert.equal((await client.request('/api/inbox/'+id,{token})).messages.length,0);
 assert.equal(await client.request('/api/inbox/'+id,{token,method:'DELETE'}),null);
 for(const {url,options} of client.calls){assert.equal(url,'https://www.vellivex.com/api/mail/inbox/'+id);assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.credentials,'same-origin');}
});
test('mail transport cannot send an inbox capability to an external or unexpected route',async()=>{
 const client=mailClient(()=>{throw Error('Must not fetch');});
 for(const path of ['https://other.test/api/inbox','//other.test/api/inbox','/api/../private','/api/inbox?token=secret','/api/inbox/'+'a'.repeat(32)+'/extra','/api/status#secret'])await assert.rejects(client.request(path,{token:'secret'}),/configuration/);
 assert.equal(client.calls.length,0);
});
test('expired account admission produces a useful create error without treating it as inbox expiry',async()=>{
 const client=mailClient(()=>json({error:'app_access_required'},401));
 await assert.rejects(client.request('/api/inbox',{method:'POST',jsonBody:{turnstileToken:'proof'}}),error=>error.status!==404&&/sign-in has expired/.test(error.message));
});
test('mail transport preserves inbox-not-found and deletion acknowledgement checks',async()=>{
 const id='a'.repeat(32);
 await assert.rejects(mailClient(()=>json({error:'not_found'},404)).request('/api/inbox/'+id,{token:'capability'}),error=>error.status===404);
 await assert.rejects(mailClient(()=>json({ok:true},200)).request('/api/inbox/'+id,{token:'capability',method:'DELETE'}),/did not confirm deletion/);
});
for(const provider of ['onlinesim','gvpn'])test(`public SMS ${provider} requests use same-origin app credentials and preserve scope`,async()=>{
 const calls=[],messages=[];
 const context=vm.createContext({URLSearchParams,AbortController,Error,TypeError,SyntaxError,Promise,setTimeout,clearTimeout,
  fetch:async(endpoint,options)=>{calls.push({endpoint,options});return json({},503);},
  smsSay:value=>messages.push(value),smsButtons(){},smsClearView(){},smsClearCatalog(){},smsCooldown(){},smsValidate(){throw Error('Must not parse denied response');},smsReadResponse(){throw Error('Must not read denied response');},smsRender(){throw Error('Must not render denied response');}
 });
 const source=sms.slice(sms.indexOf('function smsDialCode('),sms.indexOf('function smsNational('));
 const load=sms.slice(sms.indexOf('async function smsLoad('),sms.indexOf("smsElement('sms-provider').addEventListener"));
 vm.runInContext(`let smsRetired=false,smsApiReady=true,smsProvider='${provider}',smsGeneration=0,smsPending=null,smsScope={};const smsRefreshDelay=30000;${source}${load};globalThis.load=smsLoad;`,context);
 const country=provider==='onlinesim'?'44':'gb';await context.load({country,number:'7000000000'});
 assert.equal(calls.length,1);assert.equal(calls[0].endpoint,(provider==='onlinesim'?'/api/public-sms':'/api/public-sms-extra')+'?country='+country+'&number=7000000000');
 const {options}=calls[0];assert.equal(options.credentials,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers.Accept,'application/json');assert.ok(messages.some(value=>value.includes('unavailable')));
});
