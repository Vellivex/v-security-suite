# Key and delivery hardening — 23 October 2026

Site 0.5.0; VVault/VRelay 0.2.8; V Cipher 0.1.8 research. VGuard's 0.1.3-candidate native application and signed APK are unchanged.

These changes close specific gaps. They do not establish that the apps are impregnable, independently audited or ready for sensitive production use.

## Active private-key export surface

Before this change, V Cipher restored both private identity keys with `extractable=true`; raw JWK export succeeded. Restored keys now import as non-extractable. Fresh identity creation first constructs its encrypted VCVAULT2 backup, then imports owned PKCS8 buffers as non-extractable keys before the UI requests the download or activates the identity. Buffers are wiped in `finally`, including either import failure. A failed hardening operation or a retired session cannot activate the identity or download its backup.

The original backup format and contact fingerprints are unchanged. Hardened/restored keys still sign and decrypt, but JWK and PKCS8 export are refused. `exportIdentity` rejects active/restored sessions before password derivation; keep and verify the original encrypted backup. This deliberately changes the programmatic re-export behavior for restored identities.

Seven new tests cover export refusal, cryptographic interoperability, buffer cleanup, staged failure and a lock while hardening is actually pending. Non-extractability reduces accidental raw-key export. It cannot revoke already-retained key references, stop compromised JavaScript using a key as a signing/decryption oracle, or guarantee browser memory erasure. Freshly generated staging keys necessarily permit backup export before hardening.

## Offline response-policy integrity

A synthetic cache could retain the correct file body/hash but supply relaxed CSP, wrong MIME, permissive camera/microphone policy, unsafe isolation/referrer settings or a Refresh redirect. The old worker returned those mutable cached headers. No actual message disclosure was demonstrated, and ordinary remote visitors cannot arbitrarily write another browser's cache.

The build now derives canonical response headers from the same handler and actual tool/asset routes used for live delivery. The manifest pins those headers alongside each body hash. Installation and every offline read independently verify bytes and reconstruct a fresh response with the pinned headers. Cached/network metadata, including extra redirect, encoding and download headers, is discarded. Incomplete policy metadata fails closed. Every metadata/worker change produces a different release cache identity.

All ten new fault cases failed before the fix; all 31 offline tests now pass. The assembled artifact validator also compares every manifest header map with its canonical route response. A trusted origin/worker remains part of the trust boundary: this does not protect against malicious code deliberately served by a compromised origin.

## Source-to-APK payload evidence

A clean unsigned compilation of copied public VGuard application source reproduced every one of the official APK's eight uncompressed entries exactly: bytecode, compiled manifest, resource table and XML resources. The official APK was freshly signature-verified and hash-pinned. No signing key was accessed, no signing occurred and no official app/APK bytes changed.

The new standalone payload verifier repeats the clean compilation with the existing official SDK/JDK and compares every bounded, canonical ZIP entry. Twelve fixture tests reject changed, missing, injected, duplicate, traversal and oversized entries without requiring an SDK in CI. See `docs/VGUARD-PAYLOAD-REBUILD-2026-10-23.md` for exact digests/toolchain and reproduction instructions. This proves payload reproduction for that candidate/toolchain, not byte-identical signed containers, arbitrary-toolchain reproducibility, independent auditing or real Android enforcement.

## QR dependency verification

The retained encoder TypeScript and decoder upstream bundle match their recorded source hashes. Their generated runtime files also match pinned runtime hashes and an independent recreation of the documented local transform/wrapper. Altering generated runtime code is refused even when its recorded runtime hash is updated. Seven tests cover both source and runtime mutations. The verifier now runs before packaging and in CI. No vendor code changed and no claim of a third-party dependency security audit is made.

## Verification and open gates

All 233 Node tests passed after the code changes. Packaging requires vendor verification, native source/APK consistency and assembled route/header/download/offline-manifest checks. The bounded source-content check found no private-key, AWS-access-key or live-payment-secret markers in the reviewed files; this is not a complete secret audit.

No Android device, USB interface, emulator or KVM facility was available in this workspace. Physical Android routing and lifecycle behavior, phone-browser/OS behavior, physical two-phone QR/camera operation and independent review remain open. V Cipher still lacks forward secrecy and its replay history lasts one unlocked session. More internal tests cannot substitute for these missing results.
