// SPDX-License-Identifier: GPL-3.0-or-later
// Anonymous automation can check admission availability, but cannot test an app
// behind email verification. This helper never reads cookies or requests email.
import {appendFile} from 'node:fs/promises';
import {PAGES, checkPage} from './live-availability.mjs';

export async function publicBrowserPreflight(label, targets, {
  fetcher=fetch, log=console.log, summaryPath=process.env.GITHUB_STEP_SUMMARY,
}={}) {
  if(typeof label!=='string'||!/^[A-Za-z0-9 ,/-]{1,80}$/.test(label)||!Array.isArray(targets)||!targets.length||targets.length>11)
    throw new TypeError('Invalid public browser check.');
  const allowed=new Map(PAGES.slice(2).map(([name,url])=>[url,name]));
  for(const url of targets) if(!allowed.has(url)) throw new TypeError('Only fixed application sign-in gates may be checked.');
  const results=[];
  for(const url of targets) results.push(await checkPage(allowed.get(url),url,{fetcher}));
  const healthy=results.every(result=>result.ok&&result.availability==='sign-in-required');
  for(const result of results) log(`${result.ok?'AUTH GATE HEALTHY':'FAIL'} ${result.name}: ${result.status??'no response'}${result.problem?' - '+result.problem:''}`);
  const summary=`${label}: ${healthy?'SIGN-IN REQUIRED':'ADMISSION CHECK FAILED'}. Deep browser checks NOT RUN. They require a browser context already verified by email. No emails, app sessions, rooms, messages or calls were created.`;
  log(summary);
  if(summaryPath) await appendFile(summaryPath,summary+'\n');
  if(!healthy) throw new Error('Application sign-in gate did not meet its availability contract.');
  return {deepChecks:'not-run',gateHealthy:true};
}
