# Vellivex adversarial review — 23 October 2026

Release under review: VGuard 0.1.3-candidate; VVault/VRelay 0.2.1 browser beta.
This is an internal source review and attack-regression exercise, not an independent audit, penetration-test certification or proof that a phone is protected.

## Findings and fixes

| Surface | Reproduced failure | Fix and evidence |
| --- | --- | --- |
| VGuard CSV export | A copied export-method model accepted file:// output destinations; Android ContentResolver supports that scheme. This was not a demonstrated attack on a phone. | Production ExportTarget permits only a document content URI with returned write permission and an explicit current grant. Validate before queuing and immediately before opening; provider failures are caught. 14 helper checks pass. |
| VVault | Unpaired UTF-16 surrogates silently encoded as replacement characters, changing plaintext and aliasing passphrases. | Reject ill-formed UTF-16 before encoding; valid emoji and existing well-formed envelopes remain compatible. Early message length bound. |
| VVault | Editing/clearing during PBKDF2 could re-enable submit and start repeated concurrent jobs. | Separate in-flight crypto guard survives input and session changes; stale completions remain suppressed. |
| VVault/VRelay offline files | Worker-only changes reused the active release cache; a failed installation could delete that cache. | Cache identity hashes both the manifest and worker template. Existing same-release files are integrity-checked without mutation/deletion; a failed new installation removes only its own cache. |
| Offline recovery | An unchanged active worker was reported as a newly verified installation. Incomplete or evicted cache was not automatically repaired. | UI explicitly says existing files were not rechecked. Missing-file and installation instructions explain closing tabs and clearing this site's stored data before reinstalling online. Fail-closed behavior retained. Automatic cache repair is not implemented. |
| Website redirects | Crafted //host/ path produced a scheme-relative external redirect. | Absolute same-origin canonical URLs; HTTP upgrades to HTTPS. Slash/backslash adversarial cases pass. |
| Feedback retries | An altered payload could receive saved success for an earlier report ID; a completed submission could clear a newer draft. | Compare normalized payload and network pseudonym; return 409 on conflict. Client preserves edits and retries uncertain identical reports using their original ID. |
| Feedback concurrency | Identical concurrent retry could report failure despite an already committed row, including when the first fills quota slot ten. | Reconcile existing row after write error and zero-change quota result, with no second insert. Real SQLite concurrency tests. |
| Feedback abuse controls | Daily pseudonym rollover reset the hourly counter at midnight. | Atomic insert counts current and preceding daily pseudonyms over the rolling hour; midnight test passes. |
| Feedback input boundaries | Overly permissive MIME/UUID checks and untested streamed input boundaries. | Exact JSON media type and UUID length, strict UTF-8, bounded streamed body with cancellation, parameterized SQL. |

## Verification coverage

| Product | Completed here | Still unverified |
| --- | --- | --- |
| VGuard | Production parser/rules: 20,132 assertions. Existing adversarial engine: 18 scenarios / 2,192 assertions plus revocation and package-identity races. Export helper: 14 checks. Seeded hostile parser stress: 750,100 calls. Concurrent lifecycle stress: 300 cycles, 400 descriptors closed once. Independent CSV parser: 321 cases including 66 formula-leading values. SDK compilation, manifest/permissions, alignment and APK signature checks. | Physical Android install, consent/grant behavior, real DocumentsProvider compatibility, VPN routing/leak testing, foreground-service/background behavior, OEM/battery behavior, other VPN interactions. Host Android stubs are not OS evidence. |
| VVault | Round trips, nonce/salt variation, wrong passphrases, tamper rejection, malformed envelopes, Unicode rejection, limits, asynchronous locking/concurrency and clipboard completion handling. Python cryptography interoperability in both directions with synthetic Unicode data. | Actual mobile Safari/Chrome lifecycle, OS clipboard/download behavior, compromised-device protection (outside scope), expert cryptographic review. |
| VRelay | Strict envelope handling, bounded imports, stale import/share/copy suppression, session clearing, download/share state. Shared integrity-pinned offline installation/update failures. | Actual Android/iOS sharing and recipient delivery. Format checking does not authenticate a sender or prove encrypted content safe. |
| Website | Actual SQLite schema and production SQL, 40 simultaneous requests limited to 10 saved rows, identical retry races, quota boundary, midnight, cross-network conflicts, no public report read route, malformed UTF-8/MIME/streaming limits, SQL/HTML literals, redirect containment. Form draft preservation and retry acknowledgements. | Hosting-platform isolation is a provider boundary. This is not a live volumetric attack or an audit of hosting infrastructure. |

