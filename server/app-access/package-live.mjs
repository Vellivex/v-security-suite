// Local packaging only: no network, deployments, bindings, mail or paid flags.
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, mkdtemp, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { offlineRelease } from '../../scripts/offline-release.mjs';
import { CALL_BASELINE_SHA256, CALL_PATCH_REPLACEMENTS } from './patch-call.mjs';
import { MAIL_BASELINE_SHA256, MAIL_PATCH_REPLACEMENTS } from './patch-mail.mjs';
import { createChatSessionOverride, createChatOverrides, CHAT_SESSION_BASELINE_SHA256 } from './patch-chat.mjs';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(sourceRoot, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const JS = 'application/javascript+module';
export const LIVE_OFFLINE_MANIFEST_SHA256 = '9333de045d33583f27a4059263efb9ddc96fd3b3d5ce23de315f7fda685373ed';
export const SITE_SOURCE_HASHES = Object.freeze({
  'sw.js': '4649ea41a93ce0f20783903254b43b1ec4784bf6ab357608fe80b82bafca0ad6',
  'mail-ui.js': 'be887402c1c6a6e4ee0f9671348941e00bf230d6cfceeb9aa575b4db72147c4d',
  'sms-ui.js': '82caad5287b9d339ef67a404b07437c3b5eeeb1280316a199624c4479a29603a'
});
const shared = ['entry.mjs', 'gate.mjs', 'registry.mjs'];
export const WORKER_PLANS = Object.freeze({
  accounts: { service: 'vellivex-accounts', originalMain: 'account-owner-pilot-worker.mjs', origins: ['https://call.vellivex.com'],
    runtime: [...shared, 'core.mjs', 'mail.mjs', 'ui.mjs', 'call-scope.mjs'], patches: ['call'], generated: [] },
  site: { service: 'vellivex-site-migration', originalMain: 'index.mjs', origins: ['https://www.vellivex.com', 'https://vellivex.com'],
    runtime: [...shared, 'site-overlay.mjs', 'mail-proxy.mjs', 'mail-transport.mjs'], patches: [], generated: ['site-overrides.mjs'] },
  vphone: { service: 'vellivex-vphone-independent-staging', originalMain: 'public-entry.mjs', origins: ['https://vphone.vellivex.com'], runtime: shared, patches: [], generated: [] },
  vdecoy: { service: 'vellivex-vdecoy-independent-staging', originalMain: 'public-entry.mjs', origins: ['https://vdecoy.vellivex.com'], runtime: shared, patches: [], generated: [] },
  vkey: { service: 'vellivex-vkey-independent-staging', originalMain: 'public-entry.mjs', origins: ['https://vkey.vellivex.com'], runtime: shared, patches: [], generated: ['chat-overrides.mjs'] },
  private: { service: 'vellivex-vphone-private-independent-staging', originalMain: 'public-entry.mjs', origins: ['https://private.vellivex.com'], runtime: shared, patches: [], generated: ['chat-overrides.mjs'] },
  mail: { service: 'vellivex-disposable-mail-pilot', originalMain: 'worker.js', origins: [],
    runtime: ['mail-backend-guard.mjs', 'mail-transport.mjs'], patches: ['mail'], generated: [] }
});

// This function is self-contained so the same checks can run in a remote
// preservation tool without Node imports or rebuilding the original modules.
export async function applyGuardedPatch(source, descriptor) {
  if (typeof source !== 'string' || !descriptor || !/^[a-f0-9]{64}$/.test(descriptor.baselineSha256) ||
      !/^[a-f0-9]{64}$/.test(descriptor.candidateSha256) || !Array.isArray(descriptor.replacements)) throw new Error('Invalid patch descriptor.');
  const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('');
  if (await digest(source) !== descriptor.baselineSha256) throw new Error('Live module changed; review before patching.');
  for (const pair of descriptor.replacements) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string') || !pair[0] || source.split(pair[0]).length !== 2) throw new Error('Patch anchor missing or ambiguous.');
    source = source.replace(pair[0], pair[1]);
  }
  if (await digest(source) !== descriptor.candidateSha256) throw new Error('Patched module hash mismatch.');
  return source;
}

