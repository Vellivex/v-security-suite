#!/usr/bin/env bash
set -euo pipefail
umask 077
export JAVA_HOME="${JAVA_HOME_21_X64:?}"
export PATH="$JAVA_HOME/bin:$PATH"
work=$(mktemp -d "$RUNNER_TEMP/release-probe.XXXXXXXX")
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
sdk="$ANDROID_HOME/cmdline-tools/latest/bin"
bt="$ANDROID_HOME/build-tools/36.0.0"
adb="$ANDROID_HOME/platform-tools/adb"
image='system-images;android-35;google_apis;x86_64'
"$sdk/sdkmanager" --install 'platform-tools' 'platforms;android-36' 'build-tools;35.0.0' 'build-tools;36.0.0' 'emulator' "$image"
(cd apps/messenger/android && ./gradlew --no-daemon --max-workers=2 "-PmatrixSdkAar=$RUNNER_TEMP/sdk/vellivex-matrix-sdk.aar" :app:assembleDebug :app:assembleDebugAndroidTest)
debug=$(find apps/messenger/android/app/build/outputs/apk/debug -name '*arm64-v8a*debug.apk' -print -quit)
test -f "$debug"
instrument=apps/messenger/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
test -s "$instrument"
curl --fail --silent --show-error --location --proto '=https' --max-time 150 -o "$work/original.apk" https://www.vellivex.com/downloads/Vellivex-Messenger-0.1.0-alpha08-arm64.apk
echo "95661c6ea7f8b5d40e9fd6ba6797a5a2f6b276f681369420b4e55348784579e4  $work/original.apk" | sha256sum -c -
"$bt/apksigner" verify --print-certs "$work/original.apk" | grep -F 'Signer #1 certificate SHA-256 digest: 3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2'
# Instrumentation must share a certificate with the non-debuggable target.
# Both copies and the throwaway certificate remain within this ephemeral runner.
keytool -genkeypair -keystore "$work/qa.p12" -storepass ephemeral -keypass ephemeral -alias qa -keyalg RSA -keysize 2048 -validity 2 -dname CN=Vellivex-QA-Native-Diagnostic
"$bt/apksigner" sign --ks "$work/qa.p12" --ks-pass pass:ephemeral --v4-signing-enabled false --out "$work/qa.apk" "$work/original.apk"
"$bt/apksigner" sign --ks "$work/qa.p12" --ks-pass pass:ephemeral --v4-signing-enabled false --out "$work/test.apk" "$instrument"
python3 - "$work" "$debug" <<'PY'
import hashlib, pathlib, re, sys, zipfile
root=pathlib.Path(sys.argv[1])
def payload(name):
    with zipfile.ZipFile(root/name) as apk:
        return {p:hashlib.sha256(apk.read(p)).hexdigest() for p in apk.namelist()
                if not re.fullmatch(r'META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))',p,re.I)}
original=payload('original.apk')
assert original == payload('qa.apk')
assert original['lib/arm64-v8a/libmatrix_sdk_ffi.so']=='ab78268c932792091e8431709b6c21d452ee4579e63a474d77e2e592aad5ca22'
print('Verified identical APK payload entries:',len(original))
with zipfile.ZipFile(sys.argv[2]) as app:
    for name in ('libmatrix_sdk_ffi.so','libjnidispatch.so'):
        path='lib/arm64-v8a/'+name
        print(name,'released='+original[path],'source-rebuilt='+hashlib.sha256(app.read(path)).hexdigest())
PY
"$bt/apksigner" verify "$work/qa.apk"
"$bt/apksigner" verify "$work/test.apk"
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  sudo chown "$(id -u):$(id -g)" /dev/kvm
  sudo chmod u+rw /dev/kvm
fi
export ANDROID_AVD_HOME="$work/avd"
mkdir -p "$ANDROID_AVD_HOME"
printf 'no\n' | "$sdk/avdmanager" create avd -n vx-probe -k "$image"
"$ANDROID_HOME/emulator/emulator" -avd vx-probe -port 5554 -accel on -memory 2048 -cores 2 -gpu swiftshader -no-window -no-audio -no-snapshot -no-boot-anim > "$work/emulator.log" 2>&1 &
pid=$!
device=emulator-5554
for i in {1..120}; do
  booted=$(timeout 4 "$adb" -s "$device" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
  [[ "$booted" == 1 ]] && break
  sleep 2
done
test "$booted" = 1
bridge=$("$adb" -s "$device" shell getprop ro.dalvik.vm.native.bridge | tr -d '\r')
test -n "$bridge" && test "$bridge" != 0
"$bt/apksigner" sign --ks "$work/qa.p12" --ks-pass pass:ephemeral --v4-signing-enabled false --out "$work/debug.apk" "$debug"
tests='com.vellivex.messenger.MessengerProductionHttpsTest,com.vellivex.messenger.ReleaseNativeStoreProbe'
if "$adb" -s "$device" shell pm path com.vellivex.messenger.alpha | grep -q '^package:'; then exit 1; fi
result=0
for target in release debug; do
  app="$work/qa.apk"
  if [[ "$target" == debug ]]; then app="$work/debug.apk"; fi
  "$adb" -s "$device" install -t --abi arm64-v8a "$app"
  "$adb" -s "$device" install -t "$work/test.apk"
  "$adb" -s "$device" shell dumpsys package com.vellivex.messenger.alpha | grep -m1 'primaryCpuAbi=arm64-v8a'
  echo "Testing $target payload on Android 35 ARM64 translation: $bridge"
  timeout 180 "$adb" -s "$device" shell am instrument -w -r -e probeTarget "$target" -e class "$tests" com.vellivex.messenger.alpha.test/androidx.test.runner.AndroidJUnitRunner > "$work/result-$target"
  grep -E '^INSTRUMENTATION_STATUS: test=|^INSTRUMENTATION_STATUS_CODE:|^OK \( |^OK \(|^Tests run:|^INSTRUMENTATION_CODE:' "$work/result-$target" || true
  if ! grep -Eq '^OK \(3 tests\)' "$work/result-$target"; then
    grep 'NATIVE-DIAG stage=' "$work/result-$target" | head -10 || true
    result=1
  fi
  "$adb" -s "$device" uninstall com.vellivex.messenger.alpha.test
  "$adb" -s "$device" uninstall com.vellivex.messenger.alpha
done
exit "$result"
