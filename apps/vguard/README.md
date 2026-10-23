# VGuard 0.1.3 candidate — Vellivex

Experimental Android 10+ selective local-VPN firewall. It discards packets for explicitly selected app identities and does not open remote sockets. This candidate has no INTERNET permission, account or analytics SDK.

## Security changes

0.1.3 validates export picker results as writable content documents and checks the grant again before writing. It retains 0.1.2's revocation/package-identity race fixes, secure window and backup exclusions. Host attack tests cover malformed packets, concurrent lifecycle transitions and hostile export targets.

## Install only for controlled evaluation

Download the current candidate from https://www.vellivex.com/apps/guard. Check the published APK SHA-256 and signing certificate. Use a spare test device and non-sensitive activity. Follow the block/allow/stop comparisons in `device-qa/README.md`; a failed network request alone does not prove filtering.

Select at least one app, choose a manual Normal or Journey profile, and approve Android's VPN request. Android has one VPN slot; this can replace another VPN. Stopping the service or losing consent/process ends filtering. There is no always-on, lockdown or automatic restart. Destination metadata is kept in a bounded in-memory history and exported only to a document you select. A blocked app can queue data for later transmission.

## Reproduce host attack checks

```sh
bash tests/adversarial/run-adversarial-tests.sh
python3 validation/UI-Logic-Checks.py
```

The harness compiles actual engine/parser/export-policy code with controlled Android API stubs. It does not establish kernel routing, grant enforcement, device battery behavior or provider compatibility.

## Build from source

Use JDK 17+ and official Android platform 36/build-tools 36.0.0:

```sh
python3 build.py --sdk /absolute/path/to/android-sdk
```

Output: `build/VGuard-0.1.3-candidate.apk`. A local build defaults to a new private `.local-signing/` identity and cannot update an official candidate. Keep that directory out of public source. Official updates must use the original private key with `--require-existing-key` and `--expected-cert-sha256`; never regenerate the update identity or publish key/password files. No third-party libraries or network downloads are required by the build script.

## Remaining release gates

Actual Android routing/permission/lifecycle behavior, IPv4/IPv6 and DNS, file-provider compatibility, upgrades, accessibility, physical devices and independent expert review remain outstanding. This is not an audited product or a claim of complete protection. Original source is GPL-3.0-or-later; see LICENSE and NOTICE.
