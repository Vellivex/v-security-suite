// SPDX-License-Identifier: GPL-3.0-or-later
import {createHash} from 'node:crypto';
export function offlineRelease(manifest,template){
  const identity=createHash('sha256').update(JSON.stringify(manifest)).update('\0').update(template).digest('hex');
  const cacheId='v-tools-0.3.8-'+identity;
  return {cacheId,source:template.replace('__CACHE_ID__',cacheId).replace('__ASSET_MANIFEST__',JSON.stringify(manifest))};
}
