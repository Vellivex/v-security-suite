import test from 'node:test';
import assert from 'node:assert/strict';
import {page} from '../server/pages.js';

// A browser/keyboard can override these hints. This verifies our opt-out,
// not that the operating system or an extension cannot read an input.
for(const path of ['/apps/vault','/apps/relay','/apps/cipher/vault','/apps/cipher/relay'])test(`${path} opts sensitive text out of browser writing assistance`,()=>{
 const html=page(path);
 assert.ok(/<html\b[^>]*\btranslate="no"/.test(html),`${path}: page must request no translation`);
 const fields=html.match(/<(?:textarea|input)\b[^>]*\bdata-(?:cipher-)?sensitive\b[^>]*>/g)||[];
 assert.ok(fields.length>0);
 for(const field of fields){
  if(/type="file"/.test(field))continue;
  for(const attribute of ['spellcheck="false"','autocorrect="off"','autocapitalize="off"','autocomplete="off"','translate="no"','writingsuggestions="false"'])assert.ok(field.includes(attribute),`${path}: ${attribute} missing from ${field}`);
 }
});
