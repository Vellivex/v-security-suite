# Next free mobile session plan

Prepared 24 October 2026. This is a run sheet, not a test result. All rows below are NOT RUN. It does not change the physical acceptance record in `DEVICE-ACCEPTANCE.md`.

The last observed Appetize Free account period ends at 00:00 UTC on 1 November 2026 (00:00 UK time). The account showed 30 of 30 minutes used. Confirm the replenished allowance in billing before starting another stream. No paid upgrade or duplicate account is authorised. Provider limits and device availability must be checked again on the day.

## Prepare without consuming minutes

1. Check the intended public source/release revision and locally run `node tests/fixtures/mobile/verify.mjs`. If Python `cryptography` is already installed, run `python3 tests/fixtures/mobile/verify-independent.py` too. Keep the public fictional fixture values from `tests/fixtures/mobile/README.md` to hand.
2. Preselect a direct app route in Device Sandbox. Use `/apps/vault#vault-form`, `/apps/relay#relay-form` or the ordinary Cipher route. Do not put messages, passphrases, identity backups or prefill instructions in URL parameters. Set any provider-supported launch URL through the normal UI or documented parameters, before starting the device.
3. Prepare one case per session, plus a blank evidence row. Arrange the expected text beside the remote screen. Have a screenshot method ready. The last runs took roughly 40 seconds to enter a 300-character fixture; remote keyboard events may continue after the typing call returns. Inspect the completed field before submitting.
4. Capture device model, OS build and exact browser version on each browser's first session. Reuse the record only if that actual configuration is unchanged. If a version cannot be established, record UNKNOWN and the limitation; do not guess from the OS version.
5. Stop each stream explicitly as soon as its assertion and evidence have been captured. Navigating within the phone does not stop its clock. Navigating the surrounding Appetize page back to Apps ended streaming in the previous run. Confirm it is stopped and inspect usage before starting again. Avoid stray clicks on a timed-out Tap-to-Start screen.

## Reserve minutes for assertions, not setup

Plan eight sessions of at most three minutes: at most 24 minutes, with six minutes reserved for setup failure or a same-build retest. Three minutes is a ceiling, not a target. If a result cannot be observed before the cap, record NOT COMPLETED. That is neither a pass nor an application defect.

| Session | Configuration and focused assertion | Expected result | Result |
| --- | --- | --- | --- |
| A1 | Android Chrome: record versions; switch VVault to Unlock; use `valid.vvault.json` and the correct test passphrase | Exactly two plaintext lines from `expected.json`; literal angle brackets; passphrase field cleared | NOT RUN |
| A2 | Android Chrome: valid fixture with incorrect passphrase; then Clear session if time permits | Unlock fails without plaintext; Clear session empties input/results | NOT RUN |
| A3 | Android Chrome: `tampered-ciphertext.vvault.json` with correct passphrase | Authentication fails without plaintext | NOT RUN |
| A4 | Android Chrome: VRelay valid fixture, then malformed `{}`; attempt download/import only if time remains | Valid package accepted structurally; `{}` rejected and previous transfer output disabled/cleared | NOT RUN |
| I1 | iOS Safari: record versions; VVault encrypt short fictional text; inspect focused inputs and result at ordinary zoom | Encryption succeeds; typed values and submit/status remain reachable without clipped controls | NOT RUN |
| I2 | iOS Safari: valid independent fixture and correct passphrase; Clear session if time permits | Exact two-line plaintext; passphrase cleared; Clear session empties results | NOT RUN |
| I3 | iOS Safari: valid fixture and incorrect passphrase | Unlock fails without plaintext | NOT RUN |
| I4 | iOS Safari: VRelay valid fixture, then malformed `{}`; download/import only if time remains | Valid structure accepted; malformed input clears/disables transfer output | NOT RUN |

The second assertion in a row is optional when time is short. Record its outcome separately rather than assigning one combined pass to unobserved actions. Use the reserve for a reproduced failure and same-build retest; do not claim the Safari tamper case, OS sharing, offline reload or other unlisted paths were covered by this allocation.

## Device interaction details

- Switching VVault mode clears the current session. Select Unlock before entering its fixture and passphrase.
- Leaving or hiding a tool tab clears its session. Save/copy encrypted output before switching apps or pages. Files and clipboard are separate copies that session clearing does not erase.
- Input-focus zoom and scrolling need fresh visual inspection before coordinate clicks. Do not rely on the previous screenshot while a swipe is still moving the page.
- iOS Tab navigation may skip buttons. Use the visibly identified control, then observe its status. Android Back hides the keyboard only while it is visibly open; an extra Back may leave the page.
- A browser may offer to save a test passphrase despite page hints. Dismiss that offer; do not save it or treat hints as enforcement.
- Record actual errors. Do not retry an action blindly after a control interruption: the action may have completed. Inspect state first.
- A format-valid tampered ciphertext remains acceptable to VRelay. Only VVault's authenticated decryption checks its encrypted contents.

## Cipher and VGuard remain separate gates

Do not spend the remaining allowance installing VGuard until the provider's support for running a VPN application and a controlled, reachable probe setup are established. The existing `apps/vguard/device-qa/README.md` requires an off-state reachable baseline, selected/unselected controls and matching server receipts. A failed request alone proves no blocking. Native host stubs and this browser plan cannot complete Android routing checks.

Cipher's online identity-operation rejection can be observed as a short isolated case when useful, but a blocked action is not a completed backup/recovery workflow. Full Cipher testing needs a documented Vault/Relay device mapping, downloaded encrypted backups, trusted fingerprint comparison and actual QR exchange. Browser offline indicators and simulator UI do not demonstrate physical isolation. Do not add a test bypass to the production gates to fit the timer.

Real phones available before reset can be used for these internal checks with fictional data; record those results against `DEVICE-ACCEPTANCE.md`. No camera, physical isolation, Android enforcement or independent audit pass is inferred from this plan.

## Evidence row template

Copy one row per assertion, including optional actions performed within a session:

| Field | Record |
| --- | --- |
| Case / date / operator | |
| Product version / source revision | |
| Device model / virtual or physical | |
| OS build / exact browser version | |
| Fixture filename / SHA-256, or exact fictional text | |
| Steps and expected behaviour | |
| Actual status / visible result | |
| PASS / FAIL / BLOCKED / NOT COMPLETED | NOT RUN |
| Non-sensitive screenshot / evidence filename | |
| Minutes used / cumulative account usage | |
| Defect reference / fixed revision / same-configuration retest | |

Keep screenshots and reports free of real passphrases, private messages, keys, accounts and personal traffic. A fixed public test passphrase is fictional data; never substitute a reused account password.
