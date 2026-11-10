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
test "$size" -ge 30000
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
echo "VGuard Android manifest: package=${package:-missing}; version=${version:-unspecified}; launcher=${launch:-missing}"
if [[ "$package" != 'app.vguard.firewall' ]]; then
  echo "FAIL VGuard: APK package name differs from the published VGuard Android package" >&2
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

if printf '%s\n' "$permissions" | grep -Fq "name='android.permission.INTERNET'"; then
  echo 'FAIL VGuard: APK unexpectedly requests direct Internet access.' >&2
  exit 1
fi
compiledManifest=$("$aapt" dump xmltree "$APK" AndroidManifest.xml)
if ! grep -Fq 'android.permission.BIND_VPN_SERVICE' <<< "$compiledManifest" ||
   ! grep -Fq 'android.net.VpnService' <<< "$compiledManifest"; then
  echo 'FAIL VGuard: compiled APK does not declare the protected Android VPN service.' >&2
  exit 1
fi
echo 'PASS VGuard: compiled APK requests no direct Internet access and declares the protected Android VPN service.'

# Routine checks stop at the APK/package boundary. The previously verified
# emulator run is an explicit free manual option, not a recurring large download.
if [[ "${VGUARD_RUN_EMULATOR:-false}" != 'true' ]]; then
  echo 'NOTICE VGuard: emulator run not requested; Android installation and live firewall operation not checked in this routine run.'
  exit 0
fi

# Run Android in an isolated free GitHub runner, never on a personal device.
# Install only official no-charge SDK components using licences already accepted
# by the runner. Do not agree to new licences, buy credit or enable paid services.
emulator="$sdk/emulator/emulator"
avdmanager=$(find "$sdk/cmdline-tools" -maxdepth 4 -type f -name avdmanager -perm /111 2>/dev/null | sort -V | tail -1 || true)
sdkmanager=$(find "$sdk/cmdline-tools" -maxdepth 4 -type f -name sdkmanager -perm /111 2>/dev/null | sort -V | tail -1 || true)
kvm='no'
[[ -e /dev/kvm ]] && kvm='yes'
echo "VGuard emulator prerequisites: emulator=$([[ -x "$emulator" ]] && echo available || echo missing); avdmanager=$([[ -n "$avdmanager" && -x "$avdmanager" ]] && echo available || echo missing); KVM=${kvm}"
if [[ ! -x "$avdmanager" || ! -e /dev/kvm ]]; then
  echo 'NOTICE VGuard: accelerated Android emulator prerequisites unavailable; installation and launch remain UNTESTED.'
  exit 0
fi
image=''
while IFS= read -r item; do
  if [[ -e "$item/system.img" ]]; then image="$item"; break; fi
done < <(find "$sdk/system-images" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | sort -Vr)
if [[ ! -x "$emulator" || -z "$image" ]]; then
  if [[ ! -x "$sdkmanager" ]]; then
    echo 'NOTICE VGuard: official Android SDK package manager unavailable. Emulator install/launch UNTESTED.'
    exit 0
  fi
  echo 'NOTICE VGuard: installing free official Android emulator and API 35 image, using only previously accepted SDK licences.'
  sdklog="${RUNNER_TEMP:-/tmp}/vellivex-sdk-install.log"
  if ! timeout 360 "$sdkmanager" --sdk_root="$sdk" --install 'emulator' 'system-images;android-35;google_apis;x86_64' < /dev/null > "$sdklog" 2>&1; then
    echo 'NOTICE VGuard: free Android emulator components were unavailable without further setup. Emulator install/launch UNTESTED.'
    tail -n 8 "$sdklog" | sed -E 's/[[:cntrl:]]//g'
    exit 0
  fi
  echo 'PASS VGuard: official free Android emulator components installed on temporary runner.'
  image="$sdk/system-images/android-35/google_apis/x86_64"
