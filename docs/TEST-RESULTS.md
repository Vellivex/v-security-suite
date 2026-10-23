# Test results — 23 October 2026

## Rerun successfully in this session

- VGuard core parser/rule suite: 20,132 assertions against host JVM production code.
- VGuard adversarial engine harness: 18 scenarios, 2,192 assertions, zero failures. Uses controlled Android framework stubs.
- VGuard UI/CSV encoder checks: 321 cases, including 66 formula-leading cases, parsed by Python's independent CSV implementation.
- New browser crypto and website/server tests: 9 meaningful automated tests, all passed. Unicode/multiline round trip, random envelopes, incorrect passphrase, modified ciphertext/nonce/salt, malformed format, fixed KDF metadata, size limits, page routes, security headers, cross-origin rejection, form validation, bound SQL, rate limits and honest storage failure.
- Recovered original APK ZIP integrity and SHA-256 match checked; no new native rebuild or fresh APK signature verification.

## Not established by those checks

Actual Android blocking, lifecycle, performance and battery behaviour. Browser behaviour on physical phones. Independent security review. Reproducible builds. Store acceptance. Customer feedback. No such result may be inferred from host tests.

Live website UI, downloads, encryption and feedback storage results are recorded separately once executed.

## Live browser observations — 23 October 2026

- Deployed homepage, VVault, VRelay and feedback UI opened in the connected Chrome browser.
- VVault encrypted a synthetic Unicode test message; wrong passphrase was rejected; the correct passphrase restored the exact message.
- VRelay accepted that same encrypted envelope and preserved it byte-for-byte in its transfer field; saving became enabled. Native sharing/delivery and physical phone file import were not exercised.
- The feedback form submitted a clearly labelled synthetic test report. The success reference matched an independently read private D1 row: `fe6e7831-f039-4ec9-b037-be7b7788e2d2`. This is test evidence, not customer feedback.
- Public source repository and GPL licence availability verified with GitHub connector.
- Assembled Worker: 25 local route/asset/download responses plus homepage internal links checked successfully.
- Direct unauthenticated HTTP from the execution environment returned HTTP 403 before asset checks; anonymous external access has not been independently confirmed from that environment.
- Browser automation intermittently returned HTTP 503. The crypto and feedback results above were subsequently observed successfully; no unexecuted checks are counted as passes.

Remaining: real Android/iPhone devices, native Android enforcement, offline reload, PWA install behaviour, downloaded file integrity through the live browser, sharing/delivery, independent review and genuine external tester feedback.

Responsive UI: homepage tested with a 390-pixel viewport, with no horizontal overflow; mobile navigation opened successfully. A viewport override is a layout test, not a physical-phone result.

## Subsequent hardening release

See SECURITY-HARDENING-2026-10-23.md for the rebuilt VGuard 0.1.2 candidate, 22 browser/server/session/offline regressions, independent cryptographic interoperability checks and native race fixes. Earlier live browser observations above apply to the prior beta; current-release live observations must be recorded separately.

## Adversarial follow-up — current candidate

Current release: VGuard 0.1.3-candidate and browser tools 0.2.2. See [ADVERSARIAL-REVIEW-2026-10-23.md](ADVERSARIAL-REVIEW-2026-10-23.md) for the current 49-test Node suite, real SQLite concurrency checks, 3,000,400 parser calls over four seeds, 300 lifecycle cycles and export restrictions. Historical observations above do not certify this candidate on a phone.

## Browser 0.2.3 broad follow-up

55 Node tests pass. Cached responses are hash-checked on each read after a reproduced post-install corruption failure. Added 35 authenticated-tampering cases, base64/type boundaries, a 500-request local SQLite concurrency burst, and Origin confusion checks. Exact assembled Worker/download validation is included in `npm run validate`. No new physical-device evidence is claimed.

## Storage and interruption pass — 0.2.3 unchanged

63 Node tests pass, zero failed/skipped. Added six storage/verification fault branches, worker routing/cache-retirement boundaries, crypto rejection with draft preservation, late rejection after lock, failed and out-of-order file reads, and late share failure. No new defect reproduced; no production app change. See the detailed adversarial report for scope.

## V Cipher continuation

79 Node tests pass across the suite, including 16 new Cipher/protocol/UI/route tests. Actual encoder matrices decode with the independent bundled QR decoder; no physical-camera test is claimed. New coverage includes signed double-layer messages, backup card/private-key binding, session replay, mixed/corrupt QR frames, offline key-use gates, late camera permissions and stale file/key completions. Exact assembled offline manifest digests and module dependencies also pass.
