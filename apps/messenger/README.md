# Vellivex Messenger Android alpha

Messenger is an Android source alpha for one-to-one text conversations. The core is free. This build has no payment flow, public service or push notifications. Use fictional conversations and the local test server described below.

The app signs in with an email code, lets you share a Vellivex ID as a QR code or Matrix link, and uses the ID to invite one contact. Accept the invitation, then compare the verification symbols or numbers over an independent channel before sending text. The verification dialog establishes trust separately from sharing an ID. Signing out removes the local session and keys. This alpha has no key recovery, and signing in again may leave earlier messages unreadable.

## Build from source

Use JDK 21, Android SDK command-line tools and Python 3.12. Set `JAVA_HOME` and `ANDROID_HOME`, and add `sdkmanager` and `adb` to `PATH`. Accept the Android SDK licenses locally before installing packages. The project uses the checked-in Gradle 8.14.3 wrapper with a SHA-256 distribution check, Android Gradle Plugin 8.13.2, Kotlin 2.2.21 and Matrix Rust SDK for Android `26.11.05`. The minimum Android API is 26 and the compile and target API is 36.

Run these commands from the repository root.

```sh
sdkmanager --install 'platform-tools' 'platforms;android-36' 'build-tools;35.0.0' 'build-tools;36.0.0'
cd apps/messenger/android
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

The debug APKs are `apps/messenger/android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk` for modern ARM phones and `app-x86_64-debug.apk` in the same directory for the emulator. They use the `com.vellivex.messenger.alpha` application ID and a local debug signer. The build commands recreate a debug APK from source. Release signing and binary reproducibility require separate verification.

## Run the isolated test server

From the repository root, create a virtual environment and start a fresh local Synapse instance. Keep this terminal open while testing.

```sh
python3.12 -m venv apps/messenger/server/.venv
. apps/messenger/server/.venv/bin/activate
python -m pip install -r apps/messenger/server/requirements.txt
messenger_state=$(mktemp -d)
python apps/messenger/server/dev_server.py \
  --state-dir "$messenger_state" --port 8008 --mailbox-port 8025
```

The server listens on loopback and accepts only synthetic `@example.test` addresses in this mode. The temporary directory stores a private mailbox key and the fixture state. Keep both local. The local runner is for development and automated tests.

Use another terminal to install the APK on one connected device or emulator. Add an `adb -s SERIAL` selector for each device if more than one is connected.

```sh
adb reverse tcp:8008 tcp:8008
adb install apps/messenger/android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
```

In the app, open **Test server settings** and enter `http://127.0.0.1:8008`. Request a code using a unique synthetic email. The local mailbox spool under the runner's `mail/` directory contains the one-time codes for the test. With a fresh runner and one request at a time, there is one new spool file per request. Open it locally and enter the eight-digit code. Use a different `@example.test` address for the second tester and exchange Vellivex IDs out of band. Keep the codes out of test reports.

Stop the local runner with Ctrl+C. Remove the fixture state after the test run and remove `adb reverse` rules for any devices you forwarded. The server fixture uses generated keys and local state. Keep those files out of source, logs and screenshots.

## Checks and release limits

See the [architecture and trust boundaries](docs/architecture.md), [release acceptance checks](docs/release-acceptance.md) and [local server instructions](server/README.md). The release checklist tracks what was actually run. Passing a local smoke test cannot establish locked-device delivery, independent security assurance or stock Android and GrapheneOS behavior.

Original source is GPL-3.0-or-later. See the repository [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE) for license and attribution information.
