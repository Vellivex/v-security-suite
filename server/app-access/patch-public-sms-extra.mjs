// SPDX-License-Identifier: GPL-3.0-or-later
// One reviewed replacement in the existing gated production Worker.
// Use applyGuardedPatch and preserve-mode packaging; never deploy a generic build.
export const EXTRA_SMS_PROVIDER_FAILURE_PATCH = Object.freeze({
  "module": "index.mjs",
  "baselineSha256": "aec2121a4069fb89aa4d9bf5004ff6718c3882ca61f8f4bd976e4f66c4f5e73a",
  "candidateSha256": "186d90ca3ce8af80c5859b7b856856812c6fc9c2f45d1a7b766be183a772d9c7",
  "replacements": [
    [
      "  function normalizeMessages(source, selected) {\n    if (!object(source) || source.number !== selected.e164 || !Array.isArray(source.messages) || source.messages.length > 1000) throw problem();\n    const messages = [], seen = new Set(); let omittedMessages = 0;",
      "  function normalizeMessages(source, selected) {\n    if (!object(source) || source.number !== selected.e164 || !Array.isArray(source.messages) || source.messages.length > 1000) throw problem();\n    // This provider can return its own fetch-failure notice as a senderless SMS.\n    // Fail the inbox before caching or truncation; it is not a received message.\n    if (source.messages.some(item => object(item) && (item.from === null || item.from === '') &&\n        item.text === 'Failed to fetch data. Please try again.')) throw problem();\n    const messages = [], seen = new Set(); let omittedMessages = 0;"
    ]
  ]
});
export const EXTRA_SMS_FACTORY_SHA256 = 'ee741e50a4b87e19d70901e71edcded5de81b6ca526c5b9f0cf998b8b29d67d9';
