# Additional bounded attack pass — 23 October 2026

Site 0.4.1; VVault/VRelay 0.2.7; V Cipher 0.1.7 research. VGuard 0.1.3-candidate native application and APK unchanged. Internal testing only; this is not an independent audit.

## Reproduced and fixed

| Area | Reproduction | Fix and scope |
| --- | --- | --- |
| Unsupported browser | VVault's initial disabled control could become enabled again on input/lock; direct submission invoked a mocked crypto operation despite unavailable Web Crypto. No plaintext fallback was found. | Capability checks cover randomness and the required cryptographic methods; submission remains disabled across edits, locks, mode changes and completion, with a handler guard. Session clearing remains available. VRelay structure checks do not require Web Crypto. |
| Failed downloads | Object URLs for validated encrypted packages/public transfers or encrypted Cipher backups were not revoked if element setup, clicking or timer scheduling threw. Five Cipher failure cases and equivalent Vault/Relay cases failed before correction. | Revoke on a failed request path, retain delayed cleanup on success and preserve the original error if cleanup also fails. These blobs contain ciphertext/public data, not a demonstrated plaintext leak. |
| Repeated QR completion | 64 concurrent and 64 repeated final-frame calls repeated public-card verification: 256 digests and 256 key imports. Repeated bad complete transfers also repeated digest work. | One verification promise/result, including failure, per collection until reset; conflicting frames and other transfers still refused. The same valid campaign now uses two digests and two imports total in the collector. Current UI already serializes scanner callbacks: this strengthens the library boundary. |
| QR lifetime | A backward wall-clock jump could extend collection life; successful completion could be revisited under an earlier time. | Reject non-finite times; reset/refuse backward accepted-frame times or elapsed collection deadlines. Cache success does not waive expiry. Browser time remains a local indicator. |
| Feedback provider failure | HMAC import/sign exceptions escaped the handler's error boundary. Public disclosure of the provider error was not established. | Generic 503 with normal isolation/no-store headers, no database call, no raw error and no fallback to a raw network identifier or skipped abuse limit. Both new cases failed before the fix. |

## Fresh native evidence

The production Java host harness passed 3,000,400 parser calls, 18 service scenarios / 2,192 assertions, 14 export checks, 300 concurrent lifecycle cycles with 400 descriptors closed exactly once and 20,132 core assertions. The separate CSV parser passed 321 cases including 66 formula-leading neutralizations. A temporary additional harness passed 22 hostile-profile/action assertions without broadening or mixing selected app scope. Fresh official SDK signature, certificate, alignment, compiled-manifest, APK-hash and 14 source-input checks passed. These are host/packaging checks, not real Android IPC/kernel routing evidence.

## Website campaigns

189 malformed-path/method combinations produced no routing bypass, external redirect, reflection or unexpected throw. A bounded 2,000-case seeded mutation campaign against real in-memory SQLite returned 1,863 validation refusals, ten valid accepted variants and 127 quota refusals; exactly ten rows were present. No live production load or real customer data was used.

## Desktop browser checks

The deployed VVault/VRelay 0.2.6 build was exercised in connected desktop Chrome during the review. A synthetic Unicode/newline message containing HTML-like text encrypted and decrypted exactly. Wrong passphrase and modified ciphertext returned no plaintext; clearing emptied the result. VRelay accepted a structurally valid package and explicitly described the authenticity limit; malformed input cleared the ready package and disabled sharing. The browser initially retained an older installed offline version; navigating outside the tool scope and reopening loaded the current installed release. This is not physical-phone or physically offline-network evidence.

## Release verification and limits

All 197 Node tests passed after the app fixes. The final assembled Worker and offline/download hash checks are required before packaging; native publication and GitHub CI have separate completion receipts. Actual Android networking/lifecycle enforcement, physical two-phone QR/camera behavior, browser/OS sharing and independent review remain open. No cryptographic authentication bypass was reproduced; passing this campaign does not establish immunity to other attacks.
