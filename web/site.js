// SPDX-License-Identifier: GPL-3.0-or-later
document.getElementById('menu-toggle')?.addEventListener('click',()=>{const nav=document.getElementById('navigation');const open=nav.classList.toggle('open');document.getElementById('menu-toggle').setAttribute('aria-expanded',String(open));});
const feedback=document.getElementById('feedback-form');
if(feedback){
  const query=globalThis.location?new URLSearchParams(location.search):null;
  for(const name of ['product','kind']){const field=feedback.elements?.namedItem(name);const value=query?.get(name);if(field&&Array.from(field.options||[]).some(option=>option.value===value))field.value=value;}
  function feedbackReference(){
    try{
      const provider=globalThis.crypto;
      if(typeof provider?.randomUUID==='function')return provider.randomUUID();
      if(typeof provider?.getRandomValues!=='function')throw new Error('Unavailable');
      const bytes=new Uint8Array(16);provider.getRandomValues(bytes);
      bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
      const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
      return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    }catch{throw new Error('Secure randomness is unavailable. Please use a supported browser to send feedback.');}
  }
  // Create references only inside the prevented submit handler. A missing or
  // failed randomness provider must never leave the native form unguarded.
  const started=Date.now();let submissionId=null,revision=0,changed=false,pending=false;
  for(const type of ['input','change'])feedback.addEventListener(type,()=>{revision++;changed=true;});
  feedback.addEventListener('submit',async event=>{event.preventDefault();if(pending)return;
    const status=document.getElementById('feedback-status'),button=document.getElementById('feedback-submit');pending=true;button.disabled=true;status.textContent='Sending feedback…';
    let timer;
    try{if(changed||submissionId===null){submissionId=feedbackReference();changed=false;}
      const sentRevision=revision,sentId=submissionId,controller=new AbortController();
      const data=Object.fromEntries(new FormData(feedback));data.id=sentId;data.elapsed=Date.now()-started;
      // Bound the whole exchange, including an incomplete response body. Retain
      // the reference after an uncertain write so a retry stays idempotent.
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Feedback request timed out. Please try again.'));controller.abort();},30000);});
      const {response,result}=await Promise.race([(async()=>{const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal});const result=await response.json();return {response,result};})(),deadline]);if(response.status===409)submissionId=null;if(!response.ok)throw new Error(result.error||'Unable to save your feedback.');if(result.saved!==true||result.id!==sentId)throw new Error('The server did not confirm this report.');status.textContent='Feedback saved privately. Your reference is '+result.id+'.'+(revision===sentRevision?' Thank you.':' Your newer edits are still in this form; send them as a new report.');if(revision===sentRevision)feedback.reset();submissionId=null;}
    catch(error){status.textContent=error.message+' Your feedback is still in this form.';}
    finally{clearTimeout(timer);pending=false;button.disabled=false;}
  });
}
