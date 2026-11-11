// SPDX-License-Identifier: GPL-3.0-or-later
import '/site.js';

// Live service client. It never creates fictional addresses or message data.
const $=id=>document.getElementById(id);
const origin=location.origin;
const lifetime=600000,maximumMessages=10,maximumTextBytes=20*1024;
// JSON may expand each permitted control byte into a six-byte Unicode escape.
const maximumResponseBytes=maximumMessages*(maximumTextBytes+320+256)*6+8192;
const encoder=new TextEncoder();
let serviceReady=false,publicSignupReady=false,inbox=null,generation=0,pending=null,clock=null;
let pageRetired=false,challenge=null,widgetId=null,widgetEpoch=0,widgetFailed=false;
let loaderState='idle',loaderEpoch=0,loaderScript=null,loaderTimer=null;
const say=message=>{$('mail-status').textContent=message;};
function clearViewer(){ $('mail-message-heading').textContent='Choose a message';$('mail-from').textContent='';$('mail-body').textContent='Messages display here as plain text. Remote images and attachments are not loaded.'; }
function freshChallenge(){return challenge&&Date.now()<challenge.deadline&&performance.now()<challenge.elapsedDeadline;}
function buttons(){const has=!!inbox;$('mail-create').disabled=pageRetired||!serviceReady||has||!!pending||!(publicSignupReady&&freshChallenge());$('mail-copy').disabled=!has;$('mail-refresh').disabled=!has||!!pending;$('mail-delete').disabled=!has;const retry=$('mail-bot-retry');if(retry){retry.hidden=!publicSignupReady||has;retry.disabled=pageRetired||!serviceReady||has||!!pending||loaderState==='loading';}}
function clearLocal(reason){generation++;pending?.abort();pending=null;inbox=null;$('mail-address').value='No active inbox';$('mail-expiry').textContent='Not created';$('mail-messages').replaceChildren();$('mail-count').textContent='0 messages';$('mail-empty').hidden=false;clearViewer();buttons();say(reason);ensureWidget();}
function remaining(){return Math.min(inbox.deadline-Date.now(),inbox.elapsedDeadline-performance.now());}
function active(){if(inbox&&remaining()<=0)clearLocal('Inbox expired. It can no longer be read or receive new messages. Provider backup retention is separate.');return !!inbox;}
function validHex(value,length){return typeof value==='string'&&value.length===length&&!/[^0-9a-f]/.test(value);}
function validBox(data){
  if(!data||!validHex(data.id,32)||typeof data.address!=='string'||data.address.length>254||data.address.slice(0,34)!=='v'+data.id+'@')return false;
  const domain=data.address.slice(34),labels=domain.split('.');
  return !/[^a-z0-9.-]/.test(domain)&&labels.length>=2&&labels.every(label=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))&&Number.isSafeInteger(data.createdAt)&&data.createdAt>=0&&Number.isSafeInteger(data.expiresAt)&&data.expiresAt-data.createdAt===lifetime;
}
function boundedText(value,maximumBytes){return typeof value==='string'&&encoder.encode(value).byteLength<=maximumBytes;}
function retireWidget(){
  challenge=null;widgetEpoch++;
  const previous=widgetId;widgetId=null;
  if(previous!==null){try{window.turnstile?.remove(previous);}catch{widgetFailed=true;}}
}
function verificationUnavailable(){challenge=null;widgetFailed=true;buttons();if(!inbox&&!pending&&!pageRetired)say('Verification is unavailable. Select Retry verification. No inbox has been created.');}
function renderWidget(){
  if(pageRetired||!serviceReady||!publicSignupReady||inbox||pending||widgetId!==null||widgetFailed)return;
  const container=$('mail-bot-check'),sitekey=$('mail-app').dataset.turnstileSitekey;
  if(!container||typeof sitekey!=='string'||!sitekey||sitekey.length>128||typeof window.turnstile?.render!=='function'||typeof window.turnstile?.remove!=='function'){verificationUnavailable();return;}
  const revision=++widgetEpoch;
  const current=()=>!pageRetired&&revision===widgetEpoch&&serviceReady&&publicSignupReady&&!inbox;
  const unavailable=()=>{if(current()){retireWidget();verificationUnavailable();}};
  try{
    widgetId=window.turnstile.render(container,{
      sitekey,action:'vmail_create',theme:'auto',size:'flexible','response-field':false,
      retry:'never','refresh-expired':'manual','refresh-timeout':'manual',
      callback:token=>{if(!current()||pending)return;if(typeof token!=='string'||!token||token.length>2048){unavailable();return;}challenge={value:token,deadline:Date.now()+290000,elapsedDeadline:performance.now()+290000};buttons();say('Verification complete. Select Create inbox.');},
      'expired-callback':()=>{if(current()){retireWidget();widgetFailed=true;buttons();say('Verification expired. Select Retry verification before creating an inbox.');}},
      'timeout-callback':unavailable,'error-callback':unavailable,'unsupported-callback':unavailable
    });
    if(typeof widgetId!=='string'||!widgetId){retireWidget();verificationUnavailable();}
  }catch{retireWidget();verificationUnavailable();}
}
function ensureWidget(){
  const container=$('mail-bot-check');if(container)container.hidden=!publicSignupReady||!!inbox;
  if(pageRetired||!serviceReady||!publicSignupReady||inbox||pending||widgetFailed)return;
  const sitekey=$('mail-app').dataset.turnstileSitekey;
  if(!container||typeof sitekey!=='string'||!sitekey||sitekey.length>128){verificationUnavailable();return;}
  if(typeof window.turnstile?.render==='function'){loaderState='ready';renderWidget();return;}
  if(loaderState==='loading'||loaderState==='failed')return;
  loaderState='loading';const revision=++loaderEpoch;
  const script=document.createElement('script');loaderScript=script;script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.defer=true;
  const failed=()=>{if(revision!==loaderEpoch)return;loaderEpoch++;clearTimeout(loaderTimer);loaderTimer=null;loaderState='failed';try{script.remove();}catch{}verificationUnavailable();};
  script.addEventListener('load',()=>{if(revision!==loaderEpoch||pageRetired)return;clearTimeout(loaderTimer);loaderTimer=null;if(typeof window.turnstile?.render!=='function'){failed();return;}loaderState='ready';renderWidget();buttons();});
  script.addEventListener('error',failed);
  loaderTimer=setTimeout(failed,12000);
  try{document.head.append(script);}catch{failed();}
  buttons();
}
function retryVerification(){
  if(pageRetired||pending||inbox||!serviceReady||!publicSignupReady)return;
  retireWidget();widgetFailed=false;
  if(loaderState==='failed'){loaderState='idle';try{loaderScript?.remove();}catch{}}
  say('Complete the verification check, then select Create inbox.');ensureWidget();buttons();
}
async function readResponse(response,maximumBytes){
  const reader=response.body?.getReader();if(!reader)throw Error('Mail service response is unavailable.');
  const chunks=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maximumBytes)throw Error('Mail response is too large.');chunks.push(value);}}
  catch(error){try{reader.cancel().catch(()=>{});}catch{}throw error;}
  finally{try{reader.releaseLock();}catch{}}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Mail service returned an invalid response.');}
}
async function request(path,{method='GET',token,signal,jsonBody}={}){
  if(!/^\/api\/(?:status|inbox(?:\/[0-9a-f]{32})?)$/.test(path))throw Error('Mail service configuration is unavailable.');
  const endpoint=new URL('/api/mail/'+path.slice(5),origin);if(endpoint.origin!==origin||endpoint.protocol!=='https:')throw Error('Mail service configuration is unavailable.');
  const headers={};if(token)headers.Authorization='Bearer '+token;if(jsonBody!==undefined)headers['Content-Type']='application/json';
  let response;
  try{response=await fetch(endpoint.href,{method,headers,...(jsonBody===undefined?{}:{body:JSON.stringify(jsonBody)}),signal,cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error',referrerPolicy:'no-referrer'});}
  catch(error){if(error.name==='AbortError')throw error;throw Error('Mail service could not be reached. Wait 10 seconds, then try again. Keep this tab open.');}
  if(!response.ok){
    let problem=null;
    if(response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()==='application/json'){try{problem=await readResponse(response,4096);}catch{}}
    else{try{response.body?.cancel().catch(()=>{});}catch{}}
    if(response.status===404)throw Object.assign(Error('Inbox is unavailable, deleted or expired.'),{status:404});
    if(response.status===401&&!token)throw Error('Your Vellivex sign-in has expired. Open this app again to sign in before creating an inbox.');
    if(response.status===429&&problem?.error==='daily_limit'){
      let reset='after the next UTC midnight';
      if(Number.isSafeInteger(problem.resetAt)&&problem.resetAt>=0&&problem.resetAt<=8640000000000000)reset='after '+new Date(problem.resetAt).toISOString().slice(0,16).replace('T',' ')+' UTC';
      throw Error('The daily public inbox limit has been reached. Please return '+reset+'.');
    }
    if(response.status===429&&problem?.error==='capacity')throw Error('No inbox capacity is available in this beta right now. Please try again later.');
    if(response.status===429)throw Error('Mail requests are limited or the beta is full. Wait 10 seconds, then try again.');
    if(response.status===403&&problem?.error==='public_signup_paused')throw Object.assign(Error('Public inbox creation is paused. Please try again later.'),{code:'public_signup_paused'});
    if(response.status===403&&problem?.error==='verification_failed')throw Error('Verification failed or expired. Complete a new check and try again.');
    if(response.status===403)throw Error('Receiving is paused or verification failed.');
    throw Error('Mail service is temporarily unavailable. Wait 10 seconds, then try again.');
  }
  const expectedStatus=method==='POST'?201:method==='DELETE'?204:200;
  if(response.status!==expectedStatus){try{response.body?.cancel().catch(()=>{});}catch{}throw Error(method==='DELETE'?'The service did not confirm deletion. Keep this tab open and try again.':'Mail service returned an unexpected response.');}
  if(response.status===204)return null;
  return readResponse(response,maximumResponseBytes);
}
async function operation(work){if(pending)return;const revision=generation;const control=new AbortController();pending=control;buttons();let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{if(revision===generation){generation++;say('Request timed out. We could not confirm the result. Keep this tab open and try again.');}control.abort();reject(Object.assign(Error('Request timed out.'),{name:'AbortError'}));},15000);});try{await Promise.race([work(control.signal,revision),deadline]);}catch(error){if(revision===generation){if(error.code==='public_signup_paused'){publicSignupReady=false;retireWidget();}if(error.status===404&&inbox)clearLocal('Inbox is unavailable, deleted or expired. Its address, access token and displayed messages have been cleared from this page.');else say(error.name==='AbortError'?'Request timed out. Try again.':error.message);}}finally{clearTimeout(timer);if(pending===control)pending=null;buttons();ensureWidget();}}
function renderMessages(messages){
  if(!Array.isArray(messages)||messages.length>maximumMessages||messages.some(m=>!m||!validHex(m.id,32)||!boundedText(m.from,320)||!boundedText(m.subject,256)||!boundedText(m.text,maximumTextBytes)))throw Error('Mail service returned invalid messages.');
  $('mail-messages').replaceChildren();clearViewer();$('mail-count').textContent=messages.length+(messages.length===1?' message':' messages');$('mail-empty').hidden=messages.length>0;
  const current=inbox;
  for(const message of messages){const button=document.createElement('button');button.type='button';button.className='mail-message';const subject=document.createElement('strong');subject.textContent=message.subject||'(No subject)';const sender=document.createElement('small');sender.textContent=message.from||'(Sender not provided)';button.append(subject,sender);button.addEventListener('click',()=>{if(inbox!==current||!active())return;$('mail-message-heading').textContent=message.subject||'(No subject)';$('mail-from').textContent=message.from;$('mail-body').textContent=message.text;$('mail-message-heading').tabIndex=-1;$('mail-message-heading').focus();});$('mail-messages').append(button);}
}
$('mail-create').addEventListener('click',()=>{
  if(pageRetired||pending||!serviceReady||active())return;
  if(!publicSignupReady||!freshChallenge()){if(publicSignupReady)retryVerification();else say('Public inbox creation is paused. Please try again later.');buttons();return;}
  const proof=challenge.value;
  // Consume the proof before sending. Removing/recreating the widget also retires
  // callbacks from this attempt, including an uncertain request acknowledgement.
  retireWidget();widgetFailed=false;
  operation(async(signal,revision)=>{
    say('Creating an inbox on the mail service…');
    const startedAt=Date.now(),elapsedAt=performance.now();
    const result=await request('/api/inbox',{method:'POST',jsonBody:{turnstileToken:proof},signal});
    if(revision!==generation)return;
    if(!validBox(result)||!validHex(result.token,64))throw Error('The service did not confirm an active inbox.');
    inbox={id:result.id,address:result.address,token:result.token,createdAt:result.createdAt,expiresAt:result.expiresAt,deadline:startedAt+lifetime,elapsedDeadline:elapsedAt+lifetime};
    $('mail-address').value=inbox.address;renderMessages([]);updateClock();
    say('Inbox created. Copy its address, then select Refresh to check for mail. Keep this tab open; reloading loses its secret access token.');
  });
});
$('mail-bot-retry')?.addEventListener('click',retryVerification);
$('mail-refresh').addEventListener('click',()=>{if(!active())return;operation(async(signal,revision)=>{say('Checking for received mail…');const current=inbox;const result=await request('/api/inbox/'+current.id,{token:current.token,signal});if(revision!==generation||!active())return;if(!validBox(result)||result.id!==current.id||result.address!==current.address||result.expiresAt!==current.expiresAt)throw Error('The service returned a different inbox.');renderMessages(result.messages);say('Inbox refreshed from the mail service.');});});
$('mail-delete').addEventListener('click',()=>{if(!active())return;const current=inbox;generation++;pending?.abort();pending=null;operation(async(signal,revision)=>{say('Deleting this inbox and its stored messages…');await request('/api/inbox/'+current.id,{method:'DELETE',token:current.token,signal});if(revision===generation)clearLocal('Inbox deleted. New mail is refused. Copies held by senders, mail providers or backups are outside this deletion.');});});
$('mail-copy').addEventListener('click',async()=>{if(!active())return;const revision=generation;const address=inbox.address;try{await navigator.clipboard.writeText(address);if(revision===generation&&active())say('Address copied. Deleting the inbox does not clear your clipboard.');}catch{if(revision===generation&&active())say('Copy is unavailable. Select the address manually.');}});
function updateClock(){
  if(challenge&&!freshChallenge()){retireWidget();widgetFailed=true;buttons();if(!inbox&&!pending)say('Verification expired. Select Retry verification before creating an inbox.');}
  if(!active())return;
  const seconds=Math.ceil(remaining()/1000);$('mail-expiry').textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+' left';
}
function startClock(){clearInterval(clock);clock=setInterval(updateClock,1000);}
async function status(){
  serviceReady=false;publicSignupReady=false;buttons();
  if(!origin){say('Mail activation is in progress. Receiving-domain setup is required before an address can be created.');return;}
  await operation(async(signal,revision)=>{
    const result=await request('/api/status',{signal});if(revision!==generation)return;
    serviceReady=result?.receivingEnabled===true;publicSignupReady=serviceReady&&result?.publicSignupEnabled===true;
    say(!serviceReady?'Receiving is paused. New inbox creation is disabled; an existing active inbox can still be read or deleted.':publicSignupReady?'Complete the verification check, then select Create inbox.':'Public inbox creation is paused. Please try again later.');
  });
}
window.addEventListener('pagehide',()=>{
  pageRetired=true;clearInterval(clock);retireWidget();loaderEpoch++;clearTimeout(loaderTimer);loaderTimer=null;
  if(loaderState==='loading'){loaderState='idle';try{loaderScript?.remove();}catch{}}
  clearLocal('Inbox view closed. The server inbox still expires at its original deadline.');
});
window.addEventListener('pageshow',event=>{if(event.persisted){pageRetired=false;serviceReady=false;publicSignupReady=false;widgetFailed=false;clearLocal('Restored page cleared. The previous secret access token is no longer in this view.');startClock();status();}});
buttons();startClock();status();
