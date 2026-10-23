// SPDX-License-Identifier: GPL-3.0-or-later
document.getElementById('menu-toggle')?.addEventListener('click',()=>{const nav=document.getElementById('navigation');const open=nav.classList.toggle('open');document.getElementById('menu-toggle').setAttribute('aria-expanded',String(open));});
const feedback=document.getElementById('feedback-form');
if(feedback){
  const started=Date.now();let submissionId=crypto.randomUUID();
  feedback.addEventListener('submit',async event=>{event.preventDefault();const status=document.getElementById('feedback-status'),button=document.getElementById('feedback-submit');button.disabled=true;status.textContent='Sending feedback…';
    try{const data=Object.fromEntries(new FormData(feedback));data.id=submissionId;data.elapsed=Date.now()-started;const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save your feedback.');status.textContent='Feedback saved privately. Thank you — your reference is '+result.id+'.';feedback.reset();submissionId=crypto.randomUUID();}
    catch(error){status.textContent=error.message+' Your feedback is still in this form.';}
    finally{button.disabled=false;}
  });
}
