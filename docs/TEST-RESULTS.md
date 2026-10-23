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
