# Resource and release-integrity hardening — 23 October 2026

Site 0.4.0; VVault/VRelay 0.2.6; V Cipher 0.1.6 research. The VGuard 0.1.3 candidate APK and native application are unchanged.

This remains an internal development review. Required physical-device tests and independent review are not complete.

## Reproduced defects and changes

| Boundary | Before | After |
| --- | --- | --- |
| Source archive | An isolated synthetic project published bytes from an external symlink and private `.pem`, `.key`, uppercase `.P12` and `.sqlite` files. No such leak was found in the real checkout. | Exact reviewed path manifest, case-insensitive forbidden types, source-type allowlist, link/containment/regular-file checks, byte bounds and validation before archive creation. Public files are snapshotted before writing deterministic ZIPs. New/unlisted and missing paths fail the build. |
| Assembled APK validation | A temporary modified embedded APK with its checksum regenerated passed the artifact validator despite disagreeing with its published build report. | Actual downloadable bytes must match report SHA-256, byte length and artifact name, as well as the download checksum. Three negative regression cases failed before the fix. |
| Offline setup | The 30-second timer started only after registration/update; a hung browser promise could block the task indefinitely. Thirteen repeated click/lock events started thirteen unfinished installs. | One deadline covers registration, update and worker checks. Per-page busy guard keeps the same sequence to one pending task. Cleanup removes timer/listener; retired completions cannot continue UI work. Native browser jobs cannot be cancelled and may finish after a page timeout. |
| V Cipher replay capacity | An already-full 1,024-entry tracker performed ten Web Crypto operations, including PBKDF2-600,000, before refusing a message it could never publish. | Early full-capacity rejection performs no cryptographic work. The final guard still handles concurrent last-slot opens. This is resource hardening, not a cryptographic authentication fix. |
| VGuard release evidence | Historical metadata and embedded checksum checks did not routinely revalidate native source inputs or distinguish absent APKs from actual signature checks. | Read-only verifier checks exact native input fingerprints, manifest policy, metadata consistency, signing-identity pin and available APK bytes. Build requires the APK; public-source CI explicitly reports source-only scope. Fresh SDK signature, alignment and compiled-manifest checks passed separately. |

## Native evidence

The existing APK freshly passed official `apksigner`, `zipalign` and `aapt2` checks. All 14 native application inputs match their committed fingerprints; the APK is 90,718 bytes with SHA-256 `6977d17d356f76a181a4979bf4fefa4f486167b90e2df612e5c93aed4977df58`. Its signing-certificate SHA-256 remains `7bdb5a95a45f735a175580a937eb5c7ec55a2c886ce038ed106c1dfa1f3ff049`. A synthetic modified APK with coherently changed hash metadata failed fresh signature verification. See `docs/VGUARD-RELEASE-VERIFICATION-2026-10-23.md`.

## Scope and limits

The source allowlist prevents accidental file inclusion; it cannot establish that approved text contains no secrets. Source/manifest changes still require content review. Hash/fingerprint agreement and a valid APK signature do not prove reproducible-build provenance. Source-only CI cannot freshly check a binary it does not contain. Offline timeouts bound the page task, not the browser's native background job or work in other tabs. Replay detection still lasts only the unlocked session and V Cipher still lacks forward secrecy.

Actual Android enforcement, browser/OS behavior, physical two-phone camera use, device isolation and independent review remain open. No real-device or browser-preview result is claimed for this pass. Acceptance status remains testing-only.

## Verification

All 166 Node tests passed, including the new packaging, artifact-binding, native release-policy, offline-deadline and full-replay regressions. Fresh SDK verification and independent Python/Web Crypto AES-GCM/PBKDF2 interoperability passed. The assembled Worker route/header/download/offline-digest validator passed after the final build. GitHub CI and native publication are separate completion receipts; no phone behavior is inferred from them.
