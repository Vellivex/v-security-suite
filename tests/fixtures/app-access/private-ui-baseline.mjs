import {privateChatSession,privateVoiceCall} from '../client-session.mjs';
import {readInvitation} from '../vkey/crypto.mjs';
const NO_DIRECT_ROUTE='This browser or network found no direct connection route, and relay support is not configured. Open this app in an up-to-date browser or try another network.';
const DIRECT_ROUTE_HELP='A direct connection could not be made. Try another network or an up-to-date browser.';
// End reasons can also contain native/network errors. Display only these fixed
// product messages, never an arbitrary error or a peer-controlled value.
const CHAT_END_REASONS=new Set([
  'Refresh both chat pages and create a fresh invitation.',
  'The direct connection did not complete, and relay support is not configured. Try another browser or network and create a fresh invitation.',
  'The connection did not complete. Relay support was configured, but this browser or network could not connect. Try another browser or network and create a fresh invitation.',
  'This invitation has expired. Create a fresh invitation to start a chat.',
  'This two-hour session has ended. Create a new invitation to keep talking.',
  'The other person ended the chat. The conversation has been cleared from this page.',
  'The other browser disconnected. This conversation has been cleared from this page.',
  'The other browser stopped responding. Messages without a receipt were not confirmed delivered.',
]);
function chatEndReason(message){
  if(message===NO_DIRECT_ROUTE)return DIRECT_ROUTE_HELP;
  if(message==='The conversation has been cleared from this page. There is no saved history to reopen.')return '';
  return CHAT_END_REASONS.has(message)?message:'The chat ended. Create a fresh invitation to reconnect.';
}
function connectionHelp(session){
  if(typeof session?.connectionDiagnostics!=='function')return 'Start or join a text invitation to check the connection.';
  const d=session.connectionDiagnostics();
  const state=(key,allowed)=>allowed.includes(d[key])?d[key]:'unavailable';
  const count=(side,type)=>Number.isSafeInteger(d[side]?.[type])&&d[side][type]>=0&&d[side][type]<=1000?d[side][type]:0;
  const routes=side=>['host','srflx','prflx','relay'].map(type=>type+' '+count(side,type)).join(', ');
  const codes=Array.isArray(d.iceErrorCodes)?d.iceErrorCodes.filter(code=>Number.isInteger(code)&&((code>=300&&code<=699)||code===701)).slice(0,8):[];
  return [
    'Network: '+state('iceConnectionState',['new','checking','connected','completed','disconnected','failed','closed']),
    'Connection: '+state('connectionState',['new','connecting','connected','disconnected','failed','closed']),
    'Encrypted transport: '+state('dtlsState',['new','connecting','connected','closed','failed']),
    'Data channel: '+state('channelState',['connecting','open','closing','closed']),
    'Local routes: '+routes('localCandidates'),
    'Peer routes: '+routes('remoteCandidates'),
    'Peer certificate checked: '+(d.transportChecked===true?'yes':'no'),
    'Peer handshake received: '+(d.peerHello===true?'yes':'no'),
    'Relay: '+(d.relayAvailable===true?'configured':'off'),
    'Network error codes: '+(codes.length?codes.join(', '):'none'),
  ].join('\n');
}
export function mountLiveUI(document,window,{chatFactory=privateChatSession,voiceFactory=privateVoiceCall}={}){
  const el=id=>document.getElementById(id);let session=null,kind='chat',busy=false,generation=0,ready=false,ending=null;
  const nodes=new Map();const status=text=>{el('status').textContent=text;};
  const refreshHelp=()=>{if(kind==='chat'&&session)el('connection-help').textContent=connectionHelp(session);};
  const confirmedHiddenChat=()=>document.hidden&&kind==='chat'&&session?.localVerified&&session?.peerVerified;
  const invite=link=>{const u=new URL(link,window.location.origin);u.pathname='/live';return u.href;};
  function render(){const active=!!session;el('mode').disabled=active||busy;el('start').disabled=active||busy||!el('consent').checked;el('join').disabled=active||busy||!el('consent').checked;el('send').disabled=busy||!ready||kind!=='chat';el('text-controls').hidden=kind!=='chat';el('voice-controls').hidden=kind!=='voice';}
  function chatEvent(event){
    // Match the existing VKey policy: permit invitation sharing before both
    // confirmations, but clear before any late verified event can render hidden.
    if(event.type!=='ended'&&confirmedHiddenChat()){void end();return;}
    if(event.type==='status')status(event.title);
    if(event.type==='invitation'){el('invitation').value=invite(event.link);status('Invitation ready. Share it privately to connect.');}
    if(event.type==='peer-request'){el('accept').hidden=false;if(event.awaitingApproval)status('Your guest is waiting. Accept when the person you invited is ready, then compare the full connection code before both of you confirm.');}
    if(event.type==='verification'){el('code').textContent=event.code.full;el('confirm').disabled=false;}
    if(event.type==='ready'){ready=event.ready;status(ready?'Both people confirmed. Live text is ready.':'Waiting for both connection-code confirmations.');}
    if(event.type==='interrupted'){ready=false;status('The connection was interrupted. Sending is paused while the other browser reconnects.');}
    if(event.type==='message'){const node=document.createElement('p');node.textContent=(event.mine?'You: ':'Peer: ')+event.text;nodes.set(event.origin+':'+event.id,node);el('messages').append(node);}
    if(event.type==='message-expired'){const key=event.origin+':'+event.id;nodes.get(key)?.remove();nodes.delete(key);}
    if(event.type==='ended'){void end(chatEndReason(event.message));return;}
    refreshHelp();render();
  }
  function voiceEvent(){const s=session?.status;if(!s)return;status(s.message);el('code').textContent=s.fingerprint??'';el('confirm').disabled=!s.connected;el('mic').disabled=!session.ready||s.microphoneActive;el('mute').disabled=!s.microphoneActive;el('sound').disabled=!session.ready||s.soundEnabled;render();}
  function end(reason=''){
    if(!session&&ending?.generation===generation)return ending.promise;
    const endedGeneration=++generation,s=session,endedKind=kind;
    const prefix=s&&endedKind==='chat'&&reason?reason+' ':'';
    if(s&&endedKind==='chat')el('connection-help').textContent=connectionHelp(s);
    session=null;ready=false;busy=false;el('message').value='';el('invitation').value='';el('code').textContent='';el('messages').replaceChildren();nodes.clear();el('confirm').disabled=true;el('accept').hidden=true;el('typing').checked=false;el('message').readOnly=true;el('headphones').checked=false;el('consent').checked=false;el('mic').disabled=el('mute').disabled=el('sound').disabled=true;
    status(prefix+(s&&endedKind==='chat'?'Session cleared on this device. Confirming server cleanup…':'Session cleared on this device.'));render();
    let cleanup;
    try{if(s){if(endedKind==='chat'){s.finish();cleanup=s.cleanup;}else cleanup=s.stop();}}catch{cleanup=Promise.resolve({acknowledged:false});}
    const promise=Promise.resolve(cleanup).catch(()=>({acknowledged:false})).then(result=>{
      if(generation!==endedGeneration)return;
      if(s&&endedKind==='chat'&&result?.required===false)status(prefix+'Session cleared on this device.');
      else if(s&&endedKind==='chat')status(prefix+(result?.acknowledged===true?'Session cleared on this device. Server cleanup confirmed for this session.':'Session cleared on this device. Server cleanup could not be confirmed.'));
      else status('Session cleared on this device.');
      render();
    }).finally(()=>{if(ending?.generation===endedGeneration)ending=null;});
    ending={generation:endedGeneration,promise};return promise;
  }
  async function run(action){
    if(busy)return;
    busy=true;render();let ownedGeneration=generation;
    try{const pending=action();ownedGeneration=generation;await pending;}
    catch(error){
      if(ownedGeneration!==generation)return;
      const noRoute=kind==='chat'&&error?.message===NO_DIRECT_ROUTE;
      const ending=end(noRoute?DIRECT_ROUTE_HELP:''),endedGeneration=generation;
      await ending;
      if(!noRoute&&generation===endedGeneration)status('That step could not finish. '+el('status').textContent);
    }finally{if(ownedGeneration===generation){busy=false;render();}}
  }
  async function begin(join){if(!el('consent').checked||session)return;kind=el('mode').value;const g=++generation,raw=el('invitation').value.trim();
    const startingKind=kind;
    const s=startingKind==='chat'?await chatFactory(event=>{if(g===generation)chatEvent(event);}):await voiceFactory({origin:window.location.origin});
    if(g!==generation||(document.hidden&&startingKind==='voice')){if(startingKind==='chat')s.finish();else await s.stop();return;}session=s;
    el('connection-help').textContent=startingKind==='chat'?connectionHelp(s):'Connection help is available for live text.';
    if(startingKind==='chat'){if(join){const u=new URL(raw,window.location.origin);u.pathname='/';await s.join('Peer',readInvitation(u.href,window.location.origin));}else await s.create('Host');}
    else{s.addEventListener('state',()=>{if(g===generation)voiceEvent();});if(join){const u=new URL(raw,window.location.origin);u.pathname='/call.html';await s.join(u.href);}else await s.create();if(g!==generation||session!==s)return;if(s.invitationLink)el('invitation').value=invite(s.invitationLink);voiceEvent();}
  }
  el('start').addEventListener('click',()=>run(()=>begin(false)));el('join').addEventListener('click',()=>run(()=>begin(true)));el('end').addEventListener('click',()=>void end());
  el('accept').addEventListener('click',()=>run(async()=>{await session?.accept();el('accept').hidden=true;}));
  el('confirm').addEventListener('click',()=>run(async()=>{if(kind==='chat')session?.confirmVerification();else await session?.verify(true);}));
  el('send').addEventListener('click',()=>run(()=>{
    const s=session,text=el('message').value;
    if(!text.trim()||text.length>4000||new TextEncoder().encode(text).length>16000){status('Write a message of 4,000 characters or fewer.');return;}
    if(!s||!ready)return;
    try{s.sendText(text);el('message').value='';}
    catch{if(session===s&&!s.closed)status('The message was not sent. Check the connection and try again.');}
  }));
  el('typing').addEventListener('change',()=>{el('message').readOnly=!el('typing').checked;});
  el('refresh-connection').addEventListener('click',refreshHelp);
  el('mic').addEventListener('click',()=>run(()=>session?.microphone('clean',el('headphones').checked)));el('mute').addEventListener('click',()=>run(()=>session?.muteMicrophone()));el('sound').addEventListener('click',()=>run(()=>session?.sound(el('headphones').checked)));
  el('mode').addEventListener('change',()=>{kind=el('mode').value;render();});el('consent').addEventListener('change',render);
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(kind==='voice'||confirmedHiddenChat()))void end();});window.addEventListener('pagehide',()=>void end());
  if(window.location.hash){const fragment=window.location.hash;window.history.replaceState(null,'',window.location.pathname);const p=new URLSearchParams(fragment.slice(1));el('mode').value=kind=p.get('v')==='2'?'voice':'chat';el('invitation').value=window.location.origin+'/live'+fragment;status('Invitation loaded. Review consent, then Join.');}
  render();return {end};
}