The final Node test run contains 45 passing tests. Test counts refer to distinct suites/inputs, not 750,100 independent security properties. Seeded fuzzing is bounded, not exhaustive. Source inspection and automated tests cannot establish absence of vulnerabilities.

## Release evidence

APK SHA-256: `6977d17d356f76a181a4979bf4fefa4f486167b90e2df612e5c93aed4977df58` (90,718 bytes).
Signing certificate SHA-256: `7bdb5a95a45f735a175580a937eb5c7ec55a2c886ce038ed106c1dfa1f3ff049`.
App source fingerprint: `9108459581d9a5fefe88ee3b151dece9dcd61374cd6eeb79d225295a0ec8e1e3`.
The original signing identity was required, not silently regenerated. Signing material is excluded from source and release archives. Matching 0.1.1 and 0.1.2 historical source archives are retained.

See releases/VGuard-0.1.3-Build-Report.json and Package-Verification.txt. No working Android emulator or attached phone was available; no device-runtime pass is claimed. Broader paid launch remains blocked on real-device acceptance, external feedback and an independent security review. Billing and tester invitations are not enabled by this release.

## Reproduce

Use Node 24+, Python 3 and Java (host harness). Run `npm test`, `bash apps/vguard/tests/adversarial/run-adversarial-tests.sh`, and `python3 apps/vguard/validation/UI-Logic-Checks.py`. Native build instructions are in apps/vguard/README.md. Run `npm run build` and `npm run validate` after providing the signed release artifacts. Full signed build reproducibility is not demonstrated.

References for reviewed platform boundaries: Android DocumentsContract / ContentResolver documentation and WHATWG Encoding Standard. TextEncoder converts JavaScript text through Unicode scalar-value strings; rejecting unpaired surrogates before encoding avoids replacement-character aliases.


## Follow-up passes — browser release 0.2.2

Three additional focused passes completed after the initial release:

1. **Exact plaintext preservation.** A synthetic message starting with U+FEFF decrypted without that character. This was reproduced against 0.2.1. Set UTF-8 TextDecoder `ignoreBOM:true` so an authenticated leading marker remains part of the message. Leading/repeated markers, NUL, CR/LF, tabs and astral Unicode now round-trip exactly. Independent Python/Web Crypto interoperability was rerun in both directions with a leading U+FEFF.
2. **Ambiguous envelope parsing.** The previous parser accepted conflicting duplicate JSON fields using the last value. This was a low-severity parser-ambiguity issue, not a demonstrated decryption or authentication bypass. Reject duplicate top-level member names, including escaped equivalent spellings, while continuing to accept whitespace and reordered valid members. The scan runs only after bounded JSON syntax and envelope shape validation. Added 2,000 seeded invalid-field mutations and 100 missing-field cases.
3. **Stale async results and native stress expansion.** Added 120 deterministic lock/hide/mode-change/history-restore/edit schedules against the actual browser handlers in the host DOM harness. No retired crypto result was restored. The production Java parser was exercised with four deterministic seeds: 3,000,400 calls total. Native engine, export, revocation, package-identity, 300-cycle lifecycle and CSV suites also pass. No additional native production change was justified by this pass; the signed VGuard 0.1.3 APK is unchanged.

