import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const defaultDirectory=fileURLToPath(new URL('../apps/cipher/vendor/',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyVendor(directory=defaultDirectory){
 const provenance=JSON.parse(await readFile(resolve(directory,'PROVENANCE.json'),'utf8'));
 for(const [name,source,runtime] of [['encoder','qrcodegen.ts','qrcodegen.js'],['decoder','jsqr-upstream.js','jsqr.js']]){
  const record=provenance[name];assert.ok(record&&typeof record==='object','Missing '+name+' provenance');
  const [upstream,generated]=await Promise.all([readFile(resolve(directory,source)),readFile(resolve(directory,runtime))]);
  assert.equal(digest(upstream),record.source_sha256,name+' source hash does not match provenance');
  assert.equal(digest(generated),record.runtime_sha256,name+' runtime hash does not match provenance');
  // Runtime hashes alone could be updated alongside altered generated code.
  // Independently derive the expected bytes from the retained upstream source.
  // A compiler version change is acceptable only when these exact bytes agree.
  const expected=name==='encoder'
   ?stripTypeScriptTypes(upstream.toString('utf8'),{mode:'transform'})+'\nexport {qrcodegen};\n'
   :'// Upstream UMD bundled locally; Apache-2.0, see jsqr-LICENSE.txt\nconst module={exports:{}};const exports=module.exports;\n'+upstream.toString('utf8')+'\nexport default module.exports;\n';
  assert.ok(generated.equals(Buffer.from(expected,'utf8')),name+' runtime does not derive from the recorded local transform');
 }
 return {verified:['encoder','decoder']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.ok(process.argv.length<=3,'Usage: node scripts/verify-vendor.mjs [vendor-directory]');
 await verifyVendor(process.argv[2]);console.log('QR vendor source hashes and generated runtime transformations verified.');
}
