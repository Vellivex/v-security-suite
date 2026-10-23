// SPDX-License-Identifier: GPL-3.0-or-later
export async function installOfflineTools(serviceWorker,{schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}={}){
  if(!serviceWorker)throw new Error('Offline installation is unavailable in this browser.');
  let timer,removeListener=()=>{};
  // One deadline covers registration, update and file checks. Native browser
  // jobs cannot be cancelled here; a late result must not continue this task.
  const deadline=new Promise((_,reject)=>{timer=schedule(()=>reject(new Error('Offline installation timed out. The browser may still finish in the background. Stay online and try again.')),30000);});
  const bounded=work=>Promise.race([work,deadline]);
  try{
    const registration=await bounded(serviceWorker.register('/sw.js',{scope:'/apps/',updateViaCache:'none'}));
    // register() can resolve while first installation is in progress. Updating
    // at that point can race a failed installation and obscure its useful error.
    const previous=registration.active;
    if(!registration.installing&&!registration.waiting&&registration.active)await bounded(registration.update());
    const worker=registration.installing||registration.waiting||registration.active;
    if(!worker)throw new Error('Offline files were not installed. Stay online and try again.');
    await bounded(new Promise((resolve,reject)=>{
      const check=()=>{if(worker.state==='installed'||worker.state==='activated')resolve();else if(worker.state==='redundant')reject(new Error('Offline installation failed its file checks. Stay online and try again.'));};
      removeListener=()=>worker.removeEventListener('statechange',check);
      worker.addEventListener('statechange',check);check();
    }));
    return {waiting:worker.state==='installed'||Boolean(registration.waiting),unchanged:worker===previous};
  }finally{cancel(timer);removeListener();}
}
