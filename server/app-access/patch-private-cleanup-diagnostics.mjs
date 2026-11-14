// SPDX-License-Identifier: GPL-3.0-or-later
// Private text cleanup only. No URLs, capabilities, response bodies or native
// error messages enter the diagnostic result or its rendered details.
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {CLEANUP_RELEASE_AFTER} from './patch-chat-cleanup.mjs';

export const PRIVATE_CLEANUP_BASELINE_SHA256 = '38a09a7d48bafc34b931c18413b2e31ef8c589130ff39042acc26421fa821d35';
const digest = value => createHash('sha256').update(value).digest('hex');
export const PRIVATE_CLEANUP_RELEASE = String.raw`async function release(fetcher,{room,token,role,alreadyCleared}){
  if(alreadyCleared)return {acknowledged:true};
  if(!room||!token||!['host','guest'].includes(role))return {acknowledged:false};
  const controller=new AbortController();let timer,diagnostic={phase:'request'};
  const result=acknowledged=>({acknowledged,diagnostic:{...diagnostic}});
  const pause=()=>new Promise(resolve=>{
    let delay;const done=value=>{clearTimeout(delay);controller.signal.removeEventListener('abort',aborted);resolve(value);};
    const aborted=()=>done(false);
    controller.signal.addEventListener('abort',aborted,{once:true});
    delay=setTimeout(()=>done(!controller.signal.aborted),250);
    if(controller.signal.aborted)aborted();
  });
  try{return await Promise.race([(async()=>{
    // The authenticated delete is idempotent. Retry a transient transport or
    // gateway failure once, inside the original total eight-second deadline.
    for(let attempt=0;attempt<2;attempt++){
      let response;diagnostic={phase:'request'};
      try{response=await fetcher('/api/rooms/'+room,{method:'DELETE',headers:{'X-Room-Token':token,'X-Room-Role':role,Accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',keepalive:true,signal:controller.signal});}
      catch{diagnostic={phase:controller.signal.aborted?'deadline':'network'};if(attempt===0&&!controller.signal.aborted&&await pause())continue;return result(false);}
      diagnostic={phase:'response',...(Number.isInteger(response.status)&&response.status>=100&&response.status<=599?{status:response.status}:{})};
      if(attempt===0&&[502,503,504].includes(response.status)&&!controller.signal.aborted){
        void response.body?.cancel().catch(()=>{});
        if(await pause())continue;
        return result(false);
      }
      const value=await json(response);
      return result(!controller.signal.aborted&&response.status===200&&value?.ok===true&&Object.keys(value).length===1);
    }
    return result(false);
  })().catch(()=>result(false)),new Promise(resolve=>{timer=setTimeout(()=>{diagnostic={...diagnostic,phase:'deadline'};controller.abort();resolve(result(false));},8000);})]);}
  finally{clearTimeout(timer);controller.abort();room=token=role=null;}
}`;

export const PRIVATE_CLEANUP_HELP = String.raw`function cleanupHelp(result){
  const d=result?.diagnostic;
  const status=Number.isInteger(d?.status)&&d.status>=100&&d.status<=599?' HTTP '+d.status+'.':'';
  if(d?.phase==='response')return 'Cleanup check:'+(status||' response status unavailable.');
  if(d?.phase==='network')return 'Cleanup check: network request failed.';
  if(d?.phase==='deadline')return 'Cleanup check: eight-second deadline reached.'+status;
  return 'Cleanup check: details unavailable.';
}
`;
const uiAnchor = 'export function mountLiveUI(document,window,{chatFactory=privateChatSession,voiceFactory=privateVoiceCall}={}){';
const completionAnchor = '      if(generation!==endedGeneration)return;';
const completionReplacement = completionAnchor + String.raw`
      if(s&&endedKind==='chat'&&result?.required!==false)el('connection-help').textContent+='\n'+cleanupHelp(result);`;
const embedded = value => JSON.stringify(value).slice(1, -1);
export const PRIVATE_CLEANUP_REPLACEMENTS = Object.freeze([
  [CLEANUP_RELEASE_AFTER, PRIVATE_CLEANUP_RELEASE],
  [uiAnchor, PRIVATE_CLEANUP_HELP + uiAnchor],
  [completionAnchor, completionReplacement],
].map(pair => Object.freeze(pair.map(embedded))));

export function patchPrivateCleanupDiagnostics(source) {
  if (typeof source !== 'string' || digest(source) !== PRIVATE_CLEANUP_BASELINE_SHA256) throw new Error('Private cleanup module differs from the audited baseline. Review before patching.');
  for (const [before, after] of PRIVATE_CLEANUP_REPLACEMENTS) {
    if (source.split(before).length !== 2) throw new Error('Private cleanup anchor is missing or ambiguous.');
    source = source.replace(before, after);
  }
  return source;
}

export function createPrivateCleanupDiagnostics(overrides) {
  const source = patchPrivateCleanupDiagnostics('export default ' + JSON.stringify(overrides) + ';\n');
  const assets = JSON.parse(source.slice('export default '.length, -2));
  return Object.freeze(Object.fromEntries(Object.entries(assets).map(([path, asset]) => [path, Object.freeze(asset)])));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) throw new Error('Usage: node patch-private-cleanup-diagnostics.mjs LIVE_MODULE CANDIDATE_MODULE');
  const candidate = patchPrivateCleanupDiagnostics(await readFile(input, 'utf8'));
  await writeFile(output, candidate, {flag: 'wx'});
  console.log(JSON.stringify({baselineSha256: PRIVATE_CLEANUP_BASELINE_SHA256, candidateSha256: digest(candidate)}));
}