export function createWorkerEntries() {
  const entries = {};
  for (const [name, plan] of Object.entries(WORKER_PLANS)) {
    const lines = [`import original from './${plan.originalMain}';`, `export * from './${plan.originalMain}';`];
    if (name === 'mail') {
      lines.push("import { guardMailBackend } from './app-access/mail-backend-guard.mjs';", 'export default guardMailBackend(original);');
    } else {
      lines.push("import { withAppAccess } from './app-access/entry.mjs';");
      const options = [`origins:${JSON.stringify(plan.origins)}`];
      if (name === 'accounts') {
        lines.push("import { createAppAccess } from './app-access/core.mjs';", 'const central = createAppAccess();');
        options.push('central');
      } else if (name === 'site') {
        lines.push("import overrides from './app-access/site-overrides.mjs';", "import { transformSiteResponse } from './app-access/site-overlay.mjs';", "import { createMailProxy } from './app-access/mail-proxy.mjs';");
        options.push('overrides', 'transform:transformSiteResponse', 'proxy:createMailProxy()');
      } else if (['vkey', 'private'].includes(name)) {
        lines.push("import overrides from './app-access/chat-overrides.mjs';");
        options.push('overrides');
      }
      lines.push(`export default withAppAccess(original,{${options.join(',')}});`);
    }
    entries[name] = lines.join('\n') + '\n';
  }
  return entries;
}

export async function buildPayload({ offlineManifestPath, chatClientPath = join(projectRoot, 'tests/fixtures/app-access/public-session-baseline.mjs'), webRoot = join(projectRoot, 'web') } = {}) {
  if (!offlineManifestPath) throw new Error('An independently verified live offline manifest is required.');
  const manifestFile = await readFile(offlineManifestPath, 'utf8');
  const manifestText = manifestFile.endsWith('\n') ? manifestFile.slice(0, -1) : manifestFile;
  if (hash(manifestText) !== LIVE_OFFLINE_MANIFEST_SHA256) throw new Error('Live offline manifest hash mismatch.');
  const manifest = JSON.parse(manifestText);
  if (!Array.isArray(manifest) || manifest.length !== 34) throw new Error('The exact 34-entry live offline manifest is required.');
  const siteSources = {};
  for (const [name, expected] of Object.entries(SITE_SOURCE_HASHES)) {
    const source = await readFile(join(webRoot, name), 'utf8');
    if (hash(source) !== expected) throw new Error(`Site source ${name} differs from the tested version.`);
    siteSources[name] = source;
  }
  const release = offlineRelease(manifest, siteSources['sw.js']);
  const siteOverrides = Object.fromEntries(['sw.js', 'mail-ui.js', 'sms-ui.js'].map(name => ['/' + name,
    { body: name === 'sw.js' ? release.source : siteSources[name], type: 'text/javascript; charset=utf-8' }]));
  const chatOverrides = createChatSessionOverride(await readFile(chatClientPath, 'utf8'));
  const generatedModules = {
    'app-access/site-overrides.mjs': 'export default ' + JSON.stringify(siteOverrides) + ';\n',
    'app-access/chat-overrides.mjs': 'export default ' + JSON.stringify(chatOverrides) + ';\n'
  };
  const runtimeModules = {};
  for (const name of [...new Set(Object.values(WORKER_PLANS).flatMap(plan => plan.runtime))].sort()) runtimeModules['app-access/' + name] = await readFile(join(sourceRoot, name), 'utf8');
  const patches = {
    call: { module: 'accounts-core.mjs', baselineSha256: CALL_BASELINE_SHA256,
      candidateSha256: 'e8baac457c4f0f04b4d8bab006a9cfb0bbe47dd9610bf71d6ec64f1e8e17b88e', replacements: CALL_PATCH_REPLACEMENTS,
      functionSource: applyGuardedPatch.toString(), moduleSource: await readFile(join(sourceRoot, 'patch-call.mjs'), 'utf8') },
    mail: { module: 'worker.js', baselineSha256: MAIL_BASELINE_SHA256,
      candidateSha256: 'f26d1b7a0dccfa466a99a3951cfc6530486d0ae377edcb24e7879483e9db2844', replacements: MAIL_PATCH_REPLACEMENTS,
      functionSource: applyGuardedPatch.toString(), moduleSource: await readFile(join(sourceRoot, 'patch-mail.mjs'), 'utf8') }
  };
  const workerPlans = Object.fromEntries(Object.entries(WORKER_PLANS).map(([name, plan]) => [name, {
    service: plan.service, originalMain: plan.originalMain, newMain: 'app-access-entry.mjs', origins: plan.origins,
    runtimeModules: plan.runtime.map(module => 'app-access/' + module), generatedModules: plan.generated.map(module => 'app-access/' + module), patches: plan.patches
  }]));
  const evidence = { offlineManifestSha256: LIVE_OFFLINE_MANIFEST_SHA256, offlineAssetCount: manifest.length,
    offlineCacheId: release.cacheId, serviceWorkerSha256: hash(release.source), chatClientBaselineSha256: CHAT_SESSION_BASELINE_SHA256,
    runtimeModuleHashes: Object.fromEntries(Object.entries(runtimeModules).map(([name, source]) => [name, hash(source)])),
    generatedModuleHashes: Object.fromEntries(Object.entries(generatedModules).map(([name, source]) => [name, hash(source)])) };
  return { protocol: 'vellivex.app-access.package.v1', moduleType: JS, runtimeModules, workerEntries: createWorkerEntries(), workerPlans, patches, generatedModules, siteOverrides, chatOverrides, evidence };
}

