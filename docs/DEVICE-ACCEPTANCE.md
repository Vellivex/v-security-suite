# Physical-device acceptance record

Status: NOT RUN. Do not infer a pass from the existence of this checklist. Use spare devices and synthetic data. The same operator can conduct these tests internally; this does not constitute independent review.

For every result record date, product version, downloaded artifact SHA-256, device model, OS build, browser version, exact steps, expected/observed behavior and a non-sensitive evidence file. Mark PASS / FAIL / BLOCKED individually; fix and rerun failed rows on the same build and configuration.

## VGuard — Android

Use the separately identified probe apps and controlled endpoints in `apps/vguard/device-qa/README.md`. Record the target endpoints, protocol and server observations. First verify the probe can reach the endpoint without VGuard; otherwise a failed request does not prove blocking.

| Scenario | Expected behavior / acceptance evidence | Result |
| --- | --- | --- |
| Selected app, unselected app, stop and restore | Selected probe blocked while active; unselected probe allowed; explicit stop restores selected probe connectivity. Server receipts corroborate both directions. | NOT RUN |
| IPv4, IPv6, TCP, UDP and DNS | Selected probes cannot transmit through each available path. An unavailable test network is BLOCKED, not PASS. | NOT RUN |
| Existing sockets, alternate network binding | Document whether already-open traffic and explicit underlying-network attempts can bypass the active policy. | NOT RUN |
| Sleep/wake and Wi-Fi/mobile switching | UI state agrees with actual observed enforcement before, during and after transitions. | NOT RUN |
| Revocation, crash, force-stop and reboot | Document loss of blocking accurately. The current build is not fail-closed or always-on; never record these as continuous protection. | NOT RUN |
| Shared UID, work/user profiles and updates | Verify which app identities and profiles are controlled; changed identity cannot inherit a stale rule silently. | NOT RUN |
| Export and restoration | Only approved document targets accepted; CSV has literal values, no unintended records, and cleanup/recovery is clear. | NOT RUN |

## VVault and VRelay — Android and iPhone

Repeat each row in the actual supported browsers. Use an offline keyboard and disable cloud spelling/translation services for the test; page hints do not enforce the keyboard configuration.

| Scenario | Expected behavior / acceptance evidence | Result |
| --- | --- | --- |
| Cross-device round trip | Exact Unicode/BOM/newline preservation; wrong passphrase and modified package fail without plaintext. | NOT RUN |
| Import, download, copy and OS share | Only the intended encrypted package is transferred; errors preserve a usable state. Clipboard/files are separate from session clearing. | NOT RUN |
| Hide, lock, history restore and idle | Drafts/passphrases/results clear as documented; pending work cannot repopulate them. | NOT RUN |
| Offline install/update and reload | Close tabs, reopen, disconnect all radios, reload. Confirm files are available; missing/corrupt assets fail closed. | NOT RUN |
| Interrupted browser storage/update | Save ciphertext before recovery; verify restart cannot mix releases or silently replace missing offline code. | NOT RUN |

## V Cipher — offline Vault and Relay devices

Each correspondent normally needs separate Vault/Relay roles. Record the device/role mapping. Browser offline indicators alone cannot demonstrate physical isolation.

| Scenario | Expected behavior / acceptance evidence | Result |
| --- | --- | --- |
| Backup save and restore | Generate on isolated Vault; confirm the actual file exists, lock, reopen offline, restore with its passphrase and compare full fingerprint. | NOT RUN |
| Contact verification | Compare full fingerprints through a trusted separate channel; changed key cannot inherit confirmation. | NOT RUN |
| Two-way physical QR transfer | Transfer public cards and synthetic encrypted messages, including maximum-size frames; exact authenticated plaintext on recipient Vault. | NOT RUN |
| QR interruption/corruption | Reorder, duplicate, omit and mix frames; no wrong transfer completes. Lock/stop/reconnect cancels retired camera work. | NOT RUN |
| Replay and separate factors | Duplicate refused within the same unlocked session; wrong sender/key/secret rejected. Replay records reset at lock/reload by design. | NOT RUN |
| Isolation and recovery | Vault radios physically disabled; reconnect locks. Damaged backup/wrong passphrase fail without identity activation. A compromised device remains outside the protection claim. | NOT RUN |

## Release decision

Do not mark launch-ready while required rows are NOT RUN, FAIL or BLOCKED. Record the intended threat model, accepted design limitations and reviewer identity separately. Independent review remains an additional gate and cannot be satisfied by renaming these internal tests.
