# Messenger alpha acceptance checks

Record the commit and package SHA-256 with each run. Keep records free of real messages, credentials, one-time codes, verification values and production identifiers. Use `PASS`, `FAIL` or `BLOCKED` for each case and include the environment, steps, expected result, actual result and relevant redacted evidence.

## Build and automated checks

Run the Android checks documented in the [Messenger README](../README.md). They compile the debug and instrumentation APKs, exercise the JVM send guard and run Android lint. Running JVM tests or compiling the instrumentation APK does not exercise a Matrix device session.

With the server dependencies installed and its virtual environment active, run the backend unit tests from the repository root.

```sh
python -m unittest discover -s apps/messenger/server/tests -p 'test_*.py'
```

With a fresh loopback fixture already running on ports 8008 and 8025, run its HTTP smoke tests from the repository root. Set the variable to the runner's private state directory in this terminal.

```sh
python apps/messenger/server/tests/smoke.py \
  --port 8008 --mailbox-port 8025 --mailbox-key-file "$messenger_state/mailbox-key"
```

On an isolated Linux runner with Docker Compose v2, Python 3.12 and `age` installed, run the deployment check as an unprivileged user with Docker access. Port 8080 must be free.

```sh
python3 apps/messenger/server/tests/deploy_smoke.py
```

This check creates disposable private deployments and removes their containers and database volumes on exit. It exercises the invite gate, restricted routes, proxy headers, database permissions and restart persistence. It then encrypts a backup, removes the original volumes and restores the database, media and server identity into a fresh deployment. The destination retains its own mail and database credentials and starts with an empty verification-code store. SMTP is confined to loopback; no real verification emails are sent. This does not replace a restore drill on the eventual production host.

Run the instrumented integration test with a fresh fixture and one connected Android emulator. The arguments below use the default test ports. Pass only the disposable fixture token, and keep it out of retained command logs or evidence.

```sh
adb reverse tcp:8008 tcp:8008
adb reverse tcp:8025 tcp:8025
messenger_mailbox_key=$(cat "$messenger_state/mailbox-key")
(
  cd apps/messenger/android
  ./gradlew --no-daemon connectedDebugAndroidTest \
    "-Pandroid.testInstrumentationRunnerArguments.messengerMailboxKey=$messenger_mailbox_key"
)
unset messenger_mailbox_key
adb reverse --remove tcp:8025
adb reverse --remove tcp:8008
```

Inspect the reported test result and verify that the tests ran. The integration suite skips when the mailbox argument is absent; the CI runner rejects skipped or failed cases. It runs two Matrix clients with different persisted state in one emulator process. It exercises login, encrypted direct-room invitation, rejection before verification, SAS, an event sent while a client is disconnected, session restore and decryption, the server’s encrypted representation, rejection of a plaintext room, and sign-out. A second case starts with notification permission denied, verifies in-app messaging, grants permission, starts the real foreground service, closes the activity and checks a generic alert for a real encrypted message. It also checks notification content for fixture messages and identifiers. These tests do not simulate an operating system putting a physical device to sleep.

Account recovery restores the account’s encryption keys. In this alpha, it may not restore any earlier messages. The UI recovery case requires both original messages to remain hidden when their imported keys lack authenticated sender information, requires new encrypted messages in both directions, and checks that those new messages remain readable after a process restart. The sender and verified-device requirements remain the same for all cases.

The signed ARM64 acceptance workflow selects a reviewed release manifest. Alpha06 is the default and runs four scenarios with the exact published app and instrumentation APKs: a fresh installation and in-place updates from the original Alpha02, Alpha04 and Alpha05 installers. Selecting Alpha05 replays its original fresh, Alpha02-update and Alpha04-update scenarios; its release manifest remains unchanged. Every update case seeds the pinned original app, verifies its installed version, exchanges original messages between verified accounts, and leaves the original session signed in. Alpha04 and Alpha05 must complete recovery setup for both accounts before this exchange; Alpha02 has no such setup step. The runner then force-stops the app and uses `install -r` to install the selected target, checks the exact target version and ARM64 translation, and requires both original messages to remain visible without the recovered-history notice. Alpha02 completes recovery setup on the new app; Alpha04 and Alpha05 must retain their recovery-ready sessions without setting up or recovering them again. The Alpha05-to-Alpha06 case additionally compares a private one-way fingerprint of the original synthetic account, device, access token and local SDK store key across the update. Only that fingerprint crosses the update boundary; none of those raw values enters retained evidence. No update seed signs out or replaces its original local session. The full wrong-key, recovered-history and new-message checks remain in the fresh/source flow.

