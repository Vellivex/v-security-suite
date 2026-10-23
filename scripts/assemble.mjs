// SPDX-License-Identifier: GPL-3.0-or-later
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {page} from '../server/pages.js';
import {offlineRelease} from './offline-release.mjs';
const root=resolve(import.meta.dirname,'..');
const assets={};
for(const file of ['protocol.js','qr.js','vendor/qrcodegen.js','vendor/jsqr.js'])assets['/apps/cipher/'+file]={body:await readFile(resolve(root,'apps/cipher',file),'utf8'),type:'text/javascript; charset=utf-8'};
assets['/cipher-ui.js']={body:await readFile(resolve(root,'web/cipher-ui.js'),'utf8'),type:'text/javascript; charset=utf-8'};
for(const [path,file,type] of [
 ['/style.css','web/style.css','text/css; charset=utf-8'],['/site.js','web/site.js','text/javascript; charset=utf-8'],['/app.js','web/app.js','text/javascript; charset=utf-8'],['/session.js','web/session.js','text/javascript; charset=utf-8'],['/offline.js','web/offline.js','text/javascript; charset=utf-8'],['/apps/crypto.js','apps/vault/crypto.js','text/javascript; charset=utf-8']
])assets[path]={body:await readFile(resolve(root,file),'utf8'),type};
assets['/apps/vault/crypto.js']={body:await readFile(resolve(root,'apps/vault/crypto.js'),'utf8'),type:'text/javascript; charset=utf-8'};
for(const name of ['vellivex-mark.svg','vellivex-logo.svg','vellivex-logo-dark.svg'])assets['/brand/'+name]={body:await readFile(resolve(root,'web/brand',name),'utf8'),type:'image/svg+xml'};
assets['/icon.svg']={body:await readFile(resolve(root,'web/brand/vellivex-mark.svg'),'utf8'),type:'image/svg+xml'};
assets['/manifest.webmanifest']={body:JSON.stringify({name:'Vellivex experimental tools',short_name:'Vellivex',id:'/apps/vault',start_url:'/apps/vault',scope:'/apps/',display:'standalone',background_color:'#0a101b',theme_color:'#0a101b',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}),type:'application/manifest+json'};
// Canonical HTML is transported as plain text so hosting-layer HTML injection
// cannot alter the bytes checked by SRI. Only the verified cached copy is HTML.
for(const name of ['vault','relay'])assets['/offline/'+name]={body:page('/apps/'+name),type:'text/plain; charset=utf-8',offlineDocument:true};
for(const role of ['vault','relay'])assets['/offline/cipher/'+role]={body:page('/apps/cipher/'+role),type:'text/plain; charset=utf-8',offlineDocument:true};
const offlinePaths=['/apps/vault/crypto.js','/apps/cipher/vault','/apps/cipher/relay','/apps/cipher/protocol.js','/apps/cipher/qr.js','/apps/cipher/vendor/qrcodegen.js','/apps/cipher/vendor/jsqr.js','/cipher-ui.js','/apps/vault','/apps/relay','/apps/crypto.js','/app.js','/session.js','/offline.js','/site.js','/style.css','/icon.svg','/manifest.webmanifest'];
const offlineManifest=offlinePaths.map(url=>({url,...(url==='/apps/vault'||url==='/apps/relay'||url.startsWith('/apps/cipher/')&&!url.endsWith('.js')?{source:url.replace('/apps/','/offline/'),type:'text/html; charset=utf-8'}:{}),integrity:'sha256-'+createHash('sha256').update(assets[url]?.body??page(url)).digest('base64')}));
assets['/sw.js']={body:offlineRelease(offlineManifest,await readFile(resolve(root,'web/sw.js'),'utf8')).source,type:'text/javascript; charset=utf-8'};
for(const name of ['VGuard-0.1.3-candidate.apk','VGuard-Source-GPL.zip','VGuard-0.1.1-Source-GPL.zip','VGuard-0.1.2-Source-GPL.zip','V-Security-Source.zip','VGuard-Setup.txt','VGuard-Test-Report.txt','RELEASE-NOTES.txt','VGuard-0.1.3-Build-Report.json','VGuard-0.1.3-Package-Verification.txt','VGuard-0.1.3-Security-Notes.txt','SHA256SUMS.txt']){
 const binary=name.endsWith('.apk')||name.endsWith('.zip');
 assets['/downloads/'+name]={body:await readFile(resolve(root,'releases',name),binary?'base64':'utf8'),base64:binary,type:name.endsWith('.apk')?'application/vnd.android.package-archive':name.endsWith('.zip')?'application/zip':name.endsWith('.json')?'application/json':'text/plain; charset=utf-8',download:binary?name:undefined};
}
let pages=await readFile(resolve(root,'server/pages.js'),'utf8');
pages=(await readFile(resolve(root,'server/cipher-pages.js'),'utf8')).replaceAll('export function ','function ')+'\n'+pages.replace("import {cipherContent} from './cipher-pages.js';\n",'').replaceAll('export function ','function ');
let handler=await readFile(resolve(root,'server/handler.js'),'utf8');handler=handler.replaceAll('export async function ','async function ').replaceAll('export function ','function ');
await mkdir(resolve(root,'worker'),{recursive:true});
await writeFile(resolve(root,'worker/index.js'),pages+'\n'+handler+'\nconst ASSETS='+JSON.stringify(assets)+';\nexport default makeWorker(page,notFound,ASSETS);\n');
console.log('Assembled self-contained Worker with '+Object.keys(assets).length+' assets.');
