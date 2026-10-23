# V Cipher recovery and continuation — 23 October 2026

Recovered the actual `private-line-prototype.zip` and its 11 October TEST-REPORT.md. The source's README explicitly said QR rendering/scanning was not implemented. The source contained vault.html, courier.html and a hard-coded developer test. VKey's later live-chat Site is a separate project and was not modified.

The recovered cryptographic architecture is continued as a bounded, modular research build rather than publishing the old inline scripts. Historical source is retained in apps/cipher/recovery as text. New crypto modules and the site use the existing GPL-3.0-or-later project; third-party QR code retains its MIT/Apache-2.0 licensing.

Implemented: offline-role key-use gates, identity generation and encrypted backups, public-card fingerprints, cryptographic private/public backup matching and card authentication, signed recipient encryption with an independently required inner conversation secret, strict size/type/base64/duplicate-field checks, session replay detection, numbered multi-frame QR rendering/reassembly/checksum checks, local camera decoding, encrypted/public file import/export on Relay, camera shutdown and stale asynchronous-result suppression. Added the fourth product beside VGuard/VVault/VRelay on the home/beta product grid.

Verification includes independent identities, Unicode preservation, wrong secret/wrong recipient/unknown sender/tamper rejection, backup restore/card substitution/private-key mismatch, replay and simultaneous duplicate opens, QR corruption/mixed/expired/invalid-frame rejection, generated QR pixels decoded by a separate local decoder, online-operation gates and late key/camera/file race tests. All tests are reproducible in the public source. The assembled Worker validator checks every offline manifest digest and new module route.

Not verified: real two-phone camera transfer, Android/iOS browser behavior while fully isolated, durable replay history, device hardening, mobile performance, independent protocol audit or reproducible signed native packaging. No delivery backend or forward secrecy is implemented. Do not present the historical test report as an independent audit. Do not claim the new build is production secure or physically air-gapped.

The V Cipher pages block app-initiated network connections; only their local camera permission is enabled, without microphone permission. Ordinary VVault/VRelay retain camera denial. Camera images are decoded locally, never uploaded by the app. The website still serves ordinary requests while online.

## Adversarial follow-up

Research build 0.1.1 fixes six reproduced structural/boundary/lifecycle defects. See [CIPHER-ATTACK-REVIEW-2026-10-23.md](CIPHER-ATTACK-REVIEW-2026-10-23.md). The suite now includes 91 passing Node tests, 10,000 malformed QR strings, recipient-side plaintext limits and camera/collector/replay race regressions. Original 79-test counts above describe the initial continuation.

Second follow-up: research 0.1.2 / source 0.3.2 closes four reproduced camera concurrency/cancellation defects. Six new UI regressions include seven plaintext cancellation boundaries and three backup-unlock boundaries. Full suite: 97 tests. See the second-follow-up section of the attack report.

Third follow-up: research 0.1.3 / source 0.3.3 closes contact-confirmation withdrawal and pasted-frame edit races, and rejects inconsistent RSA private-key representations in encrypted backups. Expanded authenticated-backup, signature mutation and parser-depth attack campaigns bring the suite to 102 tests. See the attack report for exact scope and limits.

Fourth follow-up: research 0.1.4 / source 0.3.4 enforces the AES-256 outer key policy at the receiver. Replay saturation/concurrency, 256 corrupt complete QR campaigns and maximum four-byte Unicode boundaries bring the suite to 106 tests. See the attack report for reproduction and limits.

Fifth follow-up: app remains 0.1.4; source/evidence 0.3.5 adds five unauthorized-access regressions (attacker impersonation, public-key substitution, independent factors, 512 signature mutations and backup splicing). No additional bypass reproduced. Full suite: 111 tests. Real-device/cross-engine and independent review gates remain open.
