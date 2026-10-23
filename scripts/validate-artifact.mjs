import assert from "node:assert/strict";
import {validateReleaseBinding} from "./artifact-binding.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");

// Exercise the exact assembled Worker and embedded downloads, not only source.
const deployedWorker=workerModule.default;
const origin='https://artifact.vellivex.test';
for(const path of ['/blog','/blog/test-local-message-encryption','/blog/transfer-ciphertext-without-sharing-the-passphrase','/blog/android-firewall-test-checklist','/blog/read-security-claims-before-testing','/apps/cipher','/apps/cipher/vault','/apps/cipher/relay','/','/beta','/apps/guard','/apps/vault','/apps/relay','/source','/trust','/privacy','/terms','/feedback','/security','/brand','/roadmap']){
  const response=await deployedWorker.fetch(new Request(origin+path),{});
  assert.equal(response.status,200,path);
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'),'DENY');
  assert.ok(response.headers.get('Content-Security-Policy').includes("default-src 'none'"));
  if(path==='/apps/vault'||path==='/apps/relay')assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'none'"));
}
const {createHash}=await import('node:crypto');
const sums=await deployedWorker.fetch(new Request(origin+'/downloads/SHA256SUMS.txt'),{});
for(const line of (await sums.text()).trim().split('\n')){
  const [expected,name]=line.split('  '),response=await deployedWorker.fetch(new Request(origin+'/downloads/'+name),{});
  assert.equal(response.status,200,name);
  assert.equal(createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex'),expected,name);
}
await validateReleaseBinding(deployedWorker,origin);
const missing=await deployedWorker.fetch(new Request(origin+'/nonexistent-test-page'),{});assert.equal(missing.status,404);
console.log('Assembled routes, isolation headers, embedded download checksums and APK metadata agree.');

// Check every offline manifest entry against the exact bytes it downloads.
const sw=await deployedWorker.fetch(new Request(origin+'/sw.js'),{}),swText=await sw.text();
const offlineFiles=JSON.parse(/const FILES=(\[.*\]);/.exec(swText)[1]);
for(const file of offlineFiles){
 const response=await deployedWorker.fetch(new Request(origin+(file.source||file.url)),{});assert.equal(response.status,200,file.url);
 const bytes=new Uint8Array(await response.arrayBuffer());assert.equal('sha256-'+createHash('sha256').update(bytes).digest('base64'),file.integrity,file.url);
 const canonical=await deployedWorker.fetch(new Request(origin+file.url),{});assert.equal(canonical.status,200,file.url);
 assert.deepEqual(file.headers,Object.fromEntries(canonical.headers),'Offline response policy '+file.url);
 assert.equal(createHash('sha256').update(new Uint8Array(await canonical.arrayBuffer())).digest('base64'),file.integrity.slice(7),'Canonical offline bytes '+file.url);
}
for(const path of ['/apps/cipher/protocol.js','/apps/cipher/qr.js','/apps/cipher/vendor/qrcodegen.js','/apps/cipher/vendor/jsqr.js','/apps/vault/crypto.js','/cipher-ui.js']){const response=await deployedWorker.fetch(new Request(origin+path),{});assert.equal(response.status,200,path);assert.match(response.headers.get('Content-Type'),/javascript/);}
console.log('Cipher module dependencies, offline manifest digests and canonical response headers agree.');
