import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyGuardedPatch, createWorkerEntries, readVerifiedModules, WORKER_PLANS, buildPayload } from '../server/app-access/package-live.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('remote-safe patch requires exact before/after hashes and unique anchors', async () => {
  const descriptor = { baselineSha256: hash('before'), candidateSha256: hash('after'), replacements: [['before', 'after']] };
  assert.equal(await applyGuardedPatch('before', descriptor), 'after');
  await assert.rejects(applyGuardedPatch('changed', descriptor), /changed/);
  await assert.rejects(applyGuardedPatch('before', { ...descriptor, candidateSha256: hash('wrong') }), /hash mismatch/);
  await assert.rejects(applyGuardedPatch('before', { ...descriptor, replacements: [['missing', 'after']] }), /anchor/);
  await assert.rejects(applyGuardedPatch('before', { ...descriptor, replacements: [['', 'after']] }), /anchor/);
  await assert.rejects(applyGuardedPatch('beforebefore', { ...descriptor, baselineSha256: hash('beforebefore') }), /anchor/);
});

test('local module inventory rejects partial, changed, extra and symlinked snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vellivex-package-inventory-'));
  try {
    await writeFile(join(root, 'main.mjs'), 'original');
    const expected = { 'main.mjs': hash('original') };
    assert.equal((await readVerifiedModules(root, expected))['main.mjs'].toString(), 'original');
    await assert.rejects(readVerifiedModules(root, { ...expected, 'missing.mjs': hash('missing') }), /incomplete/);
    await assert.rejects(readVerifiedModules(root, { 'main.mjs': hash('changed') }), /hash mismatch/);
    await writeFile(join(root, 'extra.mjs'), 'extra');
    await assert.rejects(readVerifiedModules(root, expected), /incomplete/);
    await rm(join(root, 'extra.mjs'));
    await symlink(join(root, 'main.mjs'), join(root, 'alias.mjs'));
    await assert.rejects(readVerifiedModules(root, expected), /Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all seven generated entrypoints retain named exports and lifecycle handlers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vellivex-package-entry-'));
  try {
    const entries = createWorkerEntries();
    assert.equal(Object.keys(entries).length, 7);
    for (const [name, plan] of Object.entries(WORKER_PLANS)) {
      const directory = join(root, name);
      await mkdir(join(directory, 'app-access'), { recursive: true });
      await writeFile(join(directory, plan.originalMain), 'export class PreservedActor {}\nexport const sentinel=42;\nexport default {fetch:async()=>new Response("original"),scheduled:()=>"scheduled"};\n');
      for (const file of plan.runtime) await cp(new URL('../server/app-access/' + file, import.meta.url), join(directory, 'app-access', file));
      for (const file of plan.generated) await writeFile(join(directory, 'app-access', file), 'export default {};\n');
      await writeFile(join(directory, 'app-access-entry.mjs'), entries[name]);
      const original = await import(pathToFileURL(join(directory, plan.originalMain)));
      const wrapped = await import(pathToFileURL(join(directory, 'app-access-entry.mjs')));
      assert.equal(wrapped.PreservedActor, original.PreservedActor);
      assert.equal(wrapped.sentinel, 42);
      assert.equal(wrapped.default.scheduled(), 'scheduled');
      const origin = plan.origins[0] ?? 'https://mail-api.vellivex.info';
      const response = await wrapped.default.fetch(new Request(origin + '/health'), {});
      assert.equal(await response.text(), 'original');
      if (name !== 'mail') {
        const other = await wrapped.default.fetch(new Request('https://unregistered.vellivex.com/health'), {});
        assert.equal(other.status, 403);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('payload generation requires the lossless independently verified live manifest', async () => {
  await assert.rejects(buildPayload(), /verified live offline manifest/);
  const root = await mkdtemp(join(tmpdir(), 'vellivex-package-manifest-'));
  try {
    const path = join(root, 'truncated.json');
    await writeFile(path, '["TRUNCATED"]');
    await assert.rejects(buildPayload({ offlineManifestPath: path }), /hash mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
