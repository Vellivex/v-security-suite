import assert from "node:assert/strict";
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
for(const path of ['/','/beta','/apps/guard','/apps/vault','/apps/relay','/source','/trust','/privacy','/terms','/feedback','/security','/brand','/roadmap']){
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
const build=await deployedWorker.fetch(new Request(origin+'/downloads/VGuard-0.1.3-Build-Report.json'),{});
const report=await build.json(),guard=await deployedWorker.fetch(new Request(origin+'/apps/guard'),{});
assert.ok((await guard.text()).includes(report.sha256));
const missing=await deployedWorker.fetch(new Request(origin+'/nonexistent-test-page'),{});assert.equal(missing.status,404);
console.log('Assembled routes, isolation headers, embedded download checksums and APK metadata agree.');
