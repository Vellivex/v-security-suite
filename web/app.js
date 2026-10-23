// SPDX-License-Identifier: GPL-3.0-or-later
import '/site.js';
import {encryptMessage,decryptMessage,inspectEnvelope} from '/apps/crypto.js';
const $=id=>document.getElementById(id);
const say=(message,error=false)=>{const el=$('app-status');if(el){el.textContent=message;el.dataset.error=String(error);}};
function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function clear(){document.querySelectorAll('[data-sensitive]').forEach(el=>{el.value='';});const out=$('result');if(out)out.value='';say('Session cleared. Browser memory cannot be guaranteed to be securely erased.');}
$('clear-session')?.addEventListener('click',clear);
let operationId=0;
const vault=$('vault-form');
if(vault){
  vault.addEventListener('submit',async e=>{
    e.preventDefault();const myId=++operationId;const action=$('vault-mode').value;const button=$('vault-submit');
    if(action==='encrypt'&&$('passphrase').value!==$('passphrase-confirm').value){say('Your passphrases do not match.',true);return;}
    button.disabled=true;say(action==='encrypt'?'Encrypting on this device…':'Unlocking on this device…');$('result').value='';
    try{
      const result=action==='encrypt'?await encryptMessage($('message').value,$('passphrase').value):await decryptMessage($('message').value,$('passphrase').value);
      if(myId!==operationId)return;
      $('result').value=result;$('result-label').textContent=action==='encrypt'?'Encrypted package':'Unlocked message';$('download-result').hidden=action!=='encrypt';
      $('passphrase').value='';$('passphrase-confirm').value='';say(action==='encrypt'?'Encrypted locally. Save the package and keep its passphrase separately.':'Unlocked locally. Clear this session when finished.');
    }catch(error){if(myId===operationId)say(error.message,true);}finally{if(myId===operationId)button.disabled=false;}
  });
  $('vault-mode').addEventListener('change',()=>{operationId++;$('vault-submit').disabled=false;$('message').value='';$('result').value='';$('passphrase').value='';$('passphrase-confirm').value='';const encrypt=$('vault-mode').value==='encrypt';$('confirm-wrap').hidden=!encrypt;$('passphrase-confirm').required=encrypt;$('message-label').textContent=encrypt?'Your message':'Encrypted VVault package';$('vault-submit').textContent=encrypt?'Encrypt on this device':'Unlock on this device';$('download-result').hidden=true;say('Ready. Use non-sensitive test messages during this beta.');});
  $('clear-session').addEventListener('click',()=>{operationId++;$('vault-submit').disabled=false;$('download-result').hidden=true;});
  $('download-result').addEventListener('click',()=>{inspectEnvelope($('result').value);download($('result').value,'v-vault-message.vvault');});
}
$('copy-result')?.addEventListener('click',async()=>{try{if(!$('result').value)throw new Error('There is no result to copy.');await navigator.clipboard.writeText($('result').value);say('Copied. Your clipboard may be visible to other apps; clear it after use.');}catch(error){say(error.message||'Copy unavailable. Select the result manually.',true);}});
const relay=$('relay-form');
if(relay){
  relay.addEventListener('submit',e=>{e.preventDefault();try{inspectEnvelope($('relay-package').value);$('result').value=$('relay-package').value;$('share-package').disabled=false;$('download-package').disabled=false;say('Package format checked. This does not authenticate its sender or verify the encrypted contents.');}catch(error){$('result').value='';$('share-package').disabled=true;$('download-package').disabled=true;say(error.message,true);}});
  $('relay-package').addEventListener('input',()=>{$('result').value='';$('share-package').disabled=true;$('download-package').disabled=true;});
  $('relay-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(file.size>200000){say('Package is too large.',true);return;}$('relay-package').value=await file.text();$('result').value='';$('share-package').disabled=true;$('download-package').disabled=true;say('Loaded locally. Check the package before sharing.');});
  $('download-package').addEventListener('click',()=>{try{inspectEnvelope($('result').value);download($('result').value,'v-relay-message.vvault');}catch(error){say(error.message,true);}});
  $('share-package').addEventListener('click',async()=>{try{const text=$('result').value;inspectEnvelope(text);if(!navigator.share){say('Sharing is unavailable here. Copy or download the encrypted package instead.');return;}await navigator.share({title:'V encrypted package',text});say('Share completed. Share the passphrase separately.');}catch(error){if(error.name!=='AbortError')say('Sharing failed. Copy or download the package instead.',true);}});
  $('clear-session').addEventListener('click',()=>{$('share-package').disabled=true;$('download-package').disabled=true;$('relay-file').value='';});
}
$('offline-enable')?.addEventListener('click',async()=>{try{if(!('serviceWorker'in navigator))throw new Error('Offline installation is unavailable in this browser.');const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/apps/'});await navigator.serviceWorker.ready;$('offline-enable').textContent='Offline files installed';say('Offline files installed. Open this tool once, disconnect all networks, then reload it to verify offline use on your phone.');}catch(error){say(error.message,true);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){operationId++;document.querySelectorAll('input[type=password]').forEach(el=>el.value='');const result=$('result');if(vault&&$('vault-mode').value==='decrypt'&&result)result.value='';if(vault)$('vault-submit').disabled=false;}});
