// SPDX-License-Identifier: GPL-3.0-or-later
import '/site.js';

// A reader for public, provider-listed numbers. No number is created or reserved.
const smsElement=id=>document.getElementById(id);
const smsEncoder=new TextEncoder();
const smsResponseLimit=512*1024;
const smsRefreshDelay=30000;
const smsApiReady=smsElement('sms-app').dataset.apiPath==='/api/public-sms';
let smsProvider=smsElement('sms-provider').value;
let smsCatalog=[],smsNumbers=[],smsCurrent=null,smsScope={};
let smsGeneration=0,smsPending=null,smsRetired=false,smsRefreshAt=0,smsCooldownTimer=null;

function smsSay(value){smsElement('sms-status').textContent=value;}
function smsWellFormed(value){
  for(let index=0;index<value.length;index++){
    const code=value.charCodeAt(index);
    if(code>=0xd800&&code<=0xdbff){const low=value.charCodeAt(++index);if(!(low>=0xdc00&&low<=0xdfff))return false;}
    else if(code>=0xdc00&&code<=0xdfff)return false;
  }
  return true;
}
function smsText(value,limit,{empty=true}={}){
  return typeof value==='string'&&(empty||value.length>0)&&smsWellFormed(value)&&smsEncoder.encode(value).byteLength<=limit;
}
function smsRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function smsDialCode(value){return typeof value==='string'&&/^[1-9][0-9]{0,3}$/.test(value);}
function smsSource(value){
  if(value==='onlinesim')return {endpoint:'/api/public-sms',provider:'OnlineSim',maxNumbers:1000,country:smsDialCode};
  if(value==='gvpn')return {endpoint:'/api/public-sms-extra',provider:'GetVirtualPhoneNumber',maxNumbers:500,country:value=>typeof value==='string'&&/^[a-z]{2}$/.test(value)};
  return null;
}
function smsNational(value){return typeof value==='string'&&/^[0-9]{4,15}$/.test(value);}
function smsValidate(data,wanted,source){
  if(!smsRecord(data)||data.provider!==source.provider||!Number.isSafeInteger(data.checkedAt)||data.checkedAt<0||data.checkedAt>8640000000000000||
      !Array.isArray(data.countries)||data.countries.length>100||!Array.isArray(data.numbers)||data.numbers.length>source.maxNumbers||
      !Array.isArray(data.messages)||data.messages.length>10||!smsText(data.restrictions,8192)||
      !Number.isSafeInteger(data.omittedMessages)||data.omittedMessages<0||data.omittedMessages>1000000)throw Error('invalid_data');
  const countries=new Set();
  for(const country of data.countries){
    if(!smsRecord(country)||!source.country(country.code)||!smsText(country.name,100,{empty:false})||countries.has(country.code)||
        source.provider==='GetVirtualPhoneNumber'&&(!smsDialCode(country.dialCode)||country.code==='gb'&&country.dialCode!=='44'))throw Error('invalid_data');
    countries.add(country.code);
  }
  if(!countries.size){
    if(data.country!==''&&data.country!==null||data.number!==null||data.numbers.length||data.messages.length||wanted.country||wanted.number)throw Error('invalid_data');
    return data;
  }
  if(!countries.has(data.country)||wanted.country&&wanted.country!==data.country)throw Error('invalid_scope');
  const selectedCountry=data.countries.find(country=>country.code===data.country);
  const dialCode=source.provider==='OnlineSim'?selectedCountry.code:selectedCountry.dialCode;
  const numbers=new Set();
  for(const number of data.numbers){
    if(!smsRecord(number)||!smsNational(number.national)||!/^\+[1-9][0-9]{6,14}$/.test(number.e164)||
        number.e164!=='+'+dialCode+number.national||!smsText(number.lastActivity,100)||numbers.has(number.national))throw Error('invalid_data');
    numbers.add(number.national);
  }
  if(data.number===null){if(data.messages.length||wanted.number)throw Error('invalid_scope');}
  else if(!numbers.has(data.number)||wanted.number&&wanted.number!==data.number)throw Error('invalid_scope');
  const ids=new Set();
  for(const message of data.messages){
    if(!smsRecord(message)||!smsText(message.id,64,{empty:false})||ids.has(message.id)||!smsText(message.sender,80)||
        !smsText(message.text,4096)||!smsText(message.receivedAt,48))throw Error('invalid_data');
    ids.add(message.id);
  }
  return data;
}
function smsButtons(){
  smsElement('sms-provider').disabled=smsRetired;
  smsElement('sms-country').disabled=smsRetired||!!smsPending||!smsCatalog.length;
  smsElement('sms-number').disabled=smsRetired||!!smsPending||!smsNumbers.length;
  smsElement('sms-copy').disabled=smsRetired||!!smsPending||!smsCurrent;
  smsElement('sms-refresh').disabled=!smsApiReady||!smsSource(smsProvider)||smsRetired||!!smsPending||performance.now()<smsRefreshAt;
}
function smsCooldown(milliseconds){
  clearTimeout(smsCooldownTimer);smsRefreshAt=performance.now()+milliseconds;
  smsCooldownTimer=setTimeout(()=>{smsCooldownTimer=null;smsButtons();},milliseconds);
}
function smsClearView(){
  smsCurrent=null;smsNumbers=[];
  smsElement('sms-address').value='No number selected';
  smsElement('sms-number').replaceChildren();
  smsElement('sms-number').value='';
  smsElement('sms-messages').replaceChildren();
  smsElement('sms-empty').hidden=false;
  smsElement('sms-empty').textContent='Choose a listed number to read its public messages.';
  smsElement('sms-updated').textContent='No source check completed.';
  smsElement('sms-restrictions').textContent='';
  smsElement('sms-coverage').textContent='';
  smsElement('sms-inventory').textContent='No number list loaded.';
}
function smsClearCatalog(){smsCatalog=[];smsScope={};smsElement('sms-country').replaceChildren();smsElement('sms-country').value='';smsClearView();}
function smsOption(value,label){const option=document.createElement('option');option.value=value;option.textContent=label;return option;}
function smsRender(data,provider){
  smsCatalog=data.countries;smsNumbers=data.numbers;
  smsScope=data.country?{country:data.country,...(data.number?{number:data.number}:{})}:{};
  smsElement('sms-country').replaceChildren(...data.countries.map(country=>smsOption(country.code,country.name)));
  smsElement('sms-country').value=data.country||'';
  smsElement('sms-number').replaceChildren(...data.numbers.map(number=>smsOption(number.national,number.e164+(number.lastActivity?' · '+number.lastActivity:''))));
  smsElement('sms-number').value=data.number||'';
  smsCurrent=data.numbers.find(number=>number.national===data.number)||null;
  smsElement('sms-address').value=smsCurrent?smsCurrent.e164:'No number selected';
  smsElement('sms-restrictions').textContent=data.restrictions||'See the provider’s terms for current restrictions.';
  const ukListed=data.countries.some(country=>country.code===(provider==='onlinesim'?'44':'gb'));
  smsElement('sms-coverage').textContent=data.countries.length+' countries listed in this free feed. United Kingdom (+44): '+(ukListed?'listed.':'not currently listed.');
  const selectedCountry=data.countries.find(country=>country.code===data.country);
  smsElement('sms-inventory').textContent=selectedCountry?data.numbers.length+' public number'+(data.numbers.length===1?'':'s')+' listed for '+selectedCountry.name+'.'+(data.numbers.length===smsSource(provider).maxNumbers?' The feed display limit has been reached.':''):'No number list loaded.';
  smsElement('sms-updated').textContent='Source checked: '+new Date(data.checkedAt).toISOString().replace('T',' ').replace('.000Z',' UTC').replace('Z',' UTC');
  smsElement('sms-empty').hidden=data.messages.length>0;
  smsElement('sms-empty').textContent=smsCurrent?'No messages are displayed for this public number.':'No public numbers are currently listed for this country.';
  const cards=data.messages.map(message=>{
    const card=document.createElement('article');card.className='sms-message';
    const sender=document.createElement('h3');sender.textContent=message.sender||'Sender not provided';
    const time=document.createElement('p');time.className='fine';time.textContent=message.receivedAt?'Provider time: '+message.receivedAt:'Provider time not provided';
    const body=document.createElement('pre');body.className='sms-body';body.textContent=message.text;
    card.append(sender,time,body);return card;
  });
  smsElement('sms-messages').replaceChildren(...cards);
  const omitted=data.omittedMessages?' '+data.omittedMessages+' unsupported message(s) were omitted.':'';
  smsSay(!data.countries.length?'No public numbers are listed right now. Refresh later.':!smsCurrent?'No public number is listed for this country. Choose another country.':'Public inbox loaded. Everyone can read these messages. Refresh manually to check again.'+omitted);
}
async function smsReadResponse(response,signal){
  const length=response.headers.get('content-length');
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||
      length!==null&&(!/^\d{1,7}$/.test(length)||Number(length)>smsResponseLimit)||!response.body){
    try{response.body?.cancel().catch(()=>{});}catch{}
    throw Error('invalid_data');
  }
  const reader=response.body.getReader(),chunks=[];let size=0,count=0,complete=false;
  const cancel=()=>{try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}};
  signal.addEventListener('abort',cancel,{once:true});
  try{
    for(;;){
      const item=await reader.read();if(signal.aborted)throw Error('timeout');if(item.done)break;
      if(!(item.value instanceof Uint8Array)||++count>4096||(size+=item.value.byteLength)>smsResponseLimit)throw Error('invalid_data');
      chunks.push(item.value.slice());
    }
    complete=true;const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{
    signal.removeEventListener('abort',cancel);if(!complete)cancel();try{reader.releaseLock();}catch{}
  }
}
async function smsLoad(wanted={}){
  if(smsRetired)return;
  if(!smsApiReady){smsSay('The public SMS feed is not configured.');smsButtons();return;}
  const provider=smsProvider,source=smsSource(provider);
  if(!source){smsClearCatalog();smsSay('Choose a listed number source.');smsButtons();return;}
  const revision=++smsGeneration;smsPending?.abort();const controller=new AbortController();smsPending=controller;
  smsScope={...wanted};smsClearView();smsButtons();smsSay('Loading the public SMS feed…');
  const query=new URLSearchParams();if(wanted.country)query.set('country',wanted.country);if(wanted.number)query.set('number',wanted.number);
  const serialized=query.toString(),endpoint=source.endpoint+(serialized?'?'+serialized:'');
  let timer,retryMilliseconds=smsRefreshDelay;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('timeout'));},10000);});
  const work=async()=>{
    const response=await fetch(endpoint,{method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});
    if(response.status!==200){
      try{response.body?.cancel().catch(()=>{});}catch{}
      if(response.status===429){const retry=response.headers.get('retry-after');const seconds=retry&&/^\d{1,4}$/.test(retry)?Number(retry):30;retryMilliseconds=Math.max(30,Math.min(3600,seconds))*1000;throw Error('limited');}
      if(response.status===400||response.status===404)throw Error('unavailable_scope');
      throw Error('unavailable');
    }
    return smsValidate(await smsReadResponse(response,controller.signal),wanted,source);
  };
  try{
    const data=await Promise.race([work(),timeout]);
    if(revision===smsGeneration&&!smsRetired&&provider===smsProvider)smsRender(data,provider);
  }catch(error){
    if(revision!==smsGeneration||smsRetired)return;
    smsClearCatalog();
    if(error.message==='unavailable_scope'){smsScope={};smsSay('This public number or country is no longer listed. Wait 30 seconds, then Refresh for the current list.');}
    else if(error.message==='limited')smsSay('Public SMS requests are limited. Retry after '+Math.ceil(retryMilliseconds/1000)+' seconds.');
    else if(error.message==='timeout')smsSay('The public SMS request timed out. Wait 30 seconds, then select Refresh.');
    else if(error.message==='invalid_data'||error.message==='invalid_scope'||error instanceof SyntaxError||error instanceof TypeError)smsSay('The public SMS feed returned unsupported data. Wait 30 seconds, then select Refresh.');
    else smsSay('The public SMS feed is unavailable. Wait 30 seconds, then select Refresh.');
  }finally{
    clearTimeout(timer);controller.abort();
    if(smsPending===controller){smsPending=null;if(!smsRetired)smsCooldown(retryMilliseconds);smsButtons();}
  }
}
smsElement('sms-provider').addEventListener('change',()=>{
  if(smsRetired)return;
  smsGeneration++;smsPending?.abort();smsPending=null;smsProvider=smsElement('sms-provider').value;smsClearCatalog();smsLoad();
});
smsElement('sms-country').addEventListener('change',()=>{
  if(smsRetired)return;
  const country=smsElement('sms-country').value;
  if(!smsCatalog.some(item=>item.code===country)){smsSay('Choose a country from the available list.');return;}
  smsLoad({country});
});
smsElement('sms-number').addEventListener('change',()=>{
  if(smsRetired)return;
  const number=smsElement('sms-number').value,country=smsScope.country;
  if(!smsCatalog.some(item=>item.code===country)||!smsNumbers.some(item=>item.national===number)){smsSay('Choose a number from the available list.');return;}
  smsLoad({country,number});
});
smsElement('sms-refresh').addEventListener('click',()=>{if(!smsRetired&&!smsPending&&performance.now()>=smsRefreshAt)smsLoad({...smsScope});});
smsElement('sms-copy').addEventListener('click',async()=>{
  if(smsRetired||smsPending||!smsCurrent)return;
  const revision=smsGeneration,number=smsCurrent.e164;
  try{await navigator.clipboard.writeText(number);if(revision===smsGeneration&&!smsRetired&&smsCurrent?.e164===number)smsSay('Public number copied. Its inbox is visible to everyone.');}
  catch{if(revision===smsGeneration&&!smsRetired&&smsCurrent?.e164===number)smsSay('Copy is unavailable. Select the displayed public number and copy it manually.');}
});
window.addEventListener('pagehide',()=>{
  smsRetired=true;smsGeneration++;smsPending?.abort();smsPending=null;clearTimeout(smsCooldownTimer);smsCooldownTimer=null;smsClearCatalog();smsButtons();smsSay('Public inbox view closed. Messages remain public at the provider.');
});
window.addEventListener('pageshow',event=>{if(event.persisted){smsRetired=false;smsRefreshAt=0;smsProvider=smsElement('sms-provider').value;smsClearCatalog();smsLoad();}});
smsButtons();smsLoad();
