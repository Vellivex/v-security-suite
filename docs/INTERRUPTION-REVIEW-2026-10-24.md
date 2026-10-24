# Interruption and recovery follow-up — 24 October 2026

Site 0.5.3; V Cipher 0.1.10 research. VVault/VRelay 0.2.10 and the VGuard 0.1.3-candidate APK are unchanged. This was a free local follow-up after the remote testing allowance was exhausted. No new cloud stream, paid upgrade or physical-device result is claimed.

## Reproduced cancellation gaps

Cipher backup unlock captured a password, awaited the selected file's text, then started identity import without rechecking whether the session had been retired during the read. Locking/reconnecting correctly prevented later activation, but could not prevent that additional password/key work from starting. Relay file loading similarly started transfer inspection after a retired read.

Both paths now check the session token immediately after file reading, before starting the additional work, while retaining their later checks before publishing results. Native file reads and WebCrypto work already in progress cannot be aborted by this change. The input format, cryptographic algorithms, limits and offline/isolation gates are unchanged. No key disclosure, authenticated-message forgery or physical-isolation bypass was reproduced.

Three new UI tests use deferred synthetic file reads:

- Backup cancellation across lock, network reconnection, backup replacement, tab hide, page exit, history restore, withdrawn isolation confirmation and password editing. No retired identity import starts, no identity activates, and the current status/newer draft is retained.
- An uninterrupted control imports exactly once, activates the expected synthetic identity and clears its password fields.
- Relay cancellation across a newer file, pasted input edit, lock and camera start. Retired inspection never starts and cannot replace the newer package/status.

Before repair the backup regression observed one import after lock; the Relay regression observed both the new and retired package being inspected. Both regressions pass after repair. All 32 Cipher UI tests pass.

## Combined recovery and maximum-message QR check

`tests/cipher-workflow.test.mjs` uses actual WebCrypto and bundled encoder/independent decoder code. It generates two fictional identities, exports and restores their encrypted backups, seals a 2,048-byte message containing a leading BOM, newline, NUL and four-byte Unicode characters, renders every numbered QR matrix to synthetic RGBA pixels, decodes every frame, collects them in reverse order, and checks byte-for-byte package preservation. The recipient rejects a wrong independent secret without consuming replay state, recovers the exact original text with the correct secret, and rejects a repeat in that session.

This is a local software integration pass. It does not exercise a physical camera, browser file picker, OS download/share, real radio isolation or live Android traffic enforcement.

## Other checks and feedback

The complete Node suite passes 247 tests with zero failures, cancellations or skipped tests. Existing offline security tests cover 31 cases; the bounded updater/cache review reproduced no new defect. Release-specific cache retention is intentional, and installed older copies must follow the normal close/reopen update instructions. Synthetic service-worker states are not browser-native lifecycle evidence.

The private feedback queue was read through the owner-only database tool. It contained three synthetic owner QA reports and no external tester feedback; report contents and identifiers are not published here. No feedback rows were changed and no messages were sent.

Build/package checks verify the unchanged APK digest and native source fingerprints, reviewed source archives, QR vendor derivations, assembled routes/security headers, download checksums and offline body/header manifests. Fresh Android SDK signature verification was not performed in this environment. See the prior native verification records for their separate scope.

## Remaining gates

`DEVICE-ACCEPTANCE.md` remains NOT RUN for physical-device rows. VGuard routing/bypass/lifecycle, Android/iPhone import/share and offline reload, Safari focus behaviour, Cipher camera/backup recovery on actual isolated devices, independent review and real beta feedback remain open. These local results do not establish full launch readiness or impregnable products.
