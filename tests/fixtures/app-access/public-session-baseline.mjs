import {ChatSession} from './chat-core.mjs';
import {fingerprint,randomValue,deriveKeys,openSignal,sealSignal,verification} from './crypto.mjs';

export const PUBLIC_ICE_QUIET_MS=2000;
export const PUBLIC_ICE_GATHER_MAX_MS=8000;
export const PUBLIC_SETUP_REFRESH='Refresh both chat pages and create a fresh invitation.';
const setupVersion=value=>Object.prototype.hasOwnProperty.call(value??{},'setupVersion')?value.setupVersion:1;
function gatheredRoutes(sdp){
  const counts={host:0,srflx:0,prflx:0,relay:0};
  for(const line of typeof sdp==='string'?sdp.split(/\r?\n/):[]){
    if(!line.startsWith('a=candidate:'))continue;
    const fields=line.split(/\s+/,8),type=fields[6]==='typ'?fields[7]:null;
    if(Object.prototype.hasOwnProperty.call(counts,type))counts[type]++;
  }
  return {total:counts.host+counts.srflx+counts.prflx+counts.relay,useful:counts.srflx+counts.prflx>0};
}

async function json(response){
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??''))throw new Error('The connection service did not return a valid response.');
  const reader=response.body?.getReader();if(!reader)throw new Error('The connection service did not return a valid response.');
  let length=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>40000)throw new Error('The connection response was too large.');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  finally{void reader.cancel().catch(()=>{});}
}
async function release(fetcher,{room,token,role,alreadyCleared}){
  if(alreadyCleared)return {acknowledged:true};
  if(!room||!token||!['host','guest'].includes(role))return {acknowledged:false};
  const controller=new AbortController();let timer;
  try{return await Promise.race([(async()=>{const response=await fetcher('/api/rooms/'+room,{method:'DELETE',headers:{'X-Room-Token':token,'X-Room-Role':role,Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',keepalive:true,signal:controller.signal});const value=await json(response);return {acknowledged:!controller.signal.aborted&&response.status===200&&value?.ok===true&&Object.keys(value).length===1};})().catch(()=>({acknowledged:false})),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({acknowledged:false});},8000);})]);}
  finally{clearTimeout(timer);controller.abort();room=token=role=null;}
}
// Existing HKDF/AES-GCM encrypted signalling, certificate authentication,
// DTLS data channel, independent full-code confirmation and retention remain
// in the unchanged core. Public room capabilities never access account data.
export class PublicChatSession extends ChatSession{
  // Window.fetch requires the browser global receiver, including when this
  // transport is passed as a detached callback to authenticated cleanup.
  constructor(onEvent,{fetcher=globalThis.fetch.bind(globalThis),setupVersion=2,...options}={}){
    super(onEvent,options);if(![1,2].includes(setupVersion))throw new Error(PUBLIC_SETUP_REFRESH);
    this.fetcher=fetcher;this.signallingCleared=false;this.requestedSetupVersion=setupVersion;this.roomSetupVersion=null;this.hostConsent=false;
    this.serverCleanupRequired=false;
  }
  async loadIceConfiguration(){this.guard();return {iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],relayAvailable:false};}
  validateSetupStatus(value){
    this.requireSetup();
    const expected=this.roomSetupVersion===2?'accepted,answer,claimed,expiresAt,setupVersion':'answer,claimed,expiresAt';
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==expected||setupVersion(value)!==this.roomSetupVersion||value.expiresAt!==this.expiresAt||typeof value.claimed!=='boolean'||this.roomSetupVersion===2&&(typeof value.accepted!=='boolean'||value.accepted&&!value.claimed||value.answer!==null&&!value.accepted))throw new Error(PUBLIC_SETUP_REFRESH);
    return value;
  }
  pauseSetup(ms){
    this.requireSetup();return new Promise((resolve,reject)=>{
      let timer;const clean=()=>{this.cancelTimer(timer);this.abort.signal.removeEventListener('abort',onAbort);};
      const onAbort=()=>{clean();reject(new Error(this.endReason||'This chat has ended.'));};
      this.abort.signal.addEventListener('abort',onAbort,{once:true});
      timer=this.timeout(()=>{clean();try{this.guard();resolve();}catch(error){reject(error);}},ms);
      if(this.abort.signal.aborted)onAbort();
    });
  }
  async waitForHostAcceptance(){
    this.emit('status',{state:'awaiting-approval',title:'Waiting for the host to accept your invitation…',peerName:this.peerName});
    for(;;){
      this.requireSetup();const value=this.validateSetupStatus(await this.api('/'+this.room));this.guard();
      if(!value.claimed)throw new Error(PUBLIC_SETUP_REFRESH);
      if(value.accepted===true)return;
      await this.pauseSetup(1800);
    }
  }
  async join(name,invitation){
    this.guard();this.role='guest';this.name=name||'Guest';this.room=invitation.room;this.token=randomValue();
    this.emit('status',{state:'joining',title:'Opening your invitation…'});
    const keys=await deriveKeys(invitation.secret,this.room);this.guard();this.keys=keys;
    const setup=await this.api('/'+this.room+'/join',{method:'POST',token:invitation.inviteToken,body:{claimToken:this.token}});this.guard();
    const version=setupVersion(setup),expected=version===2?'accepted,expiresAt,offer,setupVersion':'expiresAt,offer';
    if(!setup||![1,2].includes(version)||Object.keys(setup).sort().join(',')!==expected||version===2&&(this.requestedSetupVersion!==2||typeof setup.accepted!=='boolean'))throw new Error(PUBLIC_SETUP_REFRESH);
    const offer=await openSignal(this.keys,this.room,'host',setup.offer,this.now());this.guard();
    if(offer.expiresAt!==setup.expiresAt)throw new Error('The invitation expiry could not be authenticated.');
    this.roomSetupVersion=version;this.setSetupDeadline(offer.expiresAt);this.peerName=offer.name;this.offer=offer.sdp;this.watchExpiry();
    // No guest peer, local candidates or native ICE checks exist while the host
    // is deciding. The original authenticated invitation deadline keeps running.
    if(version===2&&!setup.accepted)await this.waitForHostAcceptance();this.guard();
    await this.makePeer();this.guard();
    await this.setupStep(()=>this.pc.setRemoteDescription({type:'offer',sdp:this.offer}),'This browser took too long to apply the invitation connection details. Try another browser or network.');this.guard();
    const description=await this.setupStep(()=>this.pc.createAnswer(),'This browser took too long to prepare a connection answer. Try again.');this.guard();
    const answerSdp=await this.gather(description);this.guard();this.answer=answerSdp;
    const code=await verification(this.room,this.offer,this.answer);this.guard();this.code=code;
    const answer=await sealSignal(this.keys,this.room,'guest',{type:'answer',sdp:this.answer,name:this.name,expiresAt:this.expiresAt});this.guard();
    this.emit('status',{state:version===2?'connecting':'awaiting-host',title:version===2?'Connecting to '+this.peerName+'…':'Waiting for '+this.peerName+' to connect…',peerName:this.peerName});this.watchExpiry();
    try{await this.api('/'+this.room+'/answer',{method:'PUT',body:{answer}});}catch(error){if(!this.transportChecked)throw error;}
    this.guard();this.keys=null;
  }
  async applyAcceptedAnswer(){
    this.requireSetup();if(this.hostConsent&&this.answer&&!this.accepted)await super.accept();
  }
  async pollHost(){
    if(!this.lifetimeOkay()||this.answer)return;
    if(this.publicPoll)return this.publicPoll;
    this.cancelTimer(this.publicPollTimer);
    const pending=(async()=>{
      try{
        const consentAtRequest=this.hostConsent;
        const setup=this.validateSetupStatus(await this.api('/'+this.room));this.guard();
        if(this.roomSetupVersion===2){
          // An earlier GET may return its pre-accept snapshot after the PUT has
          // completed. Only a request begun after our consent can contradict it.
          if(consentAtRequest&&!setup.accepted)throw new Error(PUBLIC_SETUP_REFRESH);
          if(setup.claimed){this.guestClaimed=true;if(!this.hostConsent&&!this.claimPrompted){this.claimPrompted=true;this.emit('peer-request',{peerName:'Your guest',awaitingApproval:true});}}
        }
        if(setup.answer){
          const answer=await openSignal(this.keys,this.room,'guest',setup.answer,this.now());this.guard();
          if(answer.expiresAt!==this.expiresAt)throw new Error('The connection expiry could not be authenticated.');
          const code=await verification(this.room,this.offer,answer.sdp);this.guard();
          this.answer=answer.sdp;this.peerName=answer.name;this.code=code;this.keys=null;this.invitation=null;
          if(this.roomSetupVersion===2)await this.applyAcceptedAnswer();
          else this.emit('peer-request',{peerName:this.peerName});
          return;
        }
        if(setup.claimed&&this.roomSetupVersion===1)this.emit('claimed');
        this.publicPollTimer=this.timeout(()=>this.pollHost(),1800);
      }catch(error){if(!this.closed)this.finish(error.message);}
    })();
    this.publicPoll=pending;
    try{await pending;}finally{if(this.publicPoll===pending)this.publicPoll=null;}
  }
  async accept(){
    this.requireSetup();if(this.roomSetupVersion===1)return super.accept();
    if(this.role!=='host'||!this.guestClaimed||this.hostConsent||this.accepting)return;
    this.accepting=true;
    try{
      const value=await this.api('/'+this.room+'/accept',{method:'PUT',body:{setupVersion:2,accepted:true}});this.guard();
      if(!value||Object.keys(value).sort().join(',')!=='accepted,expiresAt,ok,setupVersion'||value.ok!==true||value.setupVersion!==2||value.accepted!==true||value.expiresAt!==this.expiresAt)throw new Error(PUBLIC_SETUP_REFRESH);
      this.hostConsent=true;this.emit('status',{state:'awaiting-peer',title:'Accepted. Waiting for your guest to prepare the encrypted connection…',peerName:'Your guest'});
      await this.applyAcceptedAnswer();this.guard();if(!this.answer)void this.pollHost();
    }finally{this.accepting=false;}
  }
  async gather(description){
    this.guard();const pc=this.pc;
    await this.setupStep(()=>pc.setLocalDescription(description),'This browser took too long to apply local connection details. Try another browser or network.');this.guard();
    // An unreachable STUN path can keep gathering open while answer-side ICE
    // checks already run. Publish an authenticated, immutable snapshot once
    // useful candidates settle instead of withholding the answer for a minute.
    // Late candidates may be omitted; no end-of-candidates or restart is forged.
    const sdp=await new Promise((resolve,reject)=>{
      const started={wall:this.now(),monotonic:this.monotonicNow()};
      let lastCandidate=started,count=-1,quietTimer,deadlineTimer,settled=false;
      const clean=()=>{clearTimeout(quietTimer);clearTimeout(deadlineTimer);pc.removeEventListener('icecandidate',check);pc.removeEventListener('icegatheringstatechange',check);this.abort.signal.removeEventListener('abort',onAbort);};
      const finish=(error,value)=>{if(settled)return;settled=true;clean();error?reject(error):resolve(value);};
      const elapsed=since=>Math.max(this.now()-since.wall,this.monotonicNow()-since.monotonic);
      const onAbort=()=>finish(new Error(this.endReason||'This chat has ended.'));
      const check=(atDeadline=false)=>{
        if(settled)return;
        try{
          this.guard();if(this.pc!==pc)throw new Error('This chat has ended.');
          const current=pc.localDescription?.sdp,routes=gatheredRoutes(current);
          if(routes.total!==count){count=routes.total;lastCandidate={wall:this.now(),monotonic:this.monotonicNow()};}
          if(pc.iceGatheringState==='complete'||atDeadline===true||elapsed(started)>=PUBLIC_ICE_GATHER_MAX_MS||routes.useful&&elapsed(lastCandidate)>=PUBLIC_ICE_QUIET_MS){finish(null,current);return;}
          clearTimeout(quietTimer);
          if(routes.useful)quietTimer=setTimeout(check,Math.max(1,PUBLIC_ICE_QUIET_MS-elapsed(lastCandidate)));
        }catch(error){finish(error);}
      };
      pc.addEventListener('icecandidate',check);pc.addEventListener('icegatheringstatechange',check);this.abort.signal.addEventListener('abort',onAbort,{once:true});
      deadlineTimer=setTimeout(()=>check(true),PUBLIC_ICE_GATHER_MAX_MS);check();
    });
    this.guard();if(this.pc!==pc)throw new Error('This chat has ended.');fingerprint(sdp);
    if(gatheredRoutes(sdp).total===0)throw new Error('This browser or network found no direct connection route, and relay support is not configured. Open this app in an up-to-date browser or try another network.');
    return sdp;
  }
  async api(path,{method='GET',body,token=this.token,role=this.role,keepalive=false}={}){
    if(method==='POST'&&path===''){
      this.roomSetupVersion=this.requestedSetupVersion;
      if(this.roomSetupVersion===2)body={...body,setupVersion:2};
    }else if(method==='POST'&&path.endsWith('/join')&&this.requestedSetupVersion===2)body={...body,setupVersion:2};
    else if(method==='PUT'&&path.endsWith('/answer')&&this.roomSetupVersion===2)body={...body,setupVersion:2};
    this.guard();const controller=new AbortController(),abort=()=>controller.abort();this.abort.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,12000);
    try{
      const headers={Accept:'application/json','X-Room-Token':token,'X-Room-Role':role};if(body)headers['Content-Type']='application/json';
      // A write may reach the server even if the browser never receives the response.
      if(method==='POST'&&(path===''||path.endsWith('/join')))this.serverCleanupRequired=true;
      const response=await this.fetcher('/api/rooms'+path,{method,headers,body:body?JSON.stringify(body):undefined,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,keepalive});
      const value=await json(response);this.guard();
      if(!response.ok)throw new Error(response.status===429?'Connection setup is busy. Wait a minute, then create a fresh invitation.':value?.code==='setup_version'||method==='POST'&&path===''&&this.roomSetupVersion===2&&response.status===400?PUBLIC_SETUP_REFRESH:'This invitation is unavailable or has expired. Create a fresh invitation.');
      if(method==='POST'&&path===''&&(value?.ok!==true||setupVersion(value)!==this.roomSetupVersion))throw new Error(PUBLIC_SETUP_REFRESH);
      if(method==='DELETE')this.signallingCleared=value?.ok===true&&Object.keys(value).length===1;
      return value;
    }finally{clearTimeout(timer);this.abort.signal.removeEventListener('abort',abort);}
  }
  finish(message){
    if(this.closed)return;
    const cleanup={room:this.room,token:this.token,role:this.role,alreadyCleared:this.signallingCleared};
    // Expose cleanup before the synchronous ended callback, then clear local
    // secrets and transport before issuing the bounded, authenticated DELETE.
    this.cleanup=this.serverCleanupRequired
      ?Promise.resolve().then(()=>release(this.fetcher,cleanup))
      :Promise.resolve({acknowledged:false,required:false});
    this.roomDeleted=true;super.finish(message);
  }
}