The updated Node suite has **49 passing tests**, zero failed or skipped. No newly reproduced failure remains in these covered cases after the fixes. This is bounded evidence, not proof of impregnable software; physical Android/iOS, real network-leak behavior, mobile sharing, independent audit and reproducible builds remain outstanding as above. Initial 0.2.1 counts earlier in this report are historical.

The previous hardening release was verified live on www.vellivex.com: synthetic Unicode encrypt/decrypt, ciphertext tamper rejection with empty output, VRelay valid/invalid format handling, successful offline update to 0.2.1, honest unchanged-update status and one private feedback row whose acknowledgement matched owner-only database readback. GitHub workflow run 39996439854 passed for commit 9a3523433f052fab0ca971594514891775fc64fd. Those browser observations apply to 0.2.1; the 0.2.2 automated checks above are separate.


## Broad follow-up — browser release 0.2.3

**Fault injection found and fixed:** a cached script whose bytes changed after installation was returned with HTTP 200. Installation-time integrity checks alone did not cover later cache corruption. The service worker now hashes the exact cached response body before serving each manifest-listed file, including HTML and JavaScript. A missing file, unreadable cache, failed digest or body mismatch produces a plain-text 503 recovery message with no replacement network request. Valid cached files still load. This is corruption detection / defense in depth, not a demonstrated remote exploit, and does not protect a compromised origin that can replace the worker itself. It adds hashing and a transient response-body copy to each cached file read; actual phone overhead remains unmeasured.

**Broader attack tests:** 24 ciphertext bit flips, 3 independent-envelope field splices and 8 truncated-ciphertext cases all fail authenticated decryption. Canonical-base64 aliases and hostile field types are refused. A 500-request local concurrent burst against the actual SQLite schema saves exactly 10 rows and returns 490 rate-limit responses; no report text is exposed in any public response. Missing/opaque/foreign/suffix-confusion Origin values fail before database access. Live infrastructure was not flooded.

The Node suite now has **55 passing tests**, zero failures/skips. The 2,100 malformed-envelope cases, 120 async schedules, four-seed / 3,000,400-call native parser campaign, native lifecycle/export/race checks and independent interoperability evidence from the preceding pass remain applicable. Native production code/APK is unchanged; additional source review of exported entry points, signature-protected VPN service, rule storage, packet disposal and export handling found no new reproducible native defect in this pass. Host evidence does not validate Android OS enforcement.

Artifact validation now invokes the exact assembled Worker across all 13 public pages, checks isolation headers, verifies every embedded checksummed download and matches the displayed APK digest to its build report. Remaining physical-device, external-review and platform boundaries above still apply.

## Storage and interruption follow-up — unchanged browser 0.2.3

No new reproducible defect was found in this pass. Eight regression tests were added and the full Node suite passes **63 tests**, zero failed/skipped. These exercise production worker/app handlers under controlled faults:

- Cache open, cache lookup, response clone, body read, digest and non-success response failures all return a no-store plain-text 503 without a network fallback or internal exception text.
- Cross-origin requests, non-GET methods and unknown paths are not intercepted by the tool worker. Activation retains its own cache and unrelated caches while deleting only retired tool caches.
- Failed crypto restores controls and retains the draft. A late failure after locking cannot clear a newer passphrase/draft or replace locked status.
- Failed file reads clear old transfer state; out-of-order reads cannot overwrite the newest selection. A late sharing rejection cannot replace cleared-session status.

These are host fault-injection tests, not actual browser-disk failures or mobile OS sharing tests. App production code and the signed VGuard APK are unchanged. The latest preceding live browser checks loaded the 0.2.3 offline release, encrypted synthetic text and validated a compatible VRelay package. GitHub run 39999557950 passed for commit 5331b0badfd723658ae5b81c18c7e5029836545c. Physical-device and independent-review gaps remain unresolved.