function validModuleName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_./-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..');
}

export async function readVerifiedModules(directory, expected) {
  if (!directory || !expected || typeof expected !== 'object' || Array.isArray(expected) || !Object.keys(expected).length) throw new Error('A complete independent module hash inventory is required.');
  const found = {};
  async function scan(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (!validModuleName(name) || entry.isSymbolicLink()) throw new Error('Unsafe module path.');
      if (entry.isDirectory()) await scan(name);
      else if (entry.isFile()) found[name] = await readFile(join(directory, name));
      else throw new Error('Unsupported module file.');
    }
  }
  await scan();
  if (Object.keys(found).sort().join('\n') !== Object.keys(expected).sort().join('\n')) throw new Error('Local snapshot is incomplete or differs from the independent inventory.');
  for (const [name, bytes] of Object.entries(found)) if (!/^[a-f0-9]{64}$/.test(expected[name]) || hash(bytes) !== expected[name]) throw new Error(`Baseline hash mismatch: ${name}`);
  return found;
}

export async function packLiveWorkers({ baselineDirs, expectedModules, outputDir, ...options } = {}) {
  if (!outputDir || !baselineDirs || !expectedModules) throw new Error('All seven complete baselines, independent inventories and a new output directory are required.');
  const payload = await buildPayload(options), prepared = {};
  for (const [name, plan] of Object.entries(payload.workerPlans)) {
    const modules = await readVerifiedModules(baselineDirs[name], expectedModules[name]);
    if (!Object.hasOwn(modules, plan.originalMain)) throw new Error(`${name} original main module is missing.`);
    if (name === 'vkey' || name === 'private') {
      if (!modules['public-assets.mjs']) throw new Error('Complete chat asset module is required for local packing.');
      const overrides = createChatOverrides(name, modules['public-assets.mjs'].toString('utf8'));
      if (JSON.stringify(overrides) !== JSON.stringify(payload.chatOverrides)) throw new Error('Chat override mismatch.');
    }
    for (const patchName of plan.patches) {
      const descriptor = payload.patches[patchName];
      if (!modules[descriptor.module]) throw new Error('Patched module is missing.');
      modules[descriptor.module] = Buffer.from(await applyGuardedPatch(modules[descriptor.module].toString('utf8'), descriptor));
    }
    const additions = { [plan.newMain]: payload.workerEntries[name] };
    for (const module of plan.runtimeModules) additions[module] = payload.runtimeModules[module];
    for (const module of plan.generatedModules) additions[module] = payload.generatedModules[module];
    for (const [module, source] of Object.entries(additions)) {
      if (Object.hasOwn(modules, module)) throw new Error(`Refusing to overwrite an existing module: ${module}`);
      modules[module] = Buffer.from(source);
    }
    prepared[name] = modules;
  }
  const destination = resolve(outputDir);
  try { await lstat(destination); throw new Error('Output directory already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(join(dirname(destination), '.vellivex-app-access-package-'));
  try {
    const manifest = { protocol: payload.protocol, evidence: payload.evidence, workers: {} };
    for (const [name, modules] of Object.entries(prepared)) {
      const plan = payload.workerPlans[name], directory = join(temporary, plan.service, 'modules');
      manifest.workers[name] = { ...plan, hashes: {} };
      for (const [module, bytes] of Object.entries(modules)) {
        await mkdir(dirname(join(directory, module)), { recursive: true });
        await writeFile(join(directory, module), bytes, { flag: 'wx' });
        manifest.workers[name].hashes[module] = hash(bytes);
      }
    }
    await writeFile(join(temporary, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, destination);
    return manifest;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, configPath, output] = process.argv.slice(2);
  if (!['payload', 'pack'].includes(mode) || !configPath || !output) throw new Error('Usage: node package-live.mjs payload|pack CONFIG.json OUTPUT');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (mode === 'payload') {
    const payload = await buildPayload(config);
    await writeFile(output, JSON.stringify(payload), { flag: 'wx' });
    console.log(JSON.stringify({ workers: Object.keys(payload.workerPlans), payloadSha256: hash(JSON.stringify(payload)), evidence: payload.evidence }));
  } else {
    const manifest = await packLiveWorkers({ ...config, outputDir: output });
    console.log(JSON.stringify({ workers: Object.keys(manifest.workers), output }));
  }
}
