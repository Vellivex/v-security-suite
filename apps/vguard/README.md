# 0.1.2 candidate security update

The current source fixes revocation and package-identity startup races, adds screenshot/privacy flags and Android backup/transfer exclusions. It was rebuilt and signature-verified with the original update identity. Real-device enforcement and independent audit are still outstanding. See the root security hardening report and current candidate release notes.

# VGuard — 0.1.1 preview

A native Android app firewall in the V black/charcoal brand, with an original V-and-shield mark and muted olive status accents.

## What this build does

- Choose installed apps whose direct internet traffic should be blocked.
- Start and stop local filtering through Android's VPN permission screen.
- Keep separate **Normal** and **Journey** app selections. Profile changes apply immediately while running.
- View actual discarded-packet counts, byte counts, and recent destination/protocol metadata.
- Clear the recent activity or export it as CSV through Android's file picker.
- Open Android's app, VPN, and notification settings.

Journey is a **manually selected profile** in this version. There is no USB/car connection automation.

## Install and first check

1. On your Android phone, open `VGuard-0.1.1-preview.apk`. If Android asks, allow the browser or file manager you are using to install this APK. You can remove that install permission afterwards. This uses the original VGuard signing key and can update the 0.1.0 installation without uninstalling it.
2. Open **VGuard → Apps** and turn on **Block** for one ordinary app you can safely test, such as a second browser. Apps are not blocked until you start the service.
3. Open **Overview → Start blocking → Continue**, then approve Android's VPN connection request. If you cancel, filtering stays off.
4. Confirm the status becomes **ACTIVE**. Check that the selected app cannot load new online content and that an unselected app can still connect.
5. Tap **Stop blocking** and confirm the selected app connects again.
6. To keep VGuard's status and Stop control in your notification area, use **Settings → Status notification** and allow the notification.

Start with a nonessential app. System apps are hidden by default; their shared functions can affect calls or updates. A shared Android UID may prevent a package from being blocked separately; VGuard reports this instead of silently affecting another package.

## Scope and limits

This is a development preview. It uses a real Android `VpnService`, not a web simulation. The included validation record distinguishes compiled/unit-tested behaviour from Android runtime checks. A check on your own phone is still required before relying on its rules.

For 0.1.1, the automated parser/rule, simulated engine and CSV checks passed, and the exact signed APK installed successfully on Android 15. Android platform startup failures prevented the available emulator from launching VGuard. Live VPN enforcement and native UI behavior remain unverified; see `validation/Test-Summary-0.1.1.txt` and `validation/Android-Runtime.txt` for the exact results and outstanding acceptance tests.

VGuard routes the selected apps into a local discard-only VPN. Other apps keep their normal connection. This occupies the VPN slot in the current Android user/profile, so starting VGuard can replace a separate VPN. It does not provide a remote VPN connection or hide your phone's cellular identity.

Blocking ends when you stop VGuard, Android revokes the VPN, the process ends, or a reconfiguration fails. This version deliberately does not offer always-on VPN, Android's “Block connections without VPN” setting, boot activation, or automatic restart. An error explicitly shows that blocking has ended.

The firewall controls routed IP traffic. It does not revoke camera, microphone, location, or file permissions; diagnose spyware; control another device; or stop a permitted app from relaying data for another app. A blocked app can retain information and send it when you restore access. OS-level or special system traffic is outside the protection claim.

On GrapheneOS, the built-in **Network** permission is the stronger option for an app that should remain offline and also leaves the VPN slot free. VGuard cannot change another app's permissions automatically.

## Data handling

VGuard has **no INTERNET permission**, no analytics, no account, and no remote service. It never forwards packets or opens an outbound network socket. The selected package names are saved in private preferences, with Android application backup disabled.

Only packet headers are parsed for the activity view. Payloads and message contents are not recorded. The last 200 metadata entries remain in memory for the lifetime of the app process. They do not identify the individual originating app: the display honestly uses “Selected app.” The on-screen list shows up to the latest 100 entries; CSV export includes the current memory snapshot, up to 200. Counts are discarded packets, not detected threats.

Exporting activity creates a CSV at the location you explicitly choose. That exported file persists separately and may reveal destinations and times; handle it as personal data.

## Build from source

Requirements: Python 3, JDK 17 or newer, and the official Android SDK with **build-tools 36.0.0** and **platform android-36**. No Gradle, third-party application dependencies, or automatic downloads are needed. The app compiles against API 36 and targets API 35, with minimum API 29 (Android 10).

```sh
python3 build.py --sdk /absolute/path/to/android-sdk
```

The output is `build/VGuard-0.1.1-preview.apk`. By default, the script generates a unique local signing key in `.local-signing/`. Keep it private. APKs signed with different keys cannot update each other while preserving the existing installation.

To build an update with the original signing identity, use the separately supplied private update-key backup:

```sh
python3 build.py --sdk /absolute/path/to/android-sdk \
  --keystore /private/path/VGuard-signing.p12 \
  --password-file /private/path/VGuard-signing.pass
```

The signing password is read from a file and never printed. Signing materials are intentionally absent from this source archive. Never publish the private update-key backup with the source.

### Core checks

```sh
bash tests/run-core-tests.sh /absolute/path/to/jdk/bin \
  /absolute/path/to/android-sdk/platforms/android-36/android.jar
```

These test packet header bounds, IPv4 and IPv6 metadata, fragmentation/extensions, hostile inputs, package sanitation, self exclusion, and safe rule defaults. They do not replace device routing tests.

`device-qa/` contains the separate instrumentation probe source used for controlled Android network tests. It is not included in the VGuard application. `validation/` records the checks performed for the delivered build.

## Architecture

`MainActivity` uses native Android views and the explicit VPN consent flow. `RuleStore` saves the two package selections. `GuardService` passes the selected packages to `VpnService.Builder.addAllowedApplication()`—Android calls these allowed into the VPN, where VGuard discards them. IPv4 and IPv6 default routes and local discard DNS addresses cover the selected traffic. There is no traffic-forwarding stack.

An empty effective package list must never reach `establish()`, because Android would otherwise route every app into the VPN. VGuard validates the selection immediately before establishment, skips removed packages, excludes itself, and refuses an empty result. Session tokens prevent a retired packet reader from changing a newer session's counters. Replacement establishment precedes closing the old descriptor.

## Platform references

- Android VPN API and per-app routing: https://developer.android.com/develop/connectivity/vpn
- Android foreground service types: https://developer.android.com/develop/background-work/services/fgs/service-types
- GrapheneOS Network permission: https://grapheneos.org/features#network-permission-toggle

This source archive does not include Android SDK binaries or a signing private key.
