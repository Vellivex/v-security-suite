// SPDX-License-Identifier: GPL-3.0-or-later
// Produce one response override from an exact audited live asset module.
// The original module and every other embedded asset remain untouched.
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {CHAT_INVITATION_BASELINES, createChatInvitationOverride} from './patch-chat-invitations.mjs';

export const CHAT_ASSET_BASELINES = Object.freeze({
  vkey: '7ec5d53419278b1223f33b45551c0c1c6bf2f38641b326b3dc54bbf9f9de7482',
  private: '52b344b92d92735d0fbb9f09a8f94a8c05f47806745f15272b4f781594f1e7c0',
});
export const CHAT_SESSION_BASELINE_SHA256 = 'c4316f002e64a249f818e444b96aa44620424f054edb35312ef8211f14debe8d';
const digest = source => createHash('sha256').update(source).digest('hex');
const CLIENT_PATH = '/public-session.mjs';

export function createChatSessionOverride(source) {
  if (typeof source !== 'string' || digest(source) !== CHAT_SESSION_BASELINE_SHA256) {
    throw new Error('Chat session differs from the audited live client. Review before patching.');
  }
  const before = "credentials:'omit'", after = "credentials:'same-origin'";
  if (source.split(before).length !== 3 || source.includes(after)) {
    throw new Error('Chat session credential anchors differ from the audited client.');
  }
  return Object.freeze({[CLIENT_PATH]: Object.freeze({body: source.replaceAll(before, after), type: 'text/javascript; charset=utf-8'})});
}

export function createChatOverrides(family, source) {
  if (!Object.hasOwn(CHAT_ASSET_BASELINES, family) || typeof source !== 'string' || digest(source) !== CHAT_ASSET_BASELINES[family]) {
    throw new Error('Chat assets differ from the audited live baseline. Review before patching.');
  }
  // Parse data only. Never import/evaluate source received from a deployment.
  const match = /^export default (\{[\s\S]*\});\s*$/.exec(source);
  if (!match) throw new Error('Chat asset module is not the audited JSON export shape.');
  const assets = JSON.parse(match[1]), client = assets[CLIENT_PATH];
  if (!client || Object.keys(client).sort().join(',') !== 'body,type' ||
      typeof client.body !== 'string' || client.type !== 'text/javascript; charset=utf-8') {
    throw new Error('Chat session asset is missing or has unexpected metadata.');
  }
  const invitation = assets[CHAT_INVITATION_BASELINES[family].path];
  if (!invitation || Object.keys(invitation).sort().join(',') !== 'body,type' ||
      typeof invitation.body !== 'string' || invitation.type !== 'text/javascript; charset=utf-8') {
    throw new Error('Chat invitation asset is missing or has unexpected metadata.');
  }
  return Object.freeze({...createChatSessionOverride(client.body), ...createChatInvitationOverride(family, invitation.body)});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [family, input, output] = process.argv.slice(2);
  if (!family || !input || !output || input === output) throw new Error('Usage: node patch-chat.mjs FAMILY LIVE_MODULE OVERRIDE_MODULE');
  const overrides = createChatOverrides(family, await readFile(input, 'utf8'));
  const candidate = 'export default ' + JSON.stringify(overrides) + ';\n';
  await writeFile(output, candidate, {flag: 'wx'});
  console.log(JSON.stringify({family, baselineSha256: CHAT_ASSET_BASELINES[family], overrideSha256: digest(candidate), clientSha256: digest(overrides[CLIENT_PATH].body)}));
}
