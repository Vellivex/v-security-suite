// SPDX-License-Identifier: GPL-3.0-or-later
// One-off real Firefox/WebKit production sessions. No credentials, relay service,
// real conversations, screenshots, traces, SDP, invitation or code logging.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {firefox,webkit} from 'playwright';

const WAIT=65000;
const apps=[
  {name:'VKey',url:'https://vkey.vellivex.com/',create:'#create-btn',invite:'#share-link',joinInput:'#invite-input',join:'#join-btn',accept:'#accept-btn',code:'#full-fingerprint',verify:'#verify-btn',message:'#message-input',send:'#send-btn',end:'#end-btn',status:'#session-status'},
  {name:'Private',url:'https://private.vellivex.com/',create:'#start',invite:'#invitation',joinInput:'#invitation',join:'#join',accept:'#accept',code:'#code',verify:'#confirm',message:'#message',send:'#send',end:'#end',status:'#status'},
];
const blocked=message=>Object.assign(new Error(message),{name:'EnvironmentBlocked'});
const wait=(page,fn,timeout=WAIT)=>page.waitForFunction(fn,null,{timeout});
async function waitForCleanup(results,pending){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    await Promise.allSettled(pending);
    if(results.some(result=>result.acknowledged))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
const redact=text=>String(text).replace(/https?:\/\/\S+/g,'[link]').replace(/[A-Za-z0-9_-]{40,}/g,'[redacted]').slice(0,240);
async function safeStatus(page,app){try{return redact(await page.locator(app.status).textContent({timeout:1000}));}catch{return 'unavailable';}}
async function prepare(page,app,who){
  if(app.name==='VKey')await page.locator('#display-name').fill('QA '+who);
  else await page.locator('#consent').check();
}
async function enableTyping(page,app){
  if(app.name==='VKey')await page.locator('#keyboard-toggle').click();
  else await page.locator('#typing').check();
  await page.waitForFunction(selector=>document.querySelector(selector)?.readOnly===false,app.message,{timeout:5000});
}
async function clearState(page,app){
  if(app.name==='VKey')await wait(page,()=>document.querySelector('#ended')?.hidden===false,15000);
  else await wait(page,()=>document.querySelector('#status')?.textContent.includes('cleared'),15000);
  assert.equal((await page.locator('#messages').textContent()).trim(),'');
  assert.equal(await page.locator(app.message).inputValue(),'');
  assert.equal((await page.locator(app.code).textContent()).trim(),'');
}
async function capability(page){
  return page.evaluate(async()=>{
    const result={secure:isSecureContext,peer:typeof RTCPeerConnection==='function',data:typeof RTCDataChannel==='function',offer:false,localCandidates:0};
    if(!result.secure||!result.peer||!result.data)return result;
    const pc=new RTCPeerConnection({iceServers:[]});
    try{
      pc.createDataChannel('synthetic-preflight');
      await pc.setLocalDescription(await pc.createOffer());result.offer=true;
      await new Promise(resolve=>{const timeout=setTimeout(resolve,3500);pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timeout);resolve();}});if(pc.iceGatheringState==='complete'){clearTimeout(timeout);resolve();}});
      result.localCandidates=(pc.localDescription?.sdp.match(/^a=candidate:/gm)||[]).length;
    }catch{result.offer=false;}finally{pc.close();}
    return result;
  });
}
async function session(app,hostBrowser,peerBrowser,hostName,peerName){
  const contexts=await Promise.all([hostBrowser.newContext({permissions:[],serviceWorkers:'block'}),peerBrowser.newContext({permissions:[],serviceWorkers:'block'})]);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));const [host,peer]=pages;
  const cleanup=[],responseWork=[],errors=[];let stage='opening',outcome='FAIL';
  const label=app.name+' '+hostName+' host -> '+peerName+' guest';
  for(const page of pages){
    page.on('pageerror',()=>errors.push('browser-script-error'));
    page.on('response',response=>{
      const request=response.request(),url=new URL(response.url());
      if(request.method()==='DELETE'&&url.origin===new URL(app.url).origin&&/^\/api\/rooms\/[^/]+$/.test(url.pathname)){
        const work=(async()=>{let okay=false;try{const body=await response.json();okay=response.status()===200&&body?.ok===true&&Object.keys(body).length===1;}catch{}cleanup.push({status:response.status(),acknowledged:okay});})();responseWork.push(work);
      }
    });
  }
  try{
    await Promise.all(pages.map(page=>page.goto(app.url,{waitUntil:'domcontentloaded',timeout:25000})));
    stage='native RTC capability';
    const capabilities=await Promise.all(pages.map(capability));
    console.log('CAPABILITY '+label+' '+JSON.stringify(capabilities));
    if(capabilities.some(c=>!c.secure||!c.peer||!c.data||!c.offer))throw blocked('A native engine cannot create an RTC data offer in this runner');
    stage='invitation';
    await prepare(host,app,'Host');await prepare(peer,app,'Guest');
    await host.locator(app.create).click();
    await host.waitForFunction(selector=>(document.querySelector(selector)?.value||'').includes('#v='),app.invite,{timeout:WAIT});
    const invitation=await host.locator(app.invite).inputValue();
    assert.equal(new URL(invitation).origin,new URL(app.url).origin);
    if(app.name==='VKey')await peer.locator('#join-details').evaluate(el=>{el.open=true;});
    await peer.locator(app.joinInput).fill(invitation);
    await peer.locator(app.join).click();
    stage='host approval';
    await host.locator(app.accept).waitFor({state:'visible',timeout:WAIT});
    assert.equal(await host.locator(app.send).isDisabled(),true);
    assert.equal(await peer.locator(app.send).isDisabled(),true);
    await host.locator(app.accept).click();
    stage='native encrypted connection';
    await Promise.all(pages.map(page=>page.waitForFunction(selector=>(document.querySelector(selector)?.textContent||'').length>=32,app.code,{timeout:WAIT})));
    const codes=await Promise.all(pages.map(page=>page.locator(app.code).textContent()));
    assert.ok(codes[0]&&codes[0]===codes[1],'Full connection codes differ');
    assert.equal(await host.locator(app.send).isDisabled(),true);
    assert.equal(await peer.locator(app.send).isDisabled(),true);
    stage='two independent confirmations';
    await host.locator(app.verify).click();
    assert.equal(await host.locator(app.send).isDisabled(),true);
    assert.equal(await peer.locator(app.send).isDisabled(),true);
    await peer.locator(app.verify).click();
    await Promise.all(pages.map(page=>page.waitForFunction(selector=>!document.querySelector(selector)?.disabled,app.send,{timeout:15000})));
    stage='messages both directions';
    for(const [sender,recipient,direction] of [[host,peer,'forward'],[peer,host,'reverse']]){
      const message='Vellivex fictional QA '+direction+' '+randomUUID();
      await enableTyping(sender,app);await sender.locator(app.message).fill(message);await sender.locator(app.send).click();
      await recipient.locator('#messages').getByText(message,{exact:false}).waitFor({state:'visible',timeout:15000});
    }
    stage='end and bilateral cleanup';
    await host.locator(app.end).click();
    await Promise.all(pages.map(page=>clearState(page,app)));
    await waitForCleanup(cleanup,responseWork);
    assert.ok(cleanup.some(result=>result.acknowledged),'No server cleanup acknowledgement observed');
    assert.deepEqual(errors,[],'Browser script errors occurred');
    outcome='PASS';
    console.log('PASS '+label+': native transport, identical codes, confirmation gating, two-way fictional messages, both pages cleared, server cleanup acknowledged');
  }catch(error){
    const states=await Promise.all(pages.map(page=>safeStatus(page,app)));
    const environment=error.name==='EnvironmentBlocked'||states.some(s=>/could not find a direct|no direct|network.*not available|Try another browser or network|use a different network/i.test(s));
    outcome=environment?'BLOCKED':'FAIL';
    console.log(outcome+' '+label+' stage='+stage+' errorType='+error.name+' states='+JSON.stringify(states)+' cleanup='+JSON.stringify(cleanup));
  }finally{
    // Use each app's normal End action even after partial setup. Never print or
    // export room capabilities, invitations, fingerprints or ephemeral messages.
    if(outcome!=='PASS')for(const page of pages){try{const end=page.locator(app.end);if(await end.isVisible()&&await end.isEnabled())await end.click({timeout:2000});}catch{}}
    await Promise.allSettled(responseWork);
    await Promise.allSettled(contexts.map(context=>context.close()));
  }
  return {app:app.name,host:hostName,guest:peerName,outcome};
}

let left,right;const outcomes=[];
try{
  left=await firefox.launch({headless:true});right=await webkit.launch({headless:true});
  console.log('NATIVE ENGINES '+JSON.stringify({firefox:left.version(),webkit:right.version()}));
  for(const app of apps){
    outcomes.push(await session(app,left,right,'Firefox','WebKit'));
    outcomes.push(await session(app,right,left,'WebKit','Firefox'));
  }
  console.log('RESULT '+JSON.stringify({outcomes,scope:'Native engines on one hosted runner; no physical phones or carrier-network coverage'}));
  if(outcomes.some(o=>o.outcome!=='PASS'))process.exitCode=1;
}catch(error){console.log('BLOCKED runner setup errorType='+error.name);process.exitCode=1;}
finally{await Promise.allSettled([left?.close(),right?.close()]);}
