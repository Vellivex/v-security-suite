# V Cipher adversarial follow-up — 23 October 2026

Scope: V Cipher research 0.1 → 0.1.1, site/source 0.3.1. Internal source review and local synthetic fault/attack tests. Not an independent audit or physical phone test.

## Reproduced findings and fixes

| Finding | Evidence before fix | Change |
| --- | --- | --- |
| Relay structural validation accepted non-text sender/recipient fingerprints | `inspectMessage` accepted null/number/object/array/boolean fields because its fingerprint helper returned false without throwing. Recipient identity comparison still refused these packages; no sender-authentication bypass was demonstrated. | Require canonical 32-byte base64 strings and exact message ID length before handling a package. |
| Receiver did not enforce the advertised plaintext bound | A correctly signed package containing a 2,500-byte inner message decrypted even though the sender UI limit was 2,048 bytes. | Recipient checks UTF-8 byte length and nonempty plaintext independently after authenticated decryption, before display/replay commit. Sender rejects excessive code-unit length before allocating encoded bytes. |
| Invalidated camera could remain active | Switching from camera scanning to another operation invalidated its token but left its tracks running and loop discarding results. | Stop camera and clear scan canvas before changing operations. Regression asserts tracks close and video source clears. |
| QR reset did not retire asynchronous collector verification | Resetting between final-frame submission and hash completion still let Collector.add return the old transfer. UI session guards already suppressed publication. | Collector epoch checked after each asynchronous verification stage; reset rejects retired completions itself. |
| Old outgoing QR remained after receiving a new transfer | Incoming collection completed and replaced the package text while the earlier displayed QR stayed visible. | Clear outgoing QR/text/canvas before publishing the newly received transfer. |
| Retired decryption consumed replay state for undisplayed text | Editing during pending decryption suppressed the plaintext but the old operation still mutated the shared replay set; retry then incorrectly looked replayed. | Decrypt into a private trial replay set; commit it only if the operation is current and its plaintext will be published. |

Other hardening: primitive transfer objects are refused explicitly; scanner pixel inputs require a typed byte array. Existing exact QR-frame syntax checks already rejected trailing newlines and were retained.

## Expanded verification

- 10,000 seeded hostile QR strings rejected without populating a transfer.
- 30 mixed-transfer/conflicting-frame/reset/reordered-valid campaigns complete only the intended package.
- Actual QR matrices decode when rotated, inverted and combined; 100 seeded camera-noise images produce no QR result. These are synthetic pixels, not camera photographs.
- Malformed public key material, weak/wrong algorithms, unexpected private fields, wrong EC curves and key usages rejected.
- Correctly signed malformed inner JSON/UTF-8 rejected; failed decryption does not consume a replay ID.
- Prior wrong-secret, wrong-recipient, tamper, backup binding, simultaneous replay, frame corruption, offline gates and lifecycle tests remain in the suite.

Final suite: 91 Node tests, zero failed/skipped. Tests intentionally reproduced failures before the changes above and pass after fixes. Exact assembled Worker/module routes, offline digests, release download checksums and isolation headers are validated separately by `npm run validate`.

Remaining gates: physical two-device scanning, mobile camera permission/background behavior, reliable offline deployment on target phones, performance/battery, independent protocol/security review. Replay tracking remains session-only; no ratchet, forward secrecy or delivery backend is added by this fix. Browser offline indicators are not proof of physical isolation, and memory erasure is not guaranteed.


## Second follow-up: camera concurrency (0.1.2 / source 0.3.2)

Four additional UI failures were reproduced with deferred operations before fixing them:

| Finding | Reproduction | Fix |
| --- | --- | --- |
| Camera could overlap cryptographic work | Start camera while identity generation is pending; camera permission is requested and could later feed input into the same session. | Refuse camera start while a cryptographic/UI task is busy. |
| Older transfer file could populate a newer scan session | Start a file read, start the camera, then complete the file read; old package is published. | Starting a scan advances the session generation, retiring older file reads. |
| Stop did not retire pending QR verification | Decode a frame, pause collection verification, stop camera, then complete verification; old transfer and status appear after Stop. | Stop advances the session generation before closing tracks; pending results cannot publish. |
| Selecting a backup left invalidated camera tracks active | Start camera on Vault, then select a backup. Tracks remain live despite the changed session. | Backup selection stops camera and clears its video/canvas state. |

All four regression tests failed before these changes and passed afterward. Additional deferred-completion matrices cover seven decryption cancellation boundaries (lock, hidden tab, page close, reconnection, isolation removal, backup selection and camera stop) and three backup-unlock cancellation boundaries. The complete suite now has 97 Node tests; physical camera/device validation and an independent audit remain outstanding. No cryptographic authentication bypass was demonstrated in this follow-up.


## Third follow-up: trust withdrawal and malicious interiors (0.1.3 / source 0.3.3)

Three additional failures reproduced before fixes:

- Withdrawing the contact fingerprint confirmation while decryption was pending did not retire that operation, so plaintext could still appear. Withdrawal now locks the session, drops the identity, stops scanning and clears sensitive fields and QR output. This is a user trust-withdrawal failure, not a cryptographic signature bypass.
- Editing the manual pasted-frame input during pending QR verification did not retire the older transfer. It now participates in input invalidation, suppressing the older completion and clearing previously displayed output.

- A correctly encrypted/authenticated backup with RSA `d` replaced by `AA` still restored on the tested provider, which relied on valid redundant CRT fields. This was not a backup encryption or identity authentication bypass: it required construction of a backup with its passphrase and matching private CRT parameters. Import now requires exact private JWK fields, key purposes, canonical bounded integers and consistent RSA modulus/exponent/CRT relationships, plus the existing actual encryption/signature identity challenges. Valid generated backups still restore.

Expanded attack campaigns pass: seventeen malformed but correctly encrypted/authenticated backup interiors (including duplicate private-key members, invalid UTF-8, wrong keys, invalid private key material and unsupported curves); 160 seeded binary mutations across IV, wrapped key, ciphertext and signature plus each signed address/ID field, all rejected without consuming replay state; excessive JSON nesting up to 1,998 levels and escaped duplicate public-card members; primitive/prototype-shaped transfer inputs rejected. These use synthetic identities and messages only.

Complete suite: 102 Node tests. Both new UI regressions and the malformed RSA backup regression failed before the fixes and pass afterward. Build and assembled artifact validation cover offline asset integrity and headers. Real two-phone camera testing, mobile lifecycle testing and independent cryptographic review remain outstanding.
