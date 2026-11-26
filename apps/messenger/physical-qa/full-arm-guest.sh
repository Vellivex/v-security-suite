#!/usr/bin/env bash
set -euo pipefail
umask 077
work=$(mktemp -d "$RUNNER_TEMP/full-arm.XXXXXXXX")
pid=''
cleanup() {
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
    rm -rf -- "$work"
}
trap cleanup EXIT
sdk="$ANDROID_HOME/cmdline-tools/latest/bin"
bt="$ANDROID_HOME/build-tools/36.0.0"
adb="$ANDROID_HOME/platform-tools/adb"
serial=emulator-5554
image='system-images;android-27;default;arm64-v8a'
export ANDROID_AVD_HOME="$work/avd"
mkdir -p "$ANDROID_AVD_HOME"
cd "$RUNNER_TEMP"
"$sdk/sdkmanager" 'build-tools;36.0.0' 'platform-tools' 'emulator' "$image"
"$bt/apksigner" verify --print-certs alpha08.apk | grep -F 'Signer #1 certificate SHA-256 digest: 3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2'
"$bt/apksigner" verify --print-certs native-qa.apk | grep -F 'Signer #1 certificate SHA-256 digest: 39901bf944f1c1756c161ad31a1edd389aa428a996661b163698b99db8186f7c'
# The current Linux launcher supports only x86 guests. This official archived
# version still selects its ARM64 system emulator for API 27.
curl --proto '=https' --fail --location --silent --show-error --max-time 180 \
    --output "$work/emulator.zip" https://dl.google.com/android/repository/emulator-linux_x64-12038310.zip
echo "621c9384efa919ecf42d94b29e47abbc097261fa7bff667adf4bddb9a35f7254  $work/emulator.zip" | sha256sum -c -
unzip -q "$work/emulator.zip" -d "$work/tool"
emulator="$work/tool/emulator/emulator"
grep -F "Pkg.Revision=34.2.16" "$work/tool/emulator/source.properties"
printf 'no\n' | "$sdk/avdmanager" create avd -n native-guest -k "$image"
cat >> "$ANDROID_AVD_HOME/native-guest.avd/config.ini" <<'INI'
hw.lcd.width=480
hw.lcd.height=800
hw.lcd.density=160
hw.keyboard=yes
INI
"$emulator" -avd native-guest -port 5554 -accel off -no-window -no-audio -no-boot-anim -no-snapshot -cores 2 -memory 1536 -gpu swiftshader_indirect > "$work/boot.log" 2>&1 &
pid=$!
"$adb" start-server
device() { timeout 50 "$adb" -s "$serial" "$@"; }
property() { timeout 5 "$adb" -s "$serial" shell getprop "$1" 2>/dev/null | tr -d '\r'; }
deadline=$((SECONDS+1500))
while [[ "$(property sys.boot_completed || true)" != 1 ]]; do
    if ! kill -0 "$pid" 2>/dev/null || (( SECONDS >= deadline )); then
        echo 'Full ARM guest did not complete Android boot within the bound.'
        sed -n '1,85p' "$work/boot.log"
        exit 1
    fi
    if ((SECONDS % 100 < 6)); then echo "Waiting for full ARM guest boot ($SECONDS seconds)"; fi
    sleep 5
done
echo "Full Android ARM guest booted after $SECONDS seconds."
abi=$(property ro.product.cpu.abi)
bridge=$(property ro.dalvik.vm.native.bridge || true)
kernel=$(device shell uname -m | tr -d '\r')
api=$(property ro.build.version.sdk)
echo "Guest ABI=$abi kernel=$kernel API=$api bridge=${bridge:-none}"
test "$abi" = arm64-v8a
test "$kernel" = aarch64
test "$api" = 27
[[ -z "$bridge" || "$bridge" == 0 ]]
for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
    device shell settings put global "$setting" 0
done
device shell input keyevent 82
device install native-qa.apk
device install alpha08.apk
device shell dumpsys package com.vellivex.messenger.alpha > "$work/package.txt"
grep -m1 'primaryCpuAbi=arm64-v8a' "$work/package.txt"
device shell am start -W -n com.vellivex.messenger.alpha/com.vellivex.messenger.MainActivity
device shell dumpsys activity activities > "$work/activities.txt"
grep -E 'mResumedActivity.*com.vellivex.messenger.alpha/' "$work/activities.txt"
echo 'Canonical signed installer installed and opened; no authentication input.'
device shell am force-stop com.vellivex.messenger.alpha
device shell am start -W -n com.vellivex.qa.physical/com.vellivex.qa.ProbeActivity
snapshot() {
    device shell uiautomator dump /sdcard/qa-window.xml >/dev/null &&
    device exec-out cat /sdcard/qa-window.xml > "$work/window.xml"
}
step_deadline=$((SECONDS+150))
point=''
while [[ -z "$point" ]] && ((SECONDS < step_deadline)); do
    if snapshot; then
        point=$(python3 - "$work/window.xml" <<'PY'
import re, sys, xml.etree.ElementTree as E
for node in E.parse(sys.argv[1]).iter('node'):
    if node.get('class') == 'android.widget.Button' and node.get('text','').lower()=='run diagnostics':
        x1,y1,x2,y2=map(int,re.findall(r'\d+',node.get('bounds','')))
        print((x1+x2)//2,(y1+y2)//2)
        break
PY
)
    fi
    [[ -n "$point" ]] || sleep 3
done
test -n "$point"
read -r x y <<< "$point"
device shell input tap "$x" "$y"
checks='Android HTTPS PASS|Native bootstrap PASS|Native memory PASS|Encrypted store PASS|Diagnostics complete'
deadline=$((SECONDS+300))
while (( SECONDS < deadline )); do
    if snapshot && grep -q 'Diagnostics complete' "$work/window.xml"; then break; fi
    sleep 4
done
python3 - "$work/window.xml" "$checks" <<'PY'
import sys, xml.etree.ElementTree as E
text='\n'.join(n.get('text','') for n in E.parse(sys.argv[1]).iter('node'))
for line in text.splitlines():
    if line.startswith(('Checking ', 'Android HTTPS ', 'Native bootstrap ', 'Native memory ', 'Encrypted store ', 'Diagnostics complete')):
        print(line[:220])
expected=sys.argv[2].split('|')
sys.exit(0 if all(v in text for v in expected) else 1)
PY
