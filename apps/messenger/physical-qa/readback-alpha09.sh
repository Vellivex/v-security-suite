#!/usr/bin/env bash
set -euo pipefail
umask 077
work=$(mktemp -d "$RUNNER_TEMP/verify-alpha09.XXXXXXXX")
pid=''
cleanup() { if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi; rm -rf -- "$work"; }
trap cleanup EXIT
bt="$ANDROID_HOME/build-tools/36.0.0"
sdk="$ANDROID_HOME/cmdline-tools/latest/bin"
adb="$ANDROID_HOME/platform-tools/adb"
serial=emulator-5554
app=com.vellivex.messenger.alpha
expected=eab2468488a6a34451a47bc0e5dda2ed51e8dcf2f8fed191fadf97ebb55e1471
image='system-images;android-35;google_apis;x86_64'
cd "$work"
curl --proto '=https' --fail --location --silent --show-error --max-time 150 --output alpha09.apk https://www.vellivex.com/downloads/Vellivex-Messenger-0.1.0-alpha09-universal.apk
echo "$expected  alpha09.apk" | sha256sum --strict --check -
test "$(stat -c %s alpha09.apk)" = 111794192
"$sdk/sdkmanager" 'platform-tools' 'emulator' 'build-tools;36.0.0' "$image"
"$bt/apksigner" verify --print-certs alpha09.apk | grep -F 'Signer #1 certificate SHA-256 digest: 3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2'
export ANDROID_AVD_HOME="$work/avd"
mkdir -p "$ANDROID_AVD_HOME"
test -c /dev/kvm
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then sudo chown "$(id -u):$(id -g)" /dev/kvm; sudo chmod u+rw /dev/kvm; fi
printf 'no\n' | "$sdk/avdmanager" create avd -n verify-alpha09 -k "$image"
"$adb" start-server
"$ANDROID_HOME/emulator/emulator" -avd verify-alpha09 -port 5554 -accel on -memory 1536 -cores 2 -gpu swiftshader -no-window -no-audio -no-snapshot -no-boot-anim > "$work/avd.log" 2>&1 &
pid=$!
device() { timeout 90 "$adb" -s "$serial" "$@"; }
prop() { timeout 6 "$adb" -s "$serial" shell getprop "$1" 2>/dev/null | tr -d '\r'; }
deadline=$((SECONDS+370))
while [[ "$(prop sys.boot_completed || true)" != 1 ]]; do
    if ! kill -0 "$pid" 2>/dev/null || (( SECONDS >= deadline )); then echo 'Emulator boot failed'; exit 1; fi
    sleep 2
done
echo 'Boot completed'
test "$(prop ro.product.cpu.abi)" = x86_64
test "$(prop ro.build.version.sdk)" = 35
test "$(device shell uname -m | tr -d '\r')" = x86_64
echo 'Native x86_64 Android 15 guest verified'
device shell wm dismiss-keyguard
device shell settings put global window_animation_scale 0
device shell settings put global transition_animation_scale 0
device shell settings put global animator_duration_scale 0
device shell settings put secure show_ime_with_hard_keyboard 1
device shell wm size 720x1280
device shell wm density 320
echo 'Android display setup succeeded'
device install -r -t --abi x86_64 "$work/alpha09.apk"
echo 'Actual signed APK installation succeeded'
device shell dumpsys package "$app" > "$work/package.txt"
grep -E '^[[:space:]]*primaryCpuAbi=x86_64[[:space:]]*$' "$work/package.txt"
grep -E '^[[:space:]]*versionCode=9([[:space:]]|$)' "$work/package.txt"
id=$(device shell settings get secure android_id | tr -d '\r')
[[ "$id" =~ ^[0-9a-fA-F]{16}$ ]]
echo 'Android installation identity available'
record=$(device shell pm path "$app" | tr -d '\r')
count=$(printf '%s\n' "$record" | wc -l)
echo "pm path returned $count line(s)"
if [[ "$record" =~ ^package:(/data/app/[A-Za-z0-9._=+~/-]+/base\.apk)$ ]]; then
    path=${BASH_REMATCH[1]}
    echo 'Original package path regular expression PASS'
else
    echo 'Original package path regular expression FAIL'
    exit 1
fi
# Hash in the guest first, leaving the large installed APK on its disk.
for attempt in 1 2 3; do
    if device shell toybox sha256sum "$path" > "$work/device.sha" 2>"$work/digest-error"; then
        digest=$(awk 'NR==1{print $1}' "$work/device.sha")
        if [[ "$digest" != "$expected" ]]; then
            echo 'Device returned a digest that differed from the signed input'
            exit 1
        fi
        echo "On-device toybox SHA-256 PASS $digest (attempt $attempt)"
        test "$(device get-state | tr -d '\r')" = device
        echo 'Android remained connected after digest readback'
        exit 0
    fi
    echo "Device digest command failed on attempt $attempt"
    timeout 45 "$adb" -s "$serial" wait-for-device || true
    sleep 2
done
echo 'Device did not return a matching digest'
exit 1
