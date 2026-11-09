#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Re-run published VGuard production-source JVM and adversarial checks.
# No real devices, user files, accounts, internet calls or paid services.
set -euo pipefail
URL='https://www.vellivex.com/downloads/VGuard-Source-GPL.zip'
SHA='abf4b7aec5b8848418a8abbb5b67ebbc6fceb009a5ff9e1c7146d528ee23bcfe'
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
  --connect-timeout 15 --max-time 90 --retry 2 --output "$root/source.zip" "$URL"
actual=$(sha256sum "$root/source.zip" | cut -d' ' -f1)
if [[ "$actual" != "$SHA" ]]; then
  echo 'FAIL VGuard source: ZIP differs from the published SHA-256' >&2
  exit 1
fi
unzip -tqq "$root/source.zip" >/dev/null
unzip -q "$root/source.zip" -d "$root"
cd "$root/VGuard"
echo 'PASS VGuard: GPL source ZIP matches the published SHA-256 and opens correctly.'

manifest=app/src/main/AndroidManifest.xml
grep -Fq 'android.permission.BIND_VPN_SERVICE' "$manifest"
grep -Fq 'android.net.VpnService' "$manifest"
grep -Fq 'android:allowBackup="false"' "$manifest"
if grep -Fq '<uses-permission android:name="android.permission.INTERNET"' "$manifest"; then
  echo 'FAIL VGuard: unexpected INTERNET permission in source manifest' >&2
  exit 1
fi
echo 'PASS VGuard: source declares guarded Android VpnService, backup disabled and no INTERNET permission.'

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
test -n "$sdk" && test -d "$sdk/platforms"
androidJar=$(find "$sdk/platforms" -maxdepth 2 -type f -name android.jar | sort -V | tail -1)
test -n "$androidJar" && test -f "$androidJar"
bin=$(dirname "$(command -v javac)")
echo 'Running production VGuard parser and rule-store JVM tests.'
timeout 180 bash tests/run-core-tests.sh "$bin" "$androidJar"
echo 'PASS VGuard: production parser and rule-store core JVM tests completed.'

echo 'Running production VGuard firewall engine and adversarial cases with Android framework stubs.'
timeout 240 bash tests/adversarial/run-adversarial-tests.sh
echo 'PASS VGuard: source engine adversarial and lifecycle regression tests completed.'

echo 'Running VGuard UI logic checks from the published source archive.'
timeout 120 python3 validation/UI-Logic-Checks.py
echo 'PASS VGuard: UI source logic checks completed.'
echo 'VGuard host regression suite finished; this does not prove live VPN routing, Android installation or physical-device behaviour.'
