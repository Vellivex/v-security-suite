import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {verifyVendor} from '../scripts/verify-vendor.mjs';
const vendor=fileURLToPath(new URL('../apps/cipher/vendor/',import.meta.url));
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'vellivex-vendor-'));t.after(()=>rm(root,{recursive:true,force:true}));await cp(vendor,root,{recursive:true});return root;}
test('retained QR source and runtime exactly match their recorded provenance and local transforms',async()=>{
 assert.deepEqual(await verifyVendor(),{verified:['encoder','decoder']});
});
for(const [name,file] of [['encoder','qrcodegen.ts'],['decoder','jsqr-upstream.js']])test(`${name} upstream source mutation is rejected`,async t=>{
 const root=await fixture(t);await writeFile(join(root,file),(await readFile(join(root,file),'utf8'))+'\n// synthetic unreviewed source change\n');
 await assert.rejects(verifyVendor(root),/source hash/i);
});
for(const [name,file] of [['encoder','qrcodegen.js'],['decoder','jsqr.js']])for(const resummed of [false,true])test(`${name} runtime mutation is rejected${resummed?' even after its provenance hash is updated':''}`,async t=>{
 const root=await fixture(t),path=join(root,file);await writeFile(path,(await readFile(path,'utf8'))+'\nglobalThis.SYNTHETIC_VENDOR_MUTATION=true;\n');
 if(resummed){const metadata=JSON.parse(await readFile(join(root,'PROVENANCE.json'),'utf8'));metadata[name].runtime_sha256=createHash('sha256').update(await readFile(path)).digest('hex');await writeFile(join(root,'PROVENANCE.json'),JSON.stringify(metadata));}
 await assert.rejects(verifyVendor(root),resummed?/transform|derive/i:/runtime hash/i);
});
