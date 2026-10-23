# Sequential security review — 23 October 2026

Order: VGuard, VVault, VRelay, V Cipher, website. Synthetic inputs and local harnesses only; no destructive production load testing.

## Results

- VGuard: host adversarial harness passed 3,000,400 seeded parser calls, 300 lifecycle stress cycles, 20,132 core assertions, 18 service scenarios / 2,192 assertions, 14 export destination checks and 321 independent CSV cases. Existing APK unchanged.
- VVault: authenticated encryption, malformed envelopes, maximum plaintext, Unicode preservation, session cancellation and independent Python AES-GCM/PBKDF2 interoperability passed.
- VRelay: stale and rejected file reads, out-of-order selections, sharing cancellation and fail-closed offline cache tests passed.
- V Cipher: all 47 crypto, QR, identity, backup, replay and UI attack tests passed. Includes 10,000 hostile QR frames, 256 corrupted transfer campaigns and 512 single-bit signature mutations.
- Website: all 32 routing, headers, feedback UI, SQL binding, strict parser, origin, quota, idempotency and upload-deadline tests passed. The 500-request local SQLite burst accepted only the permitted ten reports.

## Reproduced and fixed

The shared VVault/VRelay offline-install handler could replace a cleared-session status with a delayed installation success or failure. Four new regression cases failed before the fix. The handler now checks the originating session generation before changing its label or status. Two additional positive cases verify an uninterrupted installation still reports completion. No plaintext disclosure or authentication bypass was established. Browser apps become 0.2.4; site release becomes 0.3.8.

## Limits

Host Android tests use framework stubs, not kernel VPN routing or real phones. Camera tests use synthetic QR pixels and mocked lifecycle events, not two physical phones. No independent audit, production load/DDoS test, physical-device acceptance or fresh APK signature verification was performed in this pass. Passing these checks cannot establish that the apps are impregnable or production-ready. V Cipher remains research software with no forward secrecy and session-memory-only replay tracking.
