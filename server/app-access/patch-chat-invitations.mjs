// SPDX-License-Identifier: GPL-3.0-or-later
// Treat only the access gate's reserved empty-fragment marker as no invitation.
// Patch exact reviewed clients; retain real invitation parsing and transport.
import {createHash} from 'node:crypto';

export const CHAT_INVITATION_BASELINES = Object.freeze({
  vkey: Object.freeze({path: '/app.js', sha256: '1686fe2763c53a618cbe5c7c89b83c64e3efa683379c87e546260f0ebdf7ec49', anchor: 'if(location.hash){', replacement: "if(location.hash==='#_'){history.replaceState(null,'',location.pathname+location.search);}\nelse if(location.hash){"}),
  private: Object.freeze({path: '/live/ui/live-ui.mjs', sha256: '5ea9a68ba8877c726e41cc10cf69872a7a74a2bb70d5aebd66276de0945f1761', anchor: 'if(window.location.hash){', replacement: "if(window.location.hash==='#_'){window.history.replaceState(null,'',window.location.pathname+window.location.search);}\n  else if(window.location.hash){"}),
});

export function createChatInvitationOverride(family, source) {
  const baseline = Object.hasOwn(CHAT_INVITATION_BASELINES, family) ? CHAT_INVITATION_BASELINES[family] : null;
  if (!baseline || typeof source !== 'string' || createHash('sha256').update(source).digest('hex') !== baseline.sha256 ||
      source.split(baseline.anchor).length !== 2) {
    throw new Error('Chat invitation client differs from the audited live baseline. Review before patching.');
  }
  return Object.freeze({[baseline.path]: Object.freeze({body: source.replace(baseline.anchor, baseline.replacement), type: 'text/javascript; charset=utf-8'})});
}

export const CALL_INVITATION_BASELINE = Object.freeze({
  module: 'accounts-core.mjs',
  moduleSha256: 'e8baac457c4f0f04b4d8bab006a9cfb0bbe47dd9610bf71d6ec64f1e8e17b88e',
  clientFixtureSha256: '87c4d6e14316fae402688b938d86e25365fb80cb5973884a727f4313dc0dc2c7',
  anchor: '  if (location.hash) {\n    const fragment = location.hash;',
  replacement: '  if (location.hash === "#_") {\n    history.replaceState(null, "", location.pathname + location.search);\n  } else if (location.hash) {\n    const fragment = location.hash;',
});
function patchCall(source, expectedHash) {
  const {anchor, replacement} = CALL_INVITATION_BASELINE;
  if (typeof source !== 'string' || createHash('sha256').update(source).digest('hex') !== expectedHash ||
      source.split(anchor).length !== 2) {
    throw new Error('Call invitation source differs from the audited live baseline. Review before patching.');
  }
  return source.replace(anchor, replacement);
}
// The UI is embedded in a template literal. This anchor introduces no template
// escapes; the surrounding bundle and every other runtime byte remain intact.
export const patchCallInvitationModule = source => patchCall(source, CALL_INVITATION_BASELINE.moduleSha256);
export const patchCallInvitationFixture = source => patchCall(source, CALL_INVITATION_BASELINE.clientFixtureSha256);
