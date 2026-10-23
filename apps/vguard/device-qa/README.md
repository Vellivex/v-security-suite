# Android runtime checks

These are separate, minimal instrumentation applications. They are **not** compiled into VGuard. The regular Blocked and Allowed probes have separate packages and Android UIDs, so one can be selected in the firewall while the other keeps its connection. The optional shared-UID probes deliberately test a different case, described below.

Use an isolated Android emulator or a test device. Never assume a failed connection proves firewall behaviour without first showing that the same endpoint is reachable while filtering is off.

## Build and run

From the VGuard source directory:

```sh
python3 device-qa/build-probes.py --sdk /path/to/android-sdk \
  --keystore /private/path/VGuard-signing.p12 \
  --password-file /private/path/VGuard-signing.pass

python3 device-qa/http-server.py
```

The server returns a constant string and exposes no files. Run it in the same network environment as the Android emulator. The standard emulator host address is `10.0.2.2`.

In another terminal in that same environment:

```sh
adb install build/VGuard-0.1.3-candidate.apk
adb install build/qa-probes/VGuard-QA-blocked.apk
adb install build/qa-probes/VGuard-QA-allowed.apk

adb shell am instrument -w -e url http://10.0.2.2:18789/check \
  app.vguard.qa.blocked/app.vguard.qa.Probe

adb shell am instrument -w -e url http://10.0.2.2:18789/check \
  app.vguard.qa.allowed/app.vguard.qa.Probe
```

The semantic result is `outcome=CONNECTED` or `outcome=NO_CONNECTION`. The instrument runner itself may complete successfully in either case; its process exit code is not the connection assertion.

## Required comparisons

1. With VGuard off, both probes must return `CONNECTED`.
2. Select only **VGuard QA Blocked** through VGuard's normal interface. Cancel the VPN prompt once. The UI must remain OFF and the probe must still connect.
3. Start and approve the VPN. The selected probe must return `NO_CONNECTION`, the unselected probe must return `CONNECTED`, and the Activity view must show real discarded packet metadata.
4. Stop VGuard. The previously selected probe must return `CONNECTED` again.
5. Exercise a separate Journey selection, then switch profiles while active. The newly selected app must be blocked and the previously selected app must reconnect.
6. Remove the final selection. The UI must stop blocking; no unselected app should lose its connection.
7. Force-stop and reopen VGuard. The status must be OFF; it must not reconstruct ACTIVE from saved preferences.
8. Uninstall the final selected probe while the firewall is active. The package-change handler must stop with an explicit error, and unselected traffic must continue.

Check IPv6 separately using a reachable controlled IPv6 endpoint when the test network supplies one. If there is no working baseline IPv6 route, record that limitation. Observing an IPv6 packet being discarded confirms its route into the local VPN, but it does not establish end-to-end IPv6 network availability.

## TCP, UDP, DNS and pre-existing connections

Run the additional controlled server in the **same host network environment** as the emulator:

```sh
python3 device-qa/protocol-server.py
```

It serves bounded token exchanges on TCP port 18790 and UDP port 18791. It does not read files or forward traffic. Both IPv4 and IPv6 listeners are available, but the guest must have a working route to the chosen address before that address can establish an enforcement result.

```sh
adb shell am instrument -w -e mode tcp -e host 10.0.2.2 \
  app.vguard.qa.blocked/app.vguard.qa.Probe
adb shell am instrument -w -e mode udp -e host 10.0.2.2 \
  app.vguard.qa.blocked/app.vguard.qa.Probe
```

Use the same baseline / selected / unselected / stop comparisons for each protocol. `UNEXPECTED_RESPONSE` or `PROBE_ERROR` is not a successful block. A `NO_CONNECTION` result only establishes blocking when the matching reachable baseline and unselected control pass.

`-e mode underlying_http` enumerates visible non-VPN Android `Network` objects and attempts the same controlled HTTP request through each network's socket factory. The separate test APK requests `ACCESS_NETWORK_STATE` for this check; VGuard itself does not gain that permission. Verify an off-state success before activating blocking. While selected, an observed success here would be a route-bypass failure. `NO_UNDERLYING_NETWORK` records that no eligible network was exposed to the probe; it is not an attempted-connection result. The output includes each tried network and outcome. Repeat with the unselected control.

To test an already-established TCP connection, launch this while filtering is off, verify an initial `CONNECTED` status, and activate the rule during the sequence:

```sh
adb shell am instrument -w -e mode tcp_persist -e host 10.0.2.2 \
  -e attempts 60 -e interval_ms 1000 -e timeout_ms 1500 \
  app.vguard.qa.blocked/app.vguard.qa.Probe
```

This mode opens one socket and never reconnects. Each attempt emits its outcome with elapsed times. `SERIES_COMPLETE` means the sequence ended, not that enforcement passed. If the first connection failed, the sequence cannot prove handling of an existing connection. `tcp`, `udp` and `http` support the same bounded attempt parameters and open a new connection/socket for each attempt.

The `resolve` mode invokes Android's ordinary name resolver and reports the resulting addresses:

```sh
adb shell am instrument -w -e mode resolve -e host UNIQUE.vguard.test \
  app.vguard.qa.blocked/app.vguard.qa.Probe
```

The optional server argument `--dns-port PORT` enables DNS over UDP and TCP. It only answers names within `vguard.test`, uses zero TTL, returns the host address configured by `--ipv4-host` (default `10.0.2.2`), and supplies AAAA records only when `--ipv6-host` is explicitly configured. Unrelated names are refused with NXDOMAIN; nothing is forwarded. Android must actually use that resolver for these names. The emulator's normal `-dns-server` configuration uses port 53; binding it may be unavailable in an unprivileged host. A DNS server on another port does not by itself make Android's resolver use it. Do not claim the resolver test passed without a verified off-state lookup and matching selected/unselected comparisons. Account for caching and record the actual name and returned address.

## Service permission and shared Android identities

Run `-e mode service_access` from either regular probe to attempt a normal bind to VGuard's VPN service. The probe has no `BIND_VPN_SERVICE` permission. Only an observed `PERMISSION_DENIED` result verifies the expected permission rejection; `BIND_REFUSED` or `PROBE_ERROR` needs separate explanation. The test never calls VPN control methods.

Building with `--shared-uid` also creates `VGuard-QA-shared_one.apk` and `VGuard-QA-shared_two.apk`. They deliberately request the same Android shared user ID and use the same signing certificate. Verify Android actually assigns them the same UID before drawing a shared-identity conclusion. On an Android version that rejects or separates this deprecated arrangement, record the case as unsupported in that environment.

Install only Shared One, select it and activate VGuard, then install Shared Two. Because the new unselected sibling would inherit that UID's route, VGuard must detect the scope change and stop with an explicit error. Installing an ordinary unselected app with a different UID must not restart or stop the active session. With both shared packages installed, selecting only one must fail clearly; selecting both may establish the shared-UID block. Keep the independent Allowed probe as the connectivity control.

Keep screenshots, exact probe results, the tested APK SHA-256, Android version, and remaining limitations with the validation record. These checks are useful functional evidence, not a security audit or a substitute for verifying the user's own phone.
