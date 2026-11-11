import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MAIL_BASELINE_SHA256 = 'b79c65af647fb96987c91a49e85f8673c73aa8a9c3577304aa8efb5f6dd9d90a';
export const MAIL_PATCH_REPLACEMENTS = [['mt=new Set(["https://www.vellivex.com","https://vellivex-site-migration.vellivex-call.workers.dev"])', 'mt=new Set(["https://www.vellivex.com","https://vellivex.com","https://vellivex-site-migration.vellivex-call.workers.dev"])']];
const digest = source => createHash('sha256').update(source).digest('hex');

// The original verifies Turnstile against the actual Origin hostname. Add the
// apex site explicitly instead of rewriting its Origin and invalidating tokens.
export function patchMailApexOrigin(source) {
  if (digest(source) !== MAIL_BASELINE_SHA256) throw new Error('Mail bundle differs from the audited baseline. Review before patching.');
  const [[before, after]] = MAIL_PATCH_REPLACEMENTS;
  if (source.split(before).length !== 2) throw new Error('Mail origin anchor is missing or ambiguous.');
  return source.replace(before, after);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) throw new Error('Usage: node patch-mail.mjs BASELINE_FILE CANDIDATE_FILE');
  const candidate = patchMailApexOrigin(await readFile(input, 'utf8'));
  await writeFile(output, candidate, { flag: 'wx' });
  console.log(JSON.stringify({ baselineSha256: MAIL_BASELINE_SHA256, candidateSha256: digest(candidate) }));
}
