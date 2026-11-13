import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APK_NOT_RUN, VGUARD_DOWNLOAD_URL, checkVGuardDownloadAccess, runVGuardDownloadAccess} from '../scripts/vguard-download-access.mjs';

const shellScript = fileURLToPath(new URL('../scripts/vguard-apk-install-smoke.sh', import.meta.url));
const helperScript = fileURLToPath(new URL('../scripts/vguard-download-access.mjs', import.meta.url));
const gateHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Vellivex-App-Access': 'required',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

function gate({headers = {}, status = 200, body = null, url, redirected} = {}) {
  const merged = new Headers(gateHeaders);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  const response = new Response(body, {status, headers: merged});
  if (url !== undefined) Object.defineProperty(response, 'url', {value: url});
  if (redirected !== undefined) Object.defineProperty(response, 'redirected', {value: redirected});
  return response;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vellivex-download-access-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('anonymous check uses only the pinned URL without credentials or redirects and leaves APK checks not run', async () => {
  const requests = [];
  let cancelled = 0;
  const result = await checkVGuardDownloadAccess({fetcher: async (url, init) => {
    requests.push({url, init});
    return gate({url: VGUARD_DOWNLOAD_URL, body: new ReadableStream({cancel() { cancelled++; }})});
  }});
  assert.equal(VGUARD_DOWNLOAD_URL, 'https://www.vellivex.com/downloads/VGuard-0.1.4-candidate.apk');
  assert.deepEqual(result, {gate: 'pass', apkIntegrity: 'not-run', signature: 'not-run', android: 'not-run'});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, VGUARD_DOWNLOAD_URL);
  assert.deepEqual({...requests[0].init, signal: undefined}, {
    method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'omit',
    referrerPolicy: 'no-referrer', headers: {Accept: 'application/vnd.android.package-archive'}, signal: undefined,
  });
  assert.equal(cancelled, 1);
  assert.equal(requests[0].init.signal.aborted, true);
});

test('a private no-store directive can coexist with other cache directives', async () => {
  const result = await checkVGuardDownloadAccess({fetcher: async () => gate({headers: {
    'Content-Type': 'TEXT/HTML; charset=UTF-8', 'Cache-Control': 'private, NO-STORE, max-age=0',
  }})});
  assert.equal(result.gate, 'pass');
});

for (const [description, headers] of [
  ['APK bytes even when marked required', {'Content-Type': 'application/vnd.android.package-archive'}],
  ['an HTML body without its MIME type', {'Content-Type': null}],
  ['an authenticated response', {'X-Vellivex-App-Access': 'verified'}],
  ['a missing gate marker', {'X-Vellivex-App-Access': null}],
  ['a noncanonical gate marker', {'X-Vellivex-App-Access': 'Required'}],
  ['a cacheable gate', {'Cache-Control': 'public, max-age=300'}],
  ['a missing cache policy', {'Cache-Control': null}],
  ['a substring resembling no-store', {'Cache-Control': 'x-no-store'}],
  ['a no-store parameter instead of a directive', {'Cache-Control': 'no-store=false'}],
  ['a missing referrer policy', {'Referrer-Policy': null}],
  ['a policy allowing the origin to escape', {'Referrer-Policy': 'origin'}],
  ['an attachment disposition', {'Content-Disposition': 'attachment; filename="candidate.apk"'}],
  ['even an empty download disposition', {'Content-Disposition': ''}],
]) {
  test(`anonymous check rejects ${description}`, async () => {
    await assert.rejects(checkVGuardDownloadAccess({fetcher: async () => gate({headers})}),
      /did not require email sign-in|did not meet its privacy policy/);
  });
}

for (const status of [201, 204, 301, 302, 307, 308, 401, 403, 429, 500, 503]) {
  test(`anonymous check rejects HTTP ${status} without treating it as a healthy gate`, async () => {
    await assert.rejects(checkVGuardDownloadAccess({fetcher: async () => gate({status})}), /unexpected status or redirect/);
  });
}

test('anonymous check rejects a followed redirect and a changed response URL', async () => {
  for (const options of [{redirected: true}, {url: 'https://call.vellivex.com/access'}, {url: VGUARD_DOWNLOAD_URL + '?alternate=1'}]) {
    await assert.rejects(checkVGuardDownloadAccess({fetcher: async () => gate(options)}), /unexpected status or redirect/);
  }
});

test('an HTTP-shaped object cannot spoof the expected Response contract', async () => {
  await assert.rejects(checkVGuardDownloadAccess({fetcher: async () => ({status: 200, headers: new Headers(gateHeaders)})}), /did not return an HTTP response/);
});

test('body cancellation also happens for an exposed anonymous APK', async () => {
  let cancelled = 0;
  const body = new ReadableStream({cancel() { cancelled++; }});
  await assert.rejects(checkVGuardDownloadAccess({fetcher: async () => gate({
    headers: {'Content-Type': 'application/vnd.android.package-archive'}, body,
  })}), /did not require email sign-in/);
  assert.equal(cancelled, 1);
});

