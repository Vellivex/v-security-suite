// SPDX-License-Identifier: GPL-3.0-or-later
function settledWorker(worker,{schedule=setTimeout,cancel=clearTimeout}={}){
  return new Promise((resolve,reject)=>{
    let timer;
    const finish=(error)=>{worker.removeEventListener('statechange',check);cancel(timer);error?reject(error):resolve();};
    const check=()=>{if(worker.state==='installed'||worker.state==='activated')finish();else if(worker.state==='redundant')finish(new Error('Offline installation failed its file checks. Stay online and try again.'));};
    worker.addEventListener('statechange',check);
    timer=schedule(()=>finish(new Error('Offline installation timed out. Stay online and try again.')),30000);
    check();
  });
}
export async function installOfflineTools(serviceWorker){
  if(!serviceWorker)throw new Error('Offline installation is unavailable in this browser.');
  const registration=await serviceWorker.register('/sw.js',{scope:'/apps/',updateViaCache:'none'});
  // register() can resolve while first installation is in progress. Updating at
  // that point can race a failed installation and obscure the useful error.
  if(!registration.installing&&!registration.waiting&&registration.active)await registration.update();
  const worker=registration.installing||registration.waiting||registration.active;
  if(!worker)throw new Error('Offline files were not installed. Stay online and try again.');
  await settledWorker(worker);
  return {waiting:worker.state==='installed'||Boolean(registration.waiting)};
}
