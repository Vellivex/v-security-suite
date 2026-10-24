# Remote mobile testing and compatibility repair — 24 October 2026

Site 0.5.1; VVault/VRelay 0.2.9; V Cipher 0.1.9 research. The VGuard 0.1.3-candidate APK is unchanged.

## Environment and cost boundary

The owner requested use of free remote testing services. Appetize registration was completed with the owner entering the password and accepting the account terms. The account showed Free/Trial, a 30-minute monthly allowance, and no invoices. No payment details, paid upgrade or API credential were entered or created. The last observed pre-retest usage was 10 sessions / 27 minutes. Three-minute session limits and a transient browser-control interruption constrained coverage. A timed-out or unobserved result is not a pass or an application failure.

Only synthetic messages, test passphrases and a public-format encrypted fixture were used. iPhone 14 Pro / iOS 17.2 was a simulator; Pixel 4 / Android 12 was an emulator. Exact browser versions were not captured, so these are not a supported-version matrix.

## Actual remote observations before the repair

| Check | Observation | Result |
| --- | --- | --- |
| iOS Safari VVault page | Custom-domain HTTPS page and beta notice loaded; form usable. | PASS |
| iOS Safari VVault encryption | A dummy message encrypted successfully; passphrase fields cleared afterwards. | PASS |
| iOS Safari separate-fixture decryption | The independently generated AES-GCM/PBKDF2 fixture decrypted to two exact lines, including Café, a lock emoji and literal `<b>plain text</b>`. | PASS |
| Android Chrome VVault encryption | A dummy message encrypted; success status and VVAULT JSON output displayed; passphrases cleared. | PASS |
| Android Chrome Clear session | Explicit clear emptied the encrypted result and displayed the documented memory/clipboard limitation. | PASS |
| Android Chrome VRelay malformed data | `{}` was refused with `Unsupported or invalid encrypted package.` and no transfer output. | PASS |
| Android Chrome VRelay valid fixture | The same well-formed fixture failed with `Object.hasOwn is not a function`. No plaintext was disclosed. | FAIL — repaired below; remote retest recorded separately |
| Other decryption/Relay attempts | Several runs expired at the provider limit or ended before the outcome could be inspected. | NOT COMPLETED |

Chrome offered to save a dummy passphrase despite the page's input hints. That prompt was dismissed without saving. Safari input-focus zoom also produced clipped form content in one run; this needs a separate reproducible usability check. These observations do not establish a cryptographic vulnerability or a guarantee that browsers obey input hints.

## Repair and regression evidence

VVault and Cipher now use `Object.prototype.hasOwnProperty.call` for exact own-field checks. Cipher's strict parser indexes the last stack entry without `Array.prototype.at`, and validates UTF-16 locally without `String.prototype.isWellFormed`. Lone surrogates are still rejected; no global polyfill, cryptographic format or algorithm parameter changed.

Three isolated-process regression tests remove all three newer built-ins, then exercise actual Vault and Cipher cryptographic round trips, encrypted identity backup/restore, non-extractable restored keys, Unicode/BOM/newline/NUL preservation, wrong-password/tamper rejection, duplicate fields and malformed Unicode. Each test failed on the original implementation for a distinct missing built-in and passed after repair.

Website feedback creates UUIDv4 references using native `crypto.randomUUID` when available or securely generated random bytes with the correct version/variant bits. Missing or failed secure randomness cannot allow native form submission. Uncertain retries retain their reference; edits and conflicts obtain a new one. No `Math.random` fallback is used.

All 240 automated tests passed. Packaging verified the QR vendor transformations, the unchanged VGuard APK hash and 14 native-source fingerprints, strict source archives from 154 reviewed regular files, assembled routes/security headers/download hashes, and offline body/header manifests. Fresh SDK signature verification was not repeated in this environment. Deployment and post-repair remote results remain separate observations.

## Open gates

VGuard was not installed or exercised in this remote run. The initial browser download attempt was blocked because its download-permission/origin context could not be established; no security control was bypassed. Appetize VPN support was not established. BrowserStack explicitly excludes VPN apps installed directly on its devices.

Physical Android routing, IPv4/IPv6/DNS and existing-socket bypass, sleep/reboot/mobile switching, real phone import/share/keyboard behaviour, two-device physical QR/camera operation, genuine offline isolation and independent review remain open. The physical acceptance checklist remains NOT RUN. The simulator/emulator work does not make the apps impregnable or establish launch readiness.
