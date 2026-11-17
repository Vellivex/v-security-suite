# Vellivex Messenger Android alpha

Messenger is an Android source alpha for one-to-one text conversations. The core is free. Use fictional conversations when testing the app or the local server described below.

The app signs in with an email code, lets you share a Vellivex ID as a QR code or Matrix link, and uses the ID to invite one contact. Accept the invitation, then compare the verification symbols or numbers over an independent channel before sending text. The verification dialog establishes trust separately from sharing an ID.

## Build from source

Use JDK 21, Android SDK command-line tools and Python 3.12. Set `JAVA_HOME` and `ANDROID_HOME`, and add `sdkmanager` and `adb` to `PATH`. Accept the Android SDK licenses locally before installing packages. The project uses the checked-in Gradle 8.14.3 wrapper with a SHA-256 distribution check, Android Gradle Plugin 8.13.2 and Kotlin 2.2.21. The minimum Android API is 26 and the compile and target API is 36.

The Matrix SDK is built from the source pinned for Android version `26.11.05`, with a small Vellivex interface extension exposing its existing device-to-device SAS verification. This keeps contact verification independent of encrypted room-key sharing. Follow the prerequisites and build instructions in [the SDK build README](sdk/README.md) before the Gradle command below. The build requires the generated complete SDK AAR; the unmodified published SDK does not support this app's verification call.

Run these commands from the repository root.

```sh
sdkmanager --install 'platform-tools' 'platforms;android-36' 'build-tools;35.0.0' 'build-tools;36.0.0'
cd apps/messenger/android
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

The debug APKs are `apps/messenger/android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk` for modern ARM phones and `app-x86_64-debug.apk` in the same directory for the emulator. They use the `com.vellivex.messenger.alpha` application ID and a local debug signer. The build commands recreate a debug APK from source. Release signing and binary reproducibility require separate verification.

This alpha supports one active, cross-signed phone per account. For contact verification the SDK refuses to choose silently between multiple eligible devices.

For a remote private test, follow [the server deployment instructions](server/deploy/README.md). Build the release APK with `assembleRelease -PmessengerProductionServerUrl=https://YOUR_SERVICE_HOST` and sign it with the retained private release key. Release builds require this HTTPS origin and hide development server settings; they fail configuration if the origin is missing or invalid. Do not distribute an unsigned or placeholder-server release as ready to use.

## Recovery and moving phones

Save the recovery key in a password manager or somewhere private and confirm its last four characters before opening messages. On an existing phone, install the update over Messenger and set up recovery while still signed in. Keep the same installation so the app can use its existing keys.

To move phones, save the key and complete **Sign out** on the old phone while it is online. Then use your email code and saved recovery key on the new phone. A second trusted phone keeps the conversation view locked until that phone signs out. Recovery restores the account’s encryption keys. Some earlier messages may be unavailable if Messenger can no longer verify the device that sent them. If you lose both the recovery key and access to your trusted phone, an email code alone cannot restore encrypted conversations.

## Background alerts

After signing in, open **Your profile → Enable background alerts** and allow Android notifications. A quiet, ongoing notification shows the connection status and has a **Stop** action. Incoming alerts contain only a generic prompt to open Vellivex. They include neither messages nor contact names. Denying notification permission leaves ordinary in-app messaging available.

The user-enabled foreground service uses the same SDK connection as the app and works without Google Play services. It does not restart after force stop, process eviction or a device restart. Android sleep and battery policy can delay delivery; reopen the app and re-enable alerts after a restart. Events that cannot be decrypted when sync receives them may appear in the conversation later without an alert. This sideload alpha declares the specific foreground activity as `specialUse`; store distribution and physical-device delivery require further review.

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