fi
if [[ ! -x "$emulator" || ! -e "$image/system.img" ]]; then
  echo 'NOTICE VGuard: emulator packages incomplete. Installation and launch remain UNTESTED.'
  exit 0
fi
rel="${image#"$sdk/"}"
IFS=/ read -r _ android api abi <<< "$rel"
avd='vellivex-vguard-qa'
# Align AVD discovery for avdmanager and emulator on ephemeral hosted runners.
export ANDROID_AVD_HOME="${RUNNER_TEMP:-/tmp}/vellivex-avds"
export ANDROID_USER_HOME="${RUNNER_TEMP:-/tmp}/vellivex-android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME"
avd_dir="$ANDROID_AVD_HOME/$avd.avd"
echo "Using official Android system image ${android}/${api}/${abi}."
echo no | "$avdmanager" create avd --force --name "$avd" --package "system-images;${android};${api};${abi}" --path "$avd_dir" --device pixel_2 >/dev/null
if [[ ! -f "$ANDROID_AVD_HOME/$avd.ini" && -f "$avd_dir/config.ini" ]]; then
  printf 'avd.ini.encoding=UTF-8\npath=%s\ntarget=android-35\n' "$avd_dir" > "$ANDROID_AVD_HOME/$avd.ini"
fi
if ! "$emulator" -list-avds | grep -Fxq "$avd"; then
  echo 'FAIL VGuard: Android emulator could not discover the newly created AVD.' >&2
  find "$ANDROID_AVD_HOME" -maxdepth 2 -type f -name '*.ini' -printf '%P\n' | head -n 20 >&2
  exit 1
fi
echo 'PASS VGuard: official Android 15 virtual device is registered and discoverable.'
# KVM on hosted Linux runners can exist but be owned by an inaccessible group.
# Grant only the isolated runner's primary group access, never world access.
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo chgrp "$(id -gn)" /dev/kvm
    sudo chmod 0660 /dev/kvm
  fi
fi
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo 'FAIL VGuard emulator: GitHub runner cannot access /dev/kvm.' >&2
  exit 1
fi
echo 'PASS VGuard: temporary runner can access hardware virtualisation without broadening KVM permissions.'
"$emulator" -avd "$avd" -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -accel on > "${RUNNER_TEMP:-/tmp}/vellivex-emulator.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -f "$APK"' EXIT
if ! timeout 135 "$sdk/platform-tools/adb" wait-for-device; then
  echo 'FAIL VGuard: Android emulator did not appear over ADB. Emulator boot diagnostics:' >&2
  tail -n 45 "${RUNNER_TEMP:-/tmp}/vellivex-emulator.log" | sed -E 's/[[:cntrl:]]//g' >&2 || true
  exit 1
fi
booted=''
for ((i=0;i<50;i++)); do
  booted=$("$sdk/platform-tools/adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [[ "$booted" == '1' ]] && break
  sleep 3
done
if [[ "$booted" != '1' ]]; then
  echo 'FAIL VGuard: Android emulator did not complete startup.' >&2
  tail -n 45 "${RUNNER_TEMP:-/tmp}/vellivex-emulator.log" | sed -E 's/[[:cntrl:]]//g' >&2 || true
  exit 1
fi
"$sdk/platform-tools/adb" install -r "$APK" >/dev/null
echo 'PASS VGuard: APK installed on a clean Android emulator.'
"$sdk/platform-tools/adb" shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 3
if ! "$sdk/platform-tools/adb" shell pidof "$package" | grep -Eq '[0-9]+'; then
  echo 'FAIL VGuard: app process did not remain running after launcher start.' >&2
  exit 1
fi
echo 'PASS VGuard: app launched and remained running in Android emulator. VPN permission request and firewall operation remain UNTESTED.'
if [[ "${VGUARD_PROBE_BASELINES:-false}" == 'true' ]]; then
  echo 'Starting local-only probe baseline checks; firewall must remain OFF.'
  bash scripts/vguard-probe-baselines.sh "$sdk"
fi

