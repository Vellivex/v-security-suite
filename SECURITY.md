# Security and responsible reporting

This is experimental evaluation software with no independent security audit.

Do not post exploitable vulnerabilities or real secrets in public GitHub Issues. Use the beta website's `/security` private form. The form accepts non-sensitive reproduction text and does not collect contact details; no guaranteed response time or emergency monitoring is offered.

## Threat and capability boundaries

- VGuard filters selected Android app network traffic through a local VPN interface. It is not a microphone/camera controller, spyware scanner or external-tracker jammer. Blocking can stop with the VPN/process. Live Android routing, lifecycle and battery behaviour remain unverified.
- VVault encrypts text with a shared passphrase. It uses Web Crypto AES-256-GCM with a 128-bit tag, random 96-bit IV, random 128-bit salt and PBKDF2-HMAC-SHA256 with 600,000 iterations. Version and algorithm metadata are fixed and checked. A lost passphrase cannot be recovered. There is no sender authentication or forward secrecy.
- A compromised device, browser extension, malicious online code update, weak passphrase, screen capture or clipboard exposure can defeat the intended protections. JavaScript cannot guarantee secure memory erasure.
- VRelay checks structure only. It does not establish authenticity, deliver a message, hide metadata or decrypt content. Use a separate channel for the passphrase.
- The optional website feedback endpoint stores product, category, OS, text, timestamp and a hashed network abuse-control key. It exposes no public read API. Infrastructure access and logs remain within hosting's responsibility.

Only test systems and devices you control or have explicit permission to assess. Keep tests bounded and use synthetic data. Do not access other people's records or disrupt services.

## Hardening release

VGuard 0.1.2-candidate fixes two reproduced startup races and adds screen/backup privacy controls. The rebuilt APK's signature was verified with the original certificate. Actual Android routing remains unverified. VVault/VRelay 0.2.0 clear sessions automatically, invalidate stale asynchronous work and pin installed offline assets. Their pages block app-initiated network connections. A compromised origin can still serve changed code, and JavaScript cannot guarantee memory or clipboard erasure. See `docs/SECURITY-HARDENING-2026-10-23.md` for evidence and remaining gates.

## Adversarial follow-up

VGuard 0.1.3-candidate restricts export destinations; browser tools 0.2.2 harden Unicode, concurrent crypto and offline cache isolation. Website feedback and redirect attack cases are fixed and regression-tested. See [the detailed review](docs/ADVERSARIAL-REVIEW-2026-10-23.md) for current evidence and limits; the earlier hardening section is historical. No independent audit or phone-runtime validation is claimed.

Browser 0.2.3 also checks cached response bodies on every offline read. Missing or corrupted files fail closed. This does not protect a compromised origin or guarantee browser-storage security.

## V Cipher recovered QR project

V Cipher 0.1 research is now a fourth experimental product: signed recipient encryption, an independently required inner conversation secret, encrypted identity backups with public/private binding, and bounded multi-frame QR. Its Vault browser gate cannot prove physical isolation. Replay records last one unlocked session. It has no forward secrecy, ratchet, delivery backend or independent audit. Real camera/two-device tests remain unverified. See `apps/cipher/README.md` and `docs/CIPHER-CONTINUATION-2026-10-23.md`.

V Cipher 0.1.1 adds recipient-side plaintext limits, strict identity-field validation, collector reset cancellation, camera shutdown on operation switches and transactional session replay updates. See `docs/CIPHER-ATTACK-REVIEW-2026-10-23.md` for reproduced findings and limits.

## Launch-confidence hardening — site 0.3.9

VVault/VRelay 0.2.5 and V Cipher 0.1.5 request disabled spelling, correction, writing suggestions, autofill and translation on sensitive text. These are browser hints, not protection against extensions, cloud keyboards or a compromised device. V Cipher now commits new identities only after requesting their backup download and rechecking the session. The feedback form has a whole-exchange deadline and preserves uncertain retries. See `docs/LAUNCH-CONFIDENCE-REVIEW-2026-10-23.md` for reproduced cases and the remaining launch blockers. No real-phone or independent review pass is claimed.

## Resource and release-integrity hardening — site 0.4.0

Offline installation has one 30-second page-task deadline covering registration, update and worker checks. Repeated requests from the same pending page task are refused. The browser may still complete native work after a timeout; this is not cross-tab cancellation. V Cipher refuses an already-full replay tracker before performing expensive cryptography, retaining its final concurrent-capacity guard.

Public source archives require an exact reviewed path manifest, reject links and private/runtime file types, and validate inputs before writing archives. Downloaded VGuard bytes must match both their checksum and build report. Native release checks bind current source fingerprints and policy to metadata; fresh official SDK checks verify the unchanged APK signature and compiled manifest. No real-device or reproducible-build completion is implied. See `docs/RESOURCE-AND-RELEASE-HARDENING-2026-10-23.md`.

## Additional attack pass — site 0.4.1

VVault/VRelay 0.2.7 keep unsupported-browser cryptography disabled across session/UI transitions and clean failed download object URLs. V Cipher 0.1.7 coalesces repeated QR completion verification, retains failure until reset, rejects backward collection clocks and cleans failed download URLs. Feedback HMAC-provider errors fail closed with a generic isolated 503. See `docs/ATTACK-PASS-2026-10-23.md` for reproductions, native/campaign/browser evidence and remaining limits.

## Key and delivery hardening — site 0.5.0

V Cipher 0.1.8 restores/activates non-extractable private session keys after compatible encrypted-backup creation. Raw session-key re-export is refused; retain the original backup. This reduces accidental export, not compromised-code oracle use or memory exposure. VVault/VRelay 0.2.8 and Cipher offline delivery verify body bytes and reconstruct release-pinned headers, preventing altered cache metadata from relaxing their policy. New QR dependency checks bind generated runtime bytes to retained upstream source and local transforms.

The unchanged VGuard 0.1.3 APK's eight payload entries were reproduced by a clean unsigned compilation from public source, with fresh signature verification of the official APK. This is payload/toolchain evidence, not signed-container byte identity or real-phone enforcement. See `docs/KEY-AND-DELIVERY-HARDENING-2026-10-23.md` and `docs/VGUARD-PAYLOAD-REBUILD-2026-10-23.md`.
