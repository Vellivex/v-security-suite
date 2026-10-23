// SPDX-License-Identifier: GPL-3.0-or-later
document.getElementById('menu-toggle')?.addEventListener('click',()=>{const nav=document.getElementById('navigation');const open=nav.classList.toggle('open');document.getElementById('menu-toggle').setAttribute('aria-expanded',String(open));});
const feedback=document.getElementById('feedback-form');
if(feedback){
  const started=Date.now();let submissionId=crypto.randomUUID(),revision=0,changed=false,pending=false;
  for(const type of ['input','change'])feedback.addEventListener(type,()=>{revision++;changed=true;});
  feedback.addEventListener('submit',async event=>{event.preventDefault();if(pending)return;
    if(changed){submissionId=crypto.randomUUID();changed=false;}
    const sentRevision=revision,sentId=submissionId,status=document.getElementById('feedback-status'),button=document.getElementById('feedback-submit');pending=true;button.disabled=true;status.textContent='Sending feedback…';
    let timer;const controller=new AbortController();
    try{const data=Object.fromEntries(new FormData(feedback));data.id=sentId;data.elapsed=Date.now()-started;
      // Bound the whole exchange, including an incomplete response body. Retain
      // the reference after an uncertain write so a retry stays idempotent.
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Feedback request timed out. Please try again.'));controller.abort();},30000);});
      const {response,result}=await Promise.race([(async()=>{const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal});const result=await response.json();return {response,result};})(),deadline]);if(response.status===409)submissionId=crypto.randomUUID();if(!response.ok)throw new Error(result.error||'Unable to save your feedback.');if(result.saved!==true||result.id!==sentId)throw new Error('The server did not confirm this report.');status.textContent='Feedback saved privately. Your reference is '+result.id+'.'+(revision===sentRevision?' Thank you.':' Your newer edits are still in this form; send them as a new report.');if(revision===sentRevision)feedback.reset();submissionId=crypto.randomUUID();}
    catch(error){status.textContent=error.message+' Your feedback is still in this form.';}
    finally{clearTimeout(timer);pending=false;button.disabled=false;}
  });
}
