# Security hardening — 23 October 2026

This is a code-hardening and test-evidence report, not an independent audit or a claim of being the world's most secure product.

## Delivered changes

### VGuard 0.1.2 candidate

- Fixed a reproducible configuration/revocation race. A revocation inside `Builder.establish()` previously allowed a later ACTIVE publication. An epoch invalidates in-flight work, and owner/epoch validation plus token/session publication now occur under one lock. Rejected descriptors close.
- Fixed a reproducible UID/shared-group configuration race that could block an unselected sibling. Package events are tracked before the first session exists, complete identities are revalidated before and after establishment, and changed/incomplete identity mappings reject the configuration.
- Added `FLAG_SECURE` and explicit Android 12+ cloud/device-transfer exclusions. These policies still require device verification; they do not protect against every way of observing a phone.
- Bumped versionCode to 3 / 0.1.2-candidate. Compiled resources and production Java with official Android platform 36/build-tools 36.0.0, packaged DEX, aligned and verified APK signatures. The original update certificate matches.
- Official candidate build refuses accidental update-key regeneration, checks the expected certificate, applies a private umask and records the native source fingerprint.
- Matching source for the historical 0.1.1 APK is retained separately. The website now distributes the rebuilt candidate.

### VVault / VRelay 0.2.0 browser beta

- Clear sensitive form state on tab hiding, page exit, back/forward cache restoration and two minutes without input.
- Successful encryption clears the original plaintext draft. Passphrases clear after operations, including errors.
- Explicitly invalidated async operations cannot repopulate cleared sessions or overwrite newly edited inputs. File import, clipboard and share completion follow the same generation boundary.
- Imported files clear the previous transfer before validation; stale or oversized input cannot accidentally share an older package.
- Crypto pages apply CSP `connect-src 'none'` and `form-action 'none'`. No message/passphrase upload feature exists.
- Offline installation pins exact release hashes, rejects redirects and partial installation, separates cache versions and returns an error for missing installed assets instead of silently fetching replacement network code. These checks protect against mixed/corrupt delivery; a compromised delivery origin can also replace the worker and its declared hashes.
- Envelope validation now rejects noncanonical base64 and invalid encryption passphrase types. AES-GCM/PBKDF2 settings and compatibility remain unchanged.

### Website and release process

- Feedback abuse-control pseudonyms use HMAC-SHA256 with a private runtime key rather than a publicly enumerable IP hash. Missing runtime security configuration fails honestly.
- Added transport/isolation headers, retained bound SQL, bounded request reads, origin checks and private-only report access.
- Source archives exclude build output, signing keys, password files and environment files. Published APK checksum, certificate and source fingerprint match the candidate report.
- Added a minimal public-repository regression workflow with no repository-token permissions or persistent Git credentials. Its observed GitHub run status is separate from locally passed checks.

## Executed evidence

- 21 web/server/session/offline tests passed, including actual production event handlers with deferred crypto/file/copy completions.
- Independent Python `cryptography` AES-GCM/PBKDF2 decrypted a Web Crypto envelope, and Web Crypto decrypted an independently produced Python envelope. Synthetic Unicode messages only. This is interoperability testing, not cryptographic certification.
- 20,132 native parser/rule assertions passed.
- Existing native adversarial harness: 18 scenarios / 2,192 assertions, zero failures, plus the targeted revocation and two package-identity timing regressions.
- 321 CSV encoder cases passed using Python's independent CSV parser.
- Full native APK build, alignment, manifest/permission and signature verification passed. Candidate SHA-256: `817a990e143be19d3d377427fd5f09750fbed1ae05663ab9acc0f4898e4bb636`.
- Assembled offline asset hashes, download routes and public archive exclusion checks passed locally.

## Limits and next gates

The rebuilt APK has not run on an actual Android device. Real networking enforcement, IPv6/DNS/bypass, lifecycle, upgrades and battery testing are outstanding. Physical Android/iPhone browser tests, offline reload, OS share/file workflows and independent expert review remain outstanding. Browser JavaScript cannot guarantee secure memory/clipboard erasure. Passphrase encryption provides no sender identity, forward secrecy or recovery. VGuard remains selective and has no always-on/lockdown/automatic restart; a stopped VPN/process can end blocking.

No external testers, independent auditor, payment system or app-store acceptance is claimed. Paid/wider launch remains gated by these findings and actual device evidence.