Alpha06 source and signed-APK checks require the inbox's **New conversation** control to expose that accessible name, be displayed and enabled, and have a click action. The separate two-installed-app test also locates and uses that accessible control. Compilation alone does not establish these runtime results.

The source and fresh signed-APK flows also exercise the actual Chat composable with fictional messages. One layout case shrinks its measured viewport, and another replaces the latest message while keeping the visible count at 200. A third constrains a recovered chat to a compact height representative of the space above a software keyboard: it requires the full recovery notice before new messages, then a long incoming reply and the composer to remain visible. All three require the latest message to be displayed without scrolling from the test. These layout cases run on the app under test, never on the older app used to seed an update. Retain their instrumentation log with the other runtime evidence. A recovered-reply visibility timeout records only node counts, bounds, scroll values, composer focus and keyboard/root geometry; it must not print message text, recovery keys or a semantics tree.

## Physical Android and GrapheneOS

Run these cases on a GrapheneOS Pixel 7 or newer and a stock Android phone with the actual build under test. Use a fresh fixture and separate test accounts. Record model, OS version and build, app version, transport, power state and timing. If ADB, charging or instrumentation affects an idle test, record that condition with the result.

| Case | Acceptance evidence |
| --- | --- |
| First sign-in and invites | Request a code, reject a wrong or expired code, sign in with a fresh code and exchange IDs by QR/share and by typed ID. Verify the ID was the intended contact. |
| Verification and room policy | Confirm that an unverified contact cannot receive text through the UI. Compare SAS on both devices, reject a deliberately mismatched sequence and verify fail-closed behavior. Complete a fresh verification and test rejection of plaintext and non-direct rooms. |
| Normal send and state | Send fictional text in both directions. Check pending, sent and failed UI on a network interruption. Record when the server accepts the event and when the recipient actually sees it. Check no duplicates after reconnecting. |
| Offline and locked delivery | Turn off the receiving device’s network, send from its peer and restore connectivity. Repeat with the receiver locked through a meaningful idle interval. Record whether and when anything appears while locked, on unlock and on opening the app. A foreground catch-up result is evidence for that state only. Push-assisted locked-screen delivery remains outside this alpha. |
| Optional background alerts | Deny permission and confirm messaging still works in the app. Enable alerts in the profile, allow permission and verify the ongoing connection notification. Send from the other phone while the receiving app is off screen. Check generic alert content, airplane-mode status recovery, notification-channel disablement and the Stop action. Force stop and restart the phone separately; reopen and explicitly enable alerts again. |
| Account recovery | Confirm messages stay locked until recovery is set up. Reject a wrong last-four entry. Check the history limitation is visible before confirming sign-out. Complete sign-out while online, request a fresh email code and confirm a wrong recovery key leaves recovery locked and retryable. With the saved key, check the recovery notice, keep unauthenticated historical messages hidden, and send a new encrypted message in each direction. Verify another trusted phone must sign out first and that a failed online revocation keeps the old local keys. |
| Process restart and in-place update | Restart a recovered session and check that both new messages remain readable while unauthenticated historical messages stay hidden. Separately, install the update over existing signed-in Alpha02 and Alpha04 installations and confirm that each original local session and both original messages are retained. Alpha04 must retain its existing recovery setup. |
| Platform behavior | Review TalkBack, keyboard focus, larger text, screen capture/recent-apps and backup behavior on both devices. Check that the packaged release lacks the debug loopback policy and fixture surfaces. |

## Evidence for this candidate

| Check | Recorded result or evidence |
| --- | --- |
| Commit, toolchain, APK SHA-256 and signer | Pending entry |
| Android debug build, JVM unit tests and lint | Pending entry |
| Backend unit and loopback HTTP smoke | Pending entry |
| Connected Android integration with two local clients | Pending entry |
| Stock Android physical verification | Pending physical run |
| GrapheneOS physical verification | Pending physical run |
| Independent security, privacy and release identity review | Pending review |

Before a public release, record the artifact and signing identity, inspect the build and dependency notices, complete the applicable physical checks and independent review, and pass the repository’s public-identity checks. A production homeserver, mail delivery and any push service need deployment configuration and operational verification within the owner's budget.
