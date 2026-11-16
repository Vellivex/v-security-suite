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

Inspect the reported test result and verify that the test ran. The integration test skips when the mailbox argument is absent. It runs two Matrix clients with different persisted state in one emulator process. It exercises login, encrypted direct-room invitation, rejection before verification, SAS, an event sent while a client is disconnected, session restore and decryption, the server’s encrypted representation, rejection of a plaintext room, and sign-out. The test does not simulate an operating system putting a physical device to sleep.

## Physical Android and GrapheneOS

Run these cases on a GrapheneOS Pixel 7 or newer and a stock Android phone with the actual build under test. Use a fresh fixture and separate test accounts. Record model, OS version and build, app version, transport, power state and timing. If ADB, charging or instrumentation affects an idle test, record that condition with the result.

| Case | Acceptance evidence |
| --- | --- |
| First sign-in and invites | Request a code, reject a wrong or expired code, sign in with a fresh code and exchange IDs by QR/share and by typed ID. Verify the ID was the intended contact. |
| Verification and room policy | Confirm that an unverified contact cannot receive text through the UI. Compare SAS on both devices, reject a deliberately mismatched sequence and verify fail-closed behavior. Complete a fresh verification and test rejection of plaintext and non-direct rooms. |
| Normal send and state | Send fictional text in both directions. Check pending, sent and failed UI on a network interruption. Record when the server accepts the event and when the recipient actually sees it. Check no duplicates after reconnecting. |
| Offline and locked delivery | Turn off the receiving device’s network, send from its peer and restore connectivity. Repeat with the receiver locked through a meaningful idle interval. Record whether and when anything appears while locked, on unlock and on opening the app. A foreground catch-up result is evidence for that state only. Push-assisted locked-screen delivery remains outside this alpha. |
| Process restart and keys | Stop and reopen the app, verify session and timeline restoration, then sign out. Verify local state can no longer restore. Start a new device session and confirm the alpha’s key-loss warning and changed-identity behavior. |
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
