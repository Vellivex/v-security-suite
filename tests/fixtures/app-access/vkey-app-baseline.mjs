import {readInvitation} from './crypto.mjs?v=20261010-7';
import {ChatSession} from './session.mjs?v=20261010-7';
import {ScreenKeyboard} from './keyboard.mjs?v=20261010-7';
import {bindHoldToKeep} from './hold-to-keep.mjs?v=20261010-7';
const $=id=>document.getElementById(id);
let session=null;let inviteTimer=null;let messageClock=null;let linkVisible=false;const messageNodes=new Map();let activeInvite=null;let pendingSetupFailure=null;let lastConnectionDiagnostics=null;
const keyboard=new ScreenKeyboard({field:$('message-input'),keys:$('keyboard-keys'),toggle:$('keyboard-toggle'),shuffle:$('keyboard-shuffle'),symbols:$('keyboard-symbols'),shift:$('keyboard-shift'),space:$('keyboard-space'),backspace:$('keyboard-backspace'),newline:$('keyboard-newline'),note:$('keyboard-note')});

// Consume the fragment before any connection request. Never log it or persist it.
if(location.hash){
  const original=location.href;history.replaceState(null,'',location.pathname);
  try{activeInvite=readInvitation(original,location.origin);$('join-details').open=true;$('invite-input').value=original;notice('You have an invitation. Enter a nickname, then choose Join this conversation.');}
  catch(error){notice(error.message);}
}
function showSection(id){for(const key of ['welcome','waiting','chat','ended'])$(key).hidden=key!==id;}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function badge(label,connected=false){$('badge-label').textContent=label;$('connection-badge').classList.toggle('connected',connected);$('connection-badge').querySelector('.mini-dot').classList.toggle('muted',!connected);}
function status(text){$('session-status').textContent=text;}
function enableComposer(enabled){$('message-input').disabled=!enabled;$('send-btn').disabled=!enabled;keyboard.setAvailable(enabled);$('message-input').placeholder=enabled?'Say what’s on your mind…':'Verify the connection to start chatting…';}
function clearInvite(){activeInvite=null;$('invite-input').value='';$('share-link').value='';$('share-link').type='password';$('invite-box').hidden=true;clearInterval(inviteTimer);inviteTimer=null;}
function peer(name,state){if(name)$('peer-name').textContent=name;$('peer-status').textContent=state;}
function refreshAwayPolicy(){
  $('away-policy').textContent=$('clear-away').checked?'After both people confirm, leaving this tab ends and clears the chat.':'Background clearing is off. Message timers and the session limit still apply.';
}
function clearHiddenChat(){
  const current=session;
  if(document.visibilityState==='visible'||!$('clear-away').checked||!current||current.closed||!current.localVerified||!current.peerVerified)return false;
  current.finish('You switched apps or tabs, so this chat was ended and cleared, including kept messages. Start a new invitation to reconnect.');
  return true;
}
const messageKey=(origin,id)=>origin+':'+id;
function announce(message){$('message-announcements').textContent=message;}
function updateMessageClock(){
  session?.sweepMessages();
  const now=Date.now();
  for(const item of messageNodes.values()){
    if(!item.keepers.length)item.timer.textContent=Math.max(0,Math.ceil((item.expiresAt-now)/1000))+'s';
  }
}
function renderMessage(item){
  item.meta.textContent=item.time+(item.mine?' · '+item.receipt:'');
  item.row.classList.toggle('kept',item.keepers.length>0);
  item.timer.hidden=item.keepers.length>0;
  const keptHere=item.keepers.includes(session?.role);
  item.keepButton.hidden=item.keepers.length>0;
  item.keepButton.disabled=item.pending;
  item.keepButton.textContent=item.pending?'Waiting for notice receipt…':'Hold to keep';
  if(item.pending){item.label.textContent=item.keepers.length?'Kept for this chat · your notice is awaiting a receipt':'Keep requested — timer still running';}
  else if(item.keepers.length){
    const who=item.keepers.length===2?'both of you':keptHere?'you':session?.peerName||'the other person';
    item.label.textContent='Kept by '+who+' · this chat only'+(keptHere&&item.peerAcknowledged?' · other browser notified':'');
  }else if(item.failed){item.label.textContent=item.failed;}
  else item.label.textContent='Deletes automatically';
}
function keepMessage(origin,id){
  const current=session;if(!current)return;
  try{current.requestKeep(origin,id);}
  catch(error){notice(error.message||'This message could not be kept.');}
}
function addMessage(event){
  $('chat-empty')?.remove();
  const {id,origin,mine,expiresAt}=event;
  const row=document.createElement('div');row.className='message-row'+(mine?' mine':'');
  const name=document.createElement('div');name.className='message-name';name.textContent=mine?'You':event.name;
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=event.text;
  const meta=document.createElement('div');meta.className='message-meta';
  const actions=document.createElement('div');actions.className='message-actions';
  const timer=document.createElement('span');timer.className='message-timer';timer.setAttribute('aria-hidden','true');timer.textContent='10s';
  const keepButton=document.createElement('button');keepButton.type='button';keepButton.className='message-keep-button';keepButton.textContent='Hold to keep';
  keepButton.setAttribute('aria-label','Press and hold for one second to keep this message. The other browser will be notified.');
  keepButton.title='Hold for 1 second, or hold Enter or Space. Kept only for this chat.';
  const label=document.createElement('span');label.className='message-kept-label';
  actions.append(timer,keepButton,label);row.append(name,bubble,meta,actions);$('messages').append(row);
  const item={id,origin,mine,expiresAt,row,meta,timer,keepButton,label,keepers:[],pending:false,peerAcknowledged:false,receipt:'Awaiting receipt',time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};
  item.hold=bindHoldToKeep(keepButton,()=>keepMessage(origin,id));
  messageNodes.set(messageKey(origin,id),item);renderMessage(item);
  if(!messageClock)messageClock=setInterval(updateMessageClock,500);
  $('messages').scrollTop=$('messages').scrollHeight;
}
function expireMessage(event){
  const key=messageKey(event.origin,event.id);const item=messageNodes.get(key);if(!item)return;
  item.hold.destroy();item.row.replaceChildren();item.row.remove();messageNodes.delete(key);
  if(event.reason==='capacity')announce('The oldest unkept message was cleared to make room.');
  if(!messageNodes.size){
    clearInterval(messageClock);messageClock=null;
    const empty=document.createElement('div');empty.className='chat-empty';empty.id='chat-empty';
    const title=document.createElement('p');title.textContent='No messages retained.';
    const detail=document.createElement('small');detail.textContent='Messages disappear after 10 seconds unless kept.';
    empty.append(title,detail);$('messages').append(empty);
  }
}
function updateRetention(event){
  const item=messageNodes.get(messageKey(event.origin,event.id));if(!item)return;
  const previous=item.keepers.join(',');const wasPending=item.pending;
  item.expiresAt=event.expiresAt;item.keepers=event.keepers;item.pending=event.pending;item.peerAcknowledged=event.peerAcknowledged;
  if(event.pending)item.failed='';
  else if(wasPending&&!event.keepers.includes(session?.role)){
    item.failed=event.reason==='keep-limit'?'Keep limit reached (200 messages)':'Keep not confirmed — still expires';
    announce(item.failed);
  }
  if(previous!==item.keepers.join(',')){
    if(item.keepers.length){
      const who=item.keepers.length===2?'Both of you':item.keepers.includes(session?.role)?'You':session?.peerName||'The other person';
      announce(who+' kept a message for this chat.');
    }else announce('The keep request was cancelled. The message will expire.');
  }
  if(item.pending||item.keepers.length)item.hold.cancel();
  renderMessage(item);
}
function clearMessages(){
  clearInterval(messageClock);messageClock=null;
  for(const item of messageNodes.values()){item.hold.destroy();item.row.replaceChildren();}
  messageNodes.clear();$('messages').replaceChildren();announce('');
}
function eventHandler(event){
  if(!session)return;
  // A peer can finish verification or send data while this tab is hidden.
  // Check before rendering, even if a visibility event has not run yet.
  if(event.type!=='ended'&&clearHiddenChat())return;
  if(event.type==='status'){
    showSection('waiting');$('end-btn').disabled=false;$('waiting-title').textContent=event.title;$('invite-box').hidden=true;$('accept-btn').hidden=true;
    $('waiting-description').textContent=event.state==='awaiting-approval'?'Your host must accept before the connection starts. Keep this tab open.':event.state==='awaiting-host'?'The other person will accept your connection. Keep this tab open.':event.state==='awaiting-peer'?'Your guest is preparing the connection. It will continue automatically. Keep this tab open.':'Setting up an encrypted connection between your browsers.';
    $('panel-title').textContent=event.state==='awaiting-approval'?'Waiting for host approval':'Preparing your conversation';status(event.state==='awaiting-approval'?'Waiting for your host':event.state==='connecting'?'Connecting…':'Preparing connection…');badge(event.state==='awaiting-approval'?'Awaiting approval':'Connecting');if(event.peerName)peer(event.peerName,'Waiting to connect');
  }else if(event.type==='invitation'){
    showSection('waiting');$('waiting-title').textContent='Your private space is ready.';$('waiting-description').textContent='Send this invitation directly to one person. Keep this tab open while they join.';
    $('share-link').value=event.link;$('invite-box').hidden=false;$('copy-btn').disabled=false;$('show-link-btn').textContent='Show link';linkVisible=false;
    status('Waiting for your person');badge('Invitation ready');$('panel-title').textContent='Invite someone to your conversation';
    const tick=()=>{const left=Math.max(0,Math.ceil((event.expiresAt-Date.now())/1000));$('expiry').textContent='Expires in '+Math.floor(left/60)+':'+String(left%60).padStart(2,'0');};tick();inviteTimer=setInterval(tick,1000);
  }else if(event.type==='claimed'){
    $('copy-btn').disabled=true;$('waiting-description').textContent='Someone has claimed your invitation and is preparing their encrypted connection.';peer(null,'Preparing connection');
  }else if(event.type==='peer-request'){
    clearInvite();peer(event.peerName,'Waiting for you');$('waiting-title').textContent=event.awaitingApproval?'Your guest is waiting for you.':event.peerName+' is ready to connect.';
    $('waiting-description').textContent=event.awaitingApproval?'Connect when the person you invited is ready. Then compare every group of the connection code in person or through a separate trusted channel before you both confirm.':'Connect, then compare the connection code by a trusted call or in person. Their nickname alone does not prove their identity.';
    $('accept-btn').hidden=false;$('accept-btn').disabled=false;status(event.awaitingApproval?'Your guest is waiting for your approval':'Your invitation was accepted');badge('Ready to connect');
  }else if(event.type==='verification'){
    clearInvite();showSection('chat');notice('');$('panel-title').textContent='Conversation with '+event.peerName;peer(event.peerName,'Encrypted connection');$('peer-dot').classList.remove('muted');
    $('verify-code').textContent=event.code.full.match(/.{1,4}/g).join(' ');$('full-fingerprint').textContent=event.code.full;$('verify-panel').classList.remove('verified');$('verify-btn').disabled=false;
    $('verification-status').textContent='Not yet verified';badge('Encrypted',true);status('Compare your connection codes');enableComposer(false);
  }else if(event.type==='ready'){
    $('verify-btn').disabled=event.localVerified;$('verify-btn').textContent=event.localVerified?'Confirmed — waiting for the other person':'We compared — the codes match';
    if(event.ready){$('verify-panel').classList.add('verified');$('verify-heading').textContent='CONNECTION CODE CONFIRMED';$('verification-status').textContent='Both people confirmed';badge('Verified by both',true);status('Private chat connected');enableComposer(true);notice('');}
    else{enableComposer(false);if(event.localVerified)$('verification-status').textContent='Waiting for their confirmation';else if(event.peerVerified)$('verification-status').textContent='They confirmed — your turn';}
  }else if(event.type==='message')addMessage(event);
  else if(event.type==='message-expired')expireMessage(event);
  else if(event.type==='retention')updateRetention(event);
  else if(event.type==='delivered'||event.type==='unconfirmed'){
    const item=messageNodes.get(messageKey(event.origin||session?.role,event.id));if(item){item.receipt=event.type==='delivered'?'Delivered':'Delivery unconfirmed';renderMessage(item);}
  }else if(event.type==='interrupted'){
    enableComposer(false);badge('Interrupted');status('Connection interrupted');notice('The connection is interrupted. Keep both browsers open. Messages without a receipt are not confirmed delivered.');
  }else if(event.type==='notice')notice(event.message);
  else if(event.type==='ended'){
    const failure=pendingSetupFailure;pendingSetupFailure=null;
    lastConnectionDiagnostics=session.connectionDiagnostics?.()??null;
    clearInvite();clearMessages();$('message-input').value='';$('verify-code').textContent='';$('full-fingerprint').textContent='';
    $('display-name').value='';$('self-name').textContent='You';
    const heading=failure?(failure.kind==='join'?"Couldn't join the chat":"Couldn't create the invitation"):'A fresh start, whenever you need it.';
    $('ended').classList.toggle('setup-failed',!!failure);$('ended-marker').textContent=failure?'!':'✓';
    $('ended-eyebrow').textContent=failure?'SETUP FAILED':'THIS CONVERSATION HAS ENDED';$('ended-heading').textContent=heading;
    $('restart-label').textContent=failure?'Try again':'Start a new conversation';
    showSection('ended');$('ended-message').textContent=event.message;$('end-btn').disabled=true;$('panel-title').textContent=failure?heading:'This conversation has ended';badge(failure?'Setup failed':'Disconnected');status(failure?'Setup failed':'Conversation ended');peer('Invited person','Disconnected');$('peer-dot').classList.add('muted');enableComposer(false);notice('');session=null;
    if(failure)$('ended-heading').focus({preventScroll:true});
  }
}
async function runStart(kind){
  if(session)return;pendingSetupFailure=null;lastConnectionDiagnostics=null;let invitation;
  try{if(kind==='join')invitation=readInvitation($('invite-input').value.trim(),location.origin);}
  catch(error){notice(error.message);return;}
  const name=$('display-name').value.trim().slice(0,32);$('self-name').textContent=name||'You';notice('');
  const next=new ChatSession(eventHandler);session=next;
  try{if(kind==='join'){activeInvite=null;$('invite-input').value='';await next.join(name,invitation);invitation=null;}else await next.create(name);}
  catch(error){if(!next.closed){pendingSetupFailure={kind};next.finish(error?.message||'The connection could not be prepared. Please try again.');}}
}
$('create-btn').addEventListener('click',()=>runStart('create'));
$('join-btn').addEventListener('click',()=>runStart('join'));
$('accept-btn').addEventListener('click',async()=>{const current=session;if(!current)return;$('accept-btn').disabled=true;try{await current.accept();}catch(error){if(!current.closed)current.finish(error.message);}});
$('verify-btn').addEventListener('click',()=>{try{session?.confirmVerification();}catch(error){notice(error.message);}});
$('copy-btn').addEventListener('click',async()=>{const value=$('share-link').value;if(!value)return;try{await navigator.clipboard.writeText(value);$('copy-btn').textContent='Copied';setTimeout(()=>{$('copy-btn').textContent='Copy link';},1800);}catch{linkVisible=true;$('share-link').type='text';$('share-link').focus();$('share-link').select();$('show-link-btn').textContent='Hide link';notice('Clipboard access was blocked. Select the link above and copy it manually.');}});
$('show-link-btn').addEventListener('click',()=>{linkVisible=!linkVisible;$('share-link').type=linkVisible?'text':'password';$('show-link-btn').textContent=linkVisible?'Hide link':'Show link';});
$('end-btn').addEventListener('click',()=>session?.finish());
$('restart-btn').addEventListener('click',()=>{location.replace(location.origin+'/');});
$('composer').addEventListener('submit',event=>{event.preventDefault();if(!session)return;try{session.sendText($('message-input').value);$('message-input').value='';$('message-input').focus();notice('');}catch(error){notice(error.message);}});
$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('composer').requestSubmit();}});
function refreshChecks(){
  $('check-https').textContent=location.protocol==='https:'&&globalThis.isSecureContext?'HTTPS in use':'Secure page required';
  $('check-crypto').textContent=!!crypto.subtle&&!!globalThis.RTCPeerConnection?'Browser APIs available':'Required API unavailable';
  $('check-certificate').textContent=session?.transportChecked&&!session.closed?'Matched to invitation':'No verified active transport';
  $('check-comparison').textContent=session?.localVerified&&session?.peerVerified&&!session.closed?'Both people confirmed':'Both confirmations required';
  $('check-keyboard').textContent=keyboard.enabled?'In-app click/tap keys':'Physical typing enabled';
  const connection=session?.connectionDiagnostics?.()??lastConnectionDiagnostics;
  $('check-relay-fallback').textContent=connection?(connection.relayAvailable?'Configured for this attempt'+(connection.relayTransports?.length?' · '+connection.relayTransports.join(' / '):''):'Not available for this attempt'):'No connection yet';
  for(const [id,key] of [['check-signaling','signalingState'],['check-gathering','iceGatheringState'],['check-network','iceConnectionState'],['check-connection','connectionState'],['check-encryption','dtlsState'],['check-data-channel','channelState']])$(id).textContent=connection?.[key]??'No connection yet';
  if(connection)$('check-gathering').textContent+=connection.iceErrorCodes?.length?' · ICE error codes: '+connection.iceErrorCodes.join(', '):' · No ICE error codes reported';
  const routes=counts=>counts?'Device '+counts.host+' · public '+counts.srflx+' · peer '+counts.prflx+' · relay '+counts.relay+' · other '+counts.other:'No connection yet';
  $('check-local-routes').textContent=routes(connection?.localCandidates);
  $('check-remote-routes').textContent=routes(connection?.remoteCandidates);
  $('check-peer-handshake').textContent=connection?(connection.peerHello?'Received':connection.transportChecked?'Waiting for peer':'Transport not verified'):'No connection yet';
}
for(const id of ['about-btn','details-btn'])$(id).addEventListener('click',()=>{refreshChecks();$('privacy-dialog').showModal();});
$('refresh-checks').addEventListener('click',refreshChecks);
$('clear-away').addEventListener('change',()=>{refreshAwayPolicy();clearHiddenChat();});
refreshAwayPolicy();
$('close-about-btn').addEventListener('click',()=>$('privacy-dialog').close());
$('privacy-dialog').addEventListener('click',event=>{if(event.target===$('privacy-dialog')){const r=$('privacy-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('privacy-dialog').close();}});
addEventListener('pagehide',()=>{session?.finish();clearInvite();clearMessages();$('message-input').value='';});
document.addEventListener('visibilitychange',()=>{if(!clearHiddenChat())updateMessageClock();});
addEventListener('focus',()=>{updateMessageClock();});
addEventListener('pageshow',event=>{if(event.persisted)location.replace(location.origin+'/');});
addEventListener('offline',()=>{if(session)eventHandler({type:'interrupted'});});
if(!globalThis.isSecureContext||!globalThis.RTCPeerConnection||!crypto.subtle){$('create-btn').disabled=true;$('join-btn').disabled=true;notice('This app needs HTTPS, Web Crypto, and WebRTC. Open it in an up-to-date browser.');}
