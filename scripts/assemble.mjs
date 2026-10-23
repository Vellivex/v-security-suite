// SPDX-License-Identifier: GPL-3.0-or-later
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const assets={};
for(const [path,file,type] of [
 ['/style.css','web/style.css','text/css; charset=utf-8'],['/site.js','web/site.js','text/javascript; charset=utf-8'],['/app.js','web/app.js','text/javascript; charset=utf-8'],['/apps/crypto.js','apps/vault/crypto.js','text/javascript; charset=utf-8'],['/sw.js','web/sw.js','text/javascript; charset=utf-8']
])assets[path]={body:await readFile(resolve(root,file),'utf8'),type};
assets['/icon.svg']={body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="38" fill="#0b100d"/><path d="M35 43h29l32 83 32-83h29l-49 115H84z" fill="#c7df9b"/></svg>',type:'image/svg+xml'};
assets['/manifest.webmanifest']={body:JSON.stringify({name:'V Security experimental tools',short_name:'V Tools',id:'/apps/vault',start_url:'/apps/vault',scope:'/apps/',display:'standalone',background_color:'#0b100d',theme_color:'#0b100d',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}),type:'application/manifest+json'};
for(const name of ['VGuard-0.1.1-preview.apk','VGuard-Source-GPL.zip','V-Security-Source.zip','VGuard-Setup.txt','VGuard-Test-Report.txt','RELEASE-NOTES.txt']){
 const binary=name.endsWith('.apk')||name.endsWith('.zip');
 assets['/downloads/'+name]={body:await readFile(resolve(root,'releases',name),binary?'base64':'utf8'),base64:binary,type:name.endsWith('.apk')?'application/vnd.android.package-archive':name.endsWith('.zip')?'application/zip':'text/plain; charset=utf-8',download:binary?name:undefined};
}
let pages=await readFile(resolve(root,'server/pages.js'),'utf8');
pages=pages.replaceAll('export function ','function ');
let handler=await readFile(resolve(root,'server/handler.js'),'utf8');handler=handler.replaceAll('export async function ','async function ').replaceAll('export function ','function ');
await mkdir(resolve(root,'worker'),{recursive:true});
await writeFile(resolve(root,'worker/index.js'),pages+'\n'+handler+'\nconst ASSETS='+JSON.stringify(assets)+';\nexport default makeWorker(page,notFound,ASSETS);\n');
console.log('Assembled self-contained Worker with '+Object.keys(assets).length+' assets.');
