#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Read-only APK/package smoke check; does not activate firewall or access device data.
set -euo pipefail

URL='https://www.vellivex.com/downloads/VGuard-0.1.4-candidate.apk'
EXPECTED_SHA='5cc966d7819550974b4e9427a912c9587f2a1f4f30e45c7a6b29f27f2a41a786'
APK="${RUNNER_TEMP:-/tmp}/vellivex-vguard-candidate.apk"
trap 'rm -f "$APK"' EXIT

curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
  --connect-timeout 15 --max-time 90 --retry 2 --output "$APK" "$URL"
size=$(stat -c%s "$APK")
actual=$(sha256sum "$APK" | cut -d' ' -f1)
mime=$(file --brief --mime-type "$APK")
echo "VGuard public APK: bytes=${size}; sha256=${actual}; type=${mime}"
if [[ "$actual" != "$EXPECTED_SHA" ]]; then
  echo "FAIL VGuard: downloaded APK does not match the published candidate SHA-256." >&2
  exit 1
fi
test "$size" -ge 100000
test "$size" -le 50000000
echo "PASS VGuard: public candidate APK downloaded over HTTPS; exact published SHA-256 matched; size ${size} bytes."

unzip -tqq "$APK" >/dev/null
unzip -Z1 "$APK" | grep -Fxq 'AndroidManifest.xml'
unzip -Z1 "$APK" | grep -Eq '^classes([0-9]+)?\.dex$'
echo 'PASS VGuard: APK archive structure, manifest and executable DEX files verified.'

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
test -n "$sdk" && test -d "$sdk/build-tools"
aapt=$(find "$sdk/build-tools" -maxdepth 2 -type f -name aapt -perm /111 | sort -V | tail -1)
apksigner=$(find "$sdk/build-tools" -maxdepth 2 -type f -name apksigner -perm /111 | sort -V | tail -1)
test -n "$aapt" && test -x "$aapt"
test -n "$apksigner" && test -x "$apksigner"

"$apksigner" verify --verbose --print-certs "$APK" | sed -n '/Verified using/p;/Number of signers/p;/Signer #1 certificate SHA-256 digest/p'
echo 'PASS VGuard: APK signature verifies using Android SDK build tools.'

badging=$("$aapt" dump badging "$APK")
package=$(printf '%s\n' "$badging" | sed -nE "s/^package: name='([^']+)'.*/\1/p" | head -1)
version=$(printf '%s\n' "$badging" | sed -nE "s/^package: name='[^']+' versionCode='[^']+' versionName='([^']+)'.*/\1/p" | head -1)
launch=$(printf '%s\n' "$badging" | sed -nE "s/^launchable-activity: name='([^']+)'.*/\1/p" | head -1)
if [[ ! "$package" =~ ^com\.vellivex\.[A-Za-z0-9_.]+$ ]]; then
  echo "FAIL VGuard: unexpected application package prefix" >&2
  exit 1
fi
test -n "$launch"
echo "PASS VGuard: package identity ${package}, version ${version:-unspecified}, and launchable Android activity verified."

permissions=$("$aapt" dump permissions "$APK")
for forbidden in android.permission.READ_SMS android.permission.READ_CALL_LOG android.permission.READ_CONTACTS android.permission.ACCESS_FINE_LOCATION android.permission.RECORD_AUDIO; do
  if printf '%s\n' "$permissions" | grep -Fq "name='${forbidden}'"; then
    echo "FAIL VGuard: unexpected sensitive permission ${forbidden}" >&2
    exit 1
  fi
done
echo 'PASS VGuard: no SMS, call log, contacts, precise location or microphone read permission requested.'

# Only use an Android system image already present on the free GitHub runner.
# Never accept SDK licences, create paid resources or download an emulator image.
emulator="$sdk/emulator/emulator"
avdmanager="$sdk/cmdline-tools/latest/bin/avdmanager"
if [[ ! -x "$emulator" || ! -x "$avdmanager" || ! -e /dev/kvm ]]; then
  echo 'NOTICE VGuard: no preinstalled accelerated Android emulator available; installation and launch remain UNTESTED.'
  exit 0
fi
image=''
while IFS= read -r item; do
  if [[ -e "$item/system.img" ]]; then image="$item"; break; fi
done < <(find "$sdk/system-images" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | sort -Vr)
if [[ -z "$image" ]]; then
  echo 'NOTICE VGuard: no preinstalled Android system image; installation and launch remain UNTESTED.'
  exit 0
fi
rel="${image#"$sdk/"}"
IFS=/ read -r _ android api abi <<< "$rel"
avd='vellivex-vguard-qa'
echo "Using preinstalled Android system image ${android}/${api}/${abi}."
echo no | "$avdmanager" create avd --force --name "$avd" --package "${android};${api};${abi}" --device pixel_2 >/dev/null
"$emulator" -avd "$avd" -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -accel on > "${RUNNER_TEMP:-/tmp}/vellivex-emulator.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -f "$APK"' EXIT
"$sdk/platform-tools/adb" wait-for-device
booted=''
for ((i=0;i<50;i++)); do
  booted=$("$sdk/platform-tools/adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [[ "$booted" == '1' ]] && break
  sleep 3
done
if [[ "$booted" != '1' ]]; then echo 'FAIL VGuard: Android emulator failed to boot.' >&2; exit 1; fi
"$sdk/platform-tools/adb" install -r "$APK" >/dev/null
echo 'PASS VGuard: APK installed on a clean Android emulator.'
"$sdk/platform-tools/adb" shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 3
if ! "$sdk/platform-tools/adb" shell pidof "$package" | grep -Eq '[0-9]+'; then
  echo 'FAIL VGuard: app process did not remain running after launcher start.' >&2
  exit 1
fi
echo 'PASS VGuard: app launched and remained running in Android emulator. VPN permission request and firewall operation remain UNTESTED.'
