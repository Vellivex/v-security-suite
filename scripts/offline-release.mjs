// SPDX-License-Identifier: GPL-3.0-or-later
import {createHash} from 'node:crypto';
const requiredHeaders=['content-type','content-security-policy','x-content-type-options','referrer-policy','permissions-policy','x-frame-options','cross-origin-opener-policy','cross-origin-resource-policy','origin-agent-cluster','cache-control','strict-transport-security','x-robots-tag'];
function canonicalPath(path){
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\\\s?#]/.test(path))return false;
 return new URL(path,'https://offline.vellivex.test').pathname===path;
}
function validateManifest(manifest){
 if(!Array.isArray(manifest)||manifest.length===0)throw Error('Offline manifest must contain reviewed asset records');
 const urls=new Set();
 for(const file of manifest){
  if(!file||typeof file!=='object'||Array.isArray(file)||!canonicalPath(file.url)||urls.has(file.url)||
      (file.source!==undefined&&!canonicalPath(file.source))||typeof file.integrity!=='string'||!/^sha256-[A-Za-z0-9+/]{43}=$/.test(file.integrity))throw Error('Offline manifest contains an invalid or duplicate asset');
  urls.add(file.url);
  const headers=file.headers;
  if(!headers||typeof headers!=='object'||Array.isArray(headers)||requiredHeaders.some(name=>typeof headers[name]!=='string'||!headers[name].trim())||
      Object.values(headers).some(value=>typeof value!=='string'||/[\r\n]/.test(value))||JSON.stringify(file).includes('TRUNCATED'))throw Error('Offline manifest response policy is incomplete or truncated');
 }
}
export function offlineRelease(manifest,template){
  validateManifest(manifest);
  if(typeof template!=='string'||template.split('__CACHE_ID__').length!==2||template.split('__ASSET_MANIFEST__').length!==2)throw Error('Offline worker template placeholders are incomplete or repeated');
  const identity=createHash('sha256').update(JSON.stringify(manifest)).update('\0').update(template).digest('hex');
  const cacheId='v-tools-0.5.3-'+identity;
  return {cacheId,source:template.replace('__CACHE_ID__',cacheId).replace('__ASSET_MANIFEST__',JSON.stringify(manifest))};
}
