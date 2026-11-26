#!/usr/bin/env bash
set -euo pipefail
umask 077
work=$(mktemp -d "$RUNNER_TEMP/x86-native.XXXXXXXX")
pid=''
cleanup() {
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
    rm -rf -- "$work" "$RUNNER_TEMP/x86-inputs"
}
trap cleanup EXIT
sdk="$ANDROID_HOME/cmdline-tools/latest/bin"
bt="$ANDROID_HOME/build-tools/36.0.0"
adb="$ANDROID_HOME/platform-tools/adb"
serial=emulator-5554
image='system-images;android-35;google_apis;x86_64'
export ANDROID_AVD_HOME="$work/avd"
mkdir -p "$ANDROID_AVD_HOME"
"$sdk/sdkmanager" 'build-tools;36.0.0' 'platform-tools' 'emulator' "$image"
cd "$RUNNER_TEMP/x86-inputs"
"$bt/apksigner" verify --print-certs arm-qa.apk | grep -F 'Signer #1 certificate SHA-256 digest: 39901bf944f1c1756c161ad31a1edd389aa428a996661b163698b99db8186f7c'
# Preserve the exact manifest, accessibility UI, DEX, JVM TLS and storage code that
# ran on the Pixel. Only the two native entries switch to the reviewed x86 payload.
python3 - "$work/unsigned.apk" <<'PY'
import hashlib, sys, zipfile
inputs = {
    'libmatrix_sdk_ffi.so': ('vellivex-matrix-sdk.aar','43389d1ca31baf356c31248ad79bbf0b8f2067975890c240d89c7376f02d3dde'),
    'libjnidispatch.so': ('jna.aar','3809247e9b804a05ed8377b87d545cf5b5e97f960f75e725bc8497b40260e417'),
}
with zipfile.ZipFile('arm-qa.apk') as source, zipfile.ZipFile(sys.argv[1], 'w') as target:
    assert {e for e in source.namelist() if e.startswith('lib/')} == {'lib/arm64-v8a/'+n for n in inputs}
    for entry in source.infolist():
        name = entry.filename
        if name.startswith('META-INF/') and (name.endswith(('.RSA','.SF','.DSA','.EC')) or name == 'META-INF/MANIFEST.MF'):
            continue
        if name.startswith('lib/'):
            short=name.rsplit('/',1)[-1]
            archive,expected=inputs[short]
            with zipfile.ZipFile(archive) as library:
                data=library.read('jni/x86_64/'+short)
            assert hashlib.sha256(data).hexdigest()==expected
            entry.filename='lib/x86_64/'+short
            print(short,expected)
        else:
            data=source.read(entry)
        target.writestr(entry,data)
PY
"$bt/zipalign" -P 16 -f 4 "$work/unsigned.apk" "$work/aligned.apk"
keytool -genkeypair -keystore "$work/qa.p12" -storepass fixturekey -keypass fixturekey -alias qa -keyalg RSA -keysize 2048 -validity 2 -dname CN=Vellivex-Native-x86-QA
"$bt/apksigner" sign --ks "$work/qa.p12" --ks-pass pass:fixturekey --v4-signing-enabled false --out "$work/probe.apk" "$work/aligned.apk"
"$bt/apksigner" verify "$work/probe.apk"
"$bt/aapt" dump badging "$work/probe.apk" > "$work/badging"
grep -F "package: name='com.vellivex.qa.physical'" "$work/badging"
grep -Fx "native-code: 'x86_64'" "$work/badging" || grep -Eq "^native-code: 'x86_64'[[:space:]]*$" "$work/badging"
test -c /dev/kvm
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
    sudo chown "$(id -u):$(id -g)" /dev/kvm
    sudo chmod u+rw /dev/kvm
fi
printf 'no\n' | "$sdk/avdmanager" create avd -n native-qa -k "$image"
"$adb" start-server
"$ANDROID_HOME/emulator/emulator" -avd native-qa -port 5554 -accel on -cores 2 -memory 2048 -gpu swiftshader -no-window -no-audio -no-snapshot -no-boot-anim > "$work/boot.log" 2>&1 &
pid=$!
device() { timeout 45 "$adb" -s "$serial" "$@"; }
property() { timeout 5 "$adb" -s "$serial" shell getprop "$1" 2>/dev/null | tr -d '\r'; }
deadline=$((SECONDS+420))
while [[ "$(property sys.boot_completed || true)" != 1 ]]; do
    if ! kill -0 "$pid" 2>/dev/null || (( SECONDS >= deadline )); then
        echo 'Android failed to boot'
        tail -22 "$work/boot.log"
        exit 1
    fi
    sleep 3
done
abi=$(property ro.product.cpu.abi)
kernel=$(device shell uname -m | tr -d '\r')
api=$(property ro.build.version.sdk)
echo "Guest ABI=$abi kernel=$kernel API=$api"
test "$abi" = x86_64 && test "$kernel" = x86_64 && test "$api" = 35
for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
    device shell settings put global "$setting" 0
done
device shell wm dismiss-keyguard
device install --abi x86_64 "$work/probe.apk"
device shell dumpsys package com.vellivex.qa.physical > "$work/package.txt"
grep -Eq '^[[:space:]]*primaryCpuAbi=x86_64[[:space:]]*$' "$work/package.txt"
echo 'Installed independent QA package primaryCpuAbi=x86_64'
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
