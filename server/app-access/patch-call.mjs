// Apply only to the audited current account bundle. Never rebuild old assets.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const CALL_BASELINE_SHA256 = '3db8bb8e16aa32045742df169c234e52b2b201072b7db60285354882075583b6';
export const sha256 = source => createHash('sha256').update(source).digest('hex');

export const CALL_PATCH_REPLACEMENTS = [
    ['import { assets as telephoneAssets } from "./composition/assets.mjs";',
     'import { assets as telephoneAssets } from "./composition/assets.mjs";\nimport { appCallScope, validateAppCallScope } from "./app-access/core.mjs";\nimport { resolveFreeCallScope, readCallScope, sameCallScope, callScopeKey } from "./app-access/call-scope.mjs";'],
    ['const scope = await accountsFactory(env).callScope(readSession(request));',
     'const scope = await resolveFreeCallScope(request, env, () => accountsFactory(env).callScope(readSession(request)), appCallScope, denied);'],
    ['const scope = await accounts.callScope(readSession(request));',
     'const scope = await resolveFreeCallScope(request, env, () => accounts.callScope(readSession(request)), appCallScope, denied);'],
    ['var same = (a, b) => a?.id === b?.id && a?.session === b?.session && a?.epoch === b?.epoch;',
     'var same = sameCallScope;'],
    [`  scope(request) {
    let scope;
    try {
      scope = JSON.parse(request.headers.get("X-Vellivex-Scope"));
    } catch {
      throw denied();
    }
    if (!scope || !validToken(scope.id) || !validToken(scope.session) || !Number.isSafeInteger(scope.epoch) || scope.epoch < 1) throw denied();
    return { id: scope.id, session: scope.session, epoch: scope.epoch };
  }`, `  scope(request) {
    return readCallScope(request, denied);
  }`],
    ['  async validScope(scope) {\n    const result = await this.env.ACCOUNTS_DB.prepare(`SELECT 1 AS ok FROM vx_sessions',
     '  async validScope(scope) {\n    if (scope.appAccess === true) return validateAppCallScope(this.env, scope, this.now());\n    const result = await this.env.ACCOUNTS_DB.prepare(`SELECT 1 AS ok FROM vx_sessions'],
    ['if (s) scopes.set(s.session, s);', 'if (s) scopes.set(callScopeKey(s), s);'],
    ['results.get(room[role].scope.session) !== true', 'results.get(callScopeKey(room[role].scope)) !== true']
 ];

export function patchCallBundle(source) {
  if (sha256(source) !== CALL_BASELINE_SHA256) throw new Error('Account bundle differs from the audited baseline. Review before patching.');
  for (const [before, after] of CALL_PATCH_REPLACEMENTS) {
    if (source.split(before).length !== 2) throw new Error('Account integration anchor is missing or ambiguous.');
    source = source.replace(before, after);
  }
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) throw new Error('Usage: node patch-call.mjs BASELINE_FILE CANDIDATE_FILE');
  const candidate = patchCallBundle(await readFile(input, 'utf8'));
  await writeFile(output, candidate, { flag: 'wx' });
  console.log(JSON.stringify({ baselineSha256: CALL_BASELINE_SHA256, candidateSha256: sha256(candidate) }));
}
