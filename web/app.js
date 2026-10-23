// SPDX-License-Identifier: GPL-3.0-or-later
import '/site.js';
import {encryptMessage,decryptMessage,inspectEnvelope} from '/apps/crypto.js';
import {SessionScope} from '/session.js';
const $=id=>document.getElementById(id);
const say=(message,error=false)=>{const el=$('app-status');if(el){el.textContent=message;el.dataset.error=String(error);}};
const vault=$('vault-form'),relay=$('relay-form');
function resetTransfer(){if(relay){$('result').value='';$('share-package').disabled=true;$('download-package').disabled=true;}}
const session=new SessionScope(reason=>{
  document.querySelectorAll('[data-sensitive]').forEach(el=>{el.value='';});
  if(vault){$('vault-submit').disabled=false;$('download-result').hidden=true;}
  if(relay){$('relay-file').value='';resetTransfer();}
  say(reason+' Browser memory and clipboard contents cannot be guaranteed to be securely erased.');
});
function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('clear-session')?.addEventListener('click',()=>session.lock());
for(const event of ['input','keydown','pointerdown'])document.addEventListener(event,()=>session.touch(),{capture:true,passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)session.lock('Session locked because this tab was hidden.');});
window.addEventListener('pagehide',()=>session.lock('Session closed.'));
window.addEventListener('pageshow',event=>{if(event.persisted)session.lock('Restored page locked.');});
if(!crypto?.subtle||!crypto?.getRandomValues){document.querySelectorAll('form button').forEach(el=>{el.disabled=true;});say('This browser does not provide the required secure Web Crypto API. The tool is disabled.',true);}
if(vault){
  for(const id of ['message','passphrase','passphrase-confirm'])$(id).addEventListener('input',()=>{
    session.invalidate();$('vault-submit').disabled=false;$('result').value='';$('download-result').hidden=true;
  });
  vault.addEventListener('submit',async event=>{
    event.preventDefault();const action=$('vault-mode').value;
    if(action==='encrypt'&&$('passphrase').value!==$('passphrase-confirm').value){say('Your passphrases do not match.',true);return;}
    const token=session.invalidate(),button=$('vault-submit');session.touch();
    button.disabled=true;$('result').value='';$('download-result').hidden=true;
    say(action==='encrypt'?'Encrypting on this device…':'Unlocking on this device…');
    try{
      const result=action==='encrypt'?await encryptMessage($('message').value,$('passphrase').value):await decryptMessage($('message').value,$('passphrase').value);
      if(!session.current(token))return;
      $('result').value=result;$('result-label').textContent=action==='encrypt'?'Encrypted package':'Unlocked message';$('download-result').hidden=action!=='encrypt';
      if(action==='encrypt')$('message').value='';
      say(action==='encrypt'?'Encrypted locally. Save the package and keep its passphrase separately.':'Unlocked locally. Leaving this tab will clear the session.');
    }catch(error){if(session.current(token))say(error.message,true);}
    finally{if(session.current(token)){button.disabled=false;$('passphrase').value='';$('passphrase-confirm').value='';}}
  });
  $('vault-mode').addEventListener('change',()=>{
    session.lock('Mode changed.');const encrypt=$('vault-mode').value==='encrypt';
    $('confirm-wrap').hidden=!encrypt;$('passphrase-confirm').required=encrypt;
    $('message-label').textContent=encrypt?'Your message':'Encrypted VVault package';
    $('result-label').textContent='Result';$('vault-submit').textContent=encrypt?'Encrypt on this device':'Unlock on this device';
  });
  $('download-result').addEventListener('click',()=>{try{inspectEnvelope($('result').value);download($('result').value,'v-vault-message.vvault');}catch(error){say(error.message,true);}});
}
$('copy-result')?.addEventListener('click',async()=>{const token=session.generation;try{if(!$('result').value)throw new Error('There is no result to copy.');await navigator.clipboard.writeText($('result').value);if(session.current(token))say('Copied. Other apps may read your clipboard. Clear the clipboard after use; clearing this page does not clear it.');}catch(error){if(session.current(token))say(error.message||'Copy unavailable. Select the result manually.',true);}});
if(relay){
  relay.addEventListener('submit',event=>{event.preventDefault();session.invalidate();try{inspectEnvelope($('relay-package').value);$('result').value=$('relay-package').value;$('share-package').disabled=false;$('download-package').disabled=false;say('Package format checked. This does not authenticate its sender or verify the encrypted contents.');}catch(error){resetTransfer();say(error.message,true);}});
  $('relay-package').addEventListener('input',()=>{session.invalidate();resetTransfer();});
  $('relay-file').addEventListener('change',async event=>{
    const token=session.invalidate(),file=event.target.files[0];resetTransfer();$('relay-package').value='';
    if(!file)return;if(file.size>200000){say('Package is too large. Previous transfer cleared.',true);return;}
    try{const text=await file.text();if(!session.current(token))return;inspectEnvelope(text);$('relay-package').value=text;say('Loaded locally. Check the package before sharing.');}
    catch(error){if(session.current(token))say(error.message||'Unable to read the selected file.',true);}
  });
  $('download-package').addEventListener('click',()=>{try{inspectEnvelope($('result').value);download($('result').value,'v-relay-message.vvault');}catch(error){say(error.message,true);}});
  $('share-package').addEventListener('click',async()=>{const token=session.generation;try{const text=$('result').value;inspectEnvelope(text);if(!navigator.share){say('Sharing is unavailable here. Copy or download the encrypted package instead.');return;}await navigator.share({title:'V encrypted package',text});if(session.current(token))say('Share completed. Share the passphrase separately.');}catch(error){if(session.current(token)&&error.name!=='AbortError')say('Sharing failed. Copy or download the package instead.',true);}});
}
$('offline-enable')?.addEventListener('click',async()=>{try{
  if(!('serviceWorker'in navigator))throw new Error('Offline installation is unavailable in this browser.');
  const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/apps/',updateViaCache:'none'});
  await registration.update();await navigator.serviceWorker.ready;
  $('offline-enable').textContent='Check offline files for updates';
  say(registration.waiting?'Updated offline files are ready. Close all V tool tabs, then reopen to use them.':'Offline files installed with integrity checks. Disconnect every network and reload to verify offline use on your phone.');
}catch(error){say(error.message,true);}});