test('a hanging body cancellation cannot hang a successful admission report', {timeout: 1000}, async () => {
  const body = new ReadableStream({cancel() { return new Promise(() => {}); }});
  assert.equal((await checkVGuardDownloadAccess({fetcher: async () => gate({body}), timeoutMs: 100})).gate, 'pass');
});

test('a rejecting body cancellation cannot create a false failure or unhandled rejection', async () => {
  const body = new ReadableStream({cancel() { return Promise.reject(new Error('stream already closed')); }});
  assert.equal((await checkVGuardDownloadAccess({fetcher: async () => gate({body})})).gate, 'pass');
  await new Promise(resolve => setImmediate(resolve));
});

test('a hanging fetch times out and aborts its request', {timeout: 1000}, async () => {
  let signal;
  await assert.rejects(checkVGuardDownloadAccess({timeoutMs: 10, fetcher: async (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  }}), /timed out/);
  assert.equal(signal.aborted, true);
});

test('a response arriving after the timeout is cancelled and cannot become a pass', {timeout: 1000}, async () => {
  let finishFetch;
  let cancelled = 0;
  const pending = checkVGuardDownloadAccess({timeoutMs: 10, fetcher: () => new Promise(resolve => { finishFetch = resolve; })});
  await assert.rejects(pending, /timed out/);
  finishFetch(gate({body: new ReadableStream({cancel() { cancelled++; }})}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('invalid deadlines fail before any request is sent', async () => {
  let requests = 0;
  for (const timeoutMs of [0, -1, 30001, 1.5, NaN, Infinity, '100']) {
    await assert.rejects(checkVGuardDownloadAccess({timeoutMs, fetcher: async () => { requests++; return gate(); }}), TypeError);
  }
  assert.equal(requests, 0);
});

test('network errors remain failures and abort their request', async () => {
  let signal;
  await assert.rejects(checkVGuardDownloadAccess({fetcher: async (_url, init) => {
    signal = init.signal;
    throw new Error('network unavailable');
  }}), /network unavailable/);
  assert.equal(signal.aborted, true);
});

test('console and appended CI summary report admission only and explicitly leave binary/device verification not run', async t => {
  const directory = await temporaryDirectory(t);
  const summaryPath = join(directory, 'summary.md');
  const messages = [];
  await writeFile(summaryPath, 'Earlier check.\n');
  await runVGuardDownloadAccess({summaryPath, log: line => messages.push(line), fetcher: async () => gate()});
  assert.deepEqual(messages, [
    'PASS VGuard: anonymous installer download requires the uncached email sign-in gate.', APK_NOT_RUN,
  ]);
  assert.equal(await readFile(summaryPath, 'utf8'), 'Earlier check.\nVGuard download access: PASS.\n\n' + APK_NOT_RUN + '\n');
  assert.match(APK_NOT_RUN, /checksum, signature, Android installation and network behavior: NOT RUN/);
  assert.doesNotMatch(messages[0], /integrity|signature|installation|network behavior/);
});

test('a failed admission never appends or logs a successful check', async t => {
  const directory = await temporaryDirectory(t);
  const summaryPath = join(directory, 'summary.md');
  const messages = [];
  await writeFile(summaryPath, 'Earlier check.\n');
  await assert.rejects(runVGuardDownloadAccess({summaryPath, log: line => messages.push(line), fetcher: async () => gate({status: 503})}), /unexpected status/);
  assert.deepEqual(messages, []);
  assert.equal(await readFile(summaryPath, 'utf8'), 'Earlier check.\n');
});

async function shellFixture(t) {
  const directory = await temporaryDirectory(t);
  const bin = join(directory, 'bin');
  const runner = join(directory, 'runner');
  const sdk = join(directory, 'sdk');
  const sdkTools = join(sdk, 'build-tools', '35.0.0');
  const helperCalls = join(directory, 'helper-calls');
  const sdkCalls = join(directory, 'sdk-calls');
  await Promise.all([mkdir(bin), mkdir(runner), mkdir(sdkTools, {recursive: true})]);
  // No shell branch in this suite can make a live request. Only the absent-file
  // branch uses node, and its behavior is checked through this local sentinel.
  await writeFile(join(bin, 'node'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$VGUARD_TEST_HELPER_CALLS"\nexit "${VGUARD_TEST_HELPER_EXIT:-0}"\n', {mode: 0o755});
  const sdkStub = '#!/usr/bin/env bash\nprintf "unexpected SDK/archive execution\\n" >> "$VGUARD_TEST_SDK_CALLS"\nexit 99\n';
  for (const path of [join(bin, 'unzip'), join(sdkTools, 'aapt'), join(sdkTools, 'apksigner')]) await writeFile(path, sdkStub, {mode: 0o755});
  await writeFile(join(bin, 'curl'), '#!/usr/bin/env bash\necho "unexpected network attempt" >&2\nexit 98\n', {mode: 0o755});
  const environment = {
    ...process.env, PATH: bin + ':' + process.env.PATH,
    RUNNER_TEMP: runner, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
    GITHUB_STEP_SUMMARY: '', VGUARD_RUN_EMULATOR: 'false', VGUARD_PROBE_BASELINES: 'false',
    VGUARD_TEST_HELPER_CALLS: helperCalls, VGUARD_TEST_SDK_CALLS: sdkCalls,
  };
  return {directory, runner, helperCalls, sdkCalls, run(args = [], overrides = {}) {
    const result = spawnSync('bash', [shellScript, ...args], {
      cwd: directory, env: {...environment, ...overrides}, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  }};
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), {code: 'ENOENT'});
}

test('shell without a local APK runs only the admission helper', async t => {
  const fixture = await shellFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(fixture.helperCalls, 'utf8'), helperScript + '\n');
  await assertMissing(fixture.sdkCalls);
  assert.deepEqual(await readdir(fixture.runner), []);
  assert.doesNotMatch(result.stdout + result.stderr, /APK.*verified|signature verifies|installation.*PASS/);
});

for (const requested of ['VGUARD_RUN_EMULATOR', 'VGUARD_PROBE_BASELINES']) {
  test(`shell reports BLOCKED instead of a successful ${requested} check without an APK`, async t => {
    const fixture = await shellFixture(t);
    const summaryPath = join(fixture.directory, 'summary.md');
    const result = fixture.run([], {[requested]: 'true', GITHUB_STEP_SUMMARY: summaryPath});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BLOCKED VGuard: requested Android checks need an APK file/);
    assert.match(result.stderr, /No device or network test ran/);
    assert.match(await readFile(summaryPath, 'utf8'), /Android\/network checks: \*\*BLOCKED\*\*/);
    assert.match(await readFile(summaryPath, 'utf8'), /No device or network test ran/);
    assert.equal(await readFile(fixture.helperCalls, 'utf8'), helperScript + '\n');
    await assertMissing(fixture.sdkCalls);
    assert.deepEqual(await readdir(fixture.runner), []);
  });
}

test('shell preserves admission-helper failure instead of silently passing', async t => {
  const fixture = await shellFixture(t);
  const result = fixture.run([], {VGUARD_TEST_HELPER_EXIT: '17'});
  assert.equal(result.status, 17);
  await assertMissing(fixture.sdkCalls);
});

for (const [name, content] of [
  ['tampered APK', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(40000, 7)])],
  ['saved sign-in HTML', Buffer.from('<!doctype html><title>Email sign-in required</title>')],
]) {
  test(`shell rejects ${name} before archive/SDK execution and preserves caller data while cleaning its copy`, async t => {
    const fixture = await shellFixture(t);
    const input = join(fixture.directory, 'supplied candidate.apk');
    const sentinel = join(fixture.runner, 'vellivex-vguard-candidate.apk');
    await writeFile(input, content);
    await chmod(input, 0o444);
    await writeFile(sentinel, 'Unrelated existing caller file.');
    const fakeExpected = createHash('sha256').update(content).digest('hex');
    const result = fixture.run([input], {EXPECTED_SHA: fakeExpected, VGUARD_EXPECTED_SHA: fakeExpected, VGUARD_RUN_EMULATOR: 'true'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the published candidate SHA-256/);
    assert.doesNotMatch(result.stdout, /PASS VGuard/);
    assert.deepEqual(await readFile(input), content);
    assert.equal((await lstat(input)).mode & 0o777, 0o444);
    assert.equal(await readFile(sentinel, 'utf8'), 'Unrelated existing caller file.');
    assert.deepEqual(await readdir(fixture.runner), ['vellivex-vguard-candidate.apk']);
    await assertMissing(fixture.sdkCalls);
    await assertMissing(fixture.helperCalls);
  });
}

test('shell rejects a missing local path without falling back to a public download', async t => {
  const fixture = await shellFixture(t);
  const result = fixture.run([join(fixture.directory, 'missing.apk')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /supply a regular local APK file/);
  await assertMissing(fixture.helperCalls);
  await assertMissing(fixture.sdkCalls);
  assert.deepEqual(await readdir(fixture.runner), []);
});

test('shell rejects symlinks and directories without modifying the target', async t => {
  const fixture = await shellFixture(t);
  const target = join(fixture.directory, 'target.apk');
  const link = join(fixture.directory, 'linked.apk');
  await writeFile(target, 'Caller-owned target.');
  await symlink(target, link);
  for (const path of [link, fixture.directory]) {
    const result = fixture.run([path]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /supply a regular local APK file/);
  }
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'Caller-owned target.');
  await assertMissing(fixture.helperCalls);
  await assertMissing(fixture.sdkCalls);
  assert.deepEqual(await readdir(fixture.runner), []);
});

test('shell rejects surplus arguments before invoking any check', async t => {
  const fixture = await shellFixture(t);
  const result = fixture.run(['one.apk', 'two.apk']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  await assertMissing(fixture.helperCalls);
  await assertMissing(fixture.sdkCalls);
  assert.deepEqual(await readdir(fixture.runner), []);
});
