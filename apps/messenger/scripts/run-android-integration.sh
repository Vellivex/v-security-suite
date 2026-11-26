#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $# != 1 && $# != 3 && $# != 5 ]]; then
  printf '%s\n' 'Usage: bash run-android-integration.sh EVIDENCE_DIRECTORY [ARM64_APP_APK INSTRUMENTATION_APK [PREVIOUS_ARM64_APK PREVIOUS_VERSION_CODE]]' >&2
  exit 2
fi

messenger_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
acceptance_alpha=${MESSENGER_ACCEPTANCE_ALPHA:-alpha06}
case "$acceptance_alpha" in
  alpha05) target_app_version=5 ;;
  alpha06) target_app_version=6 ;;
  *) printf '%s\n' 'MESSENGER_ACCEPTANCE_ALPHA must be alpha05 or alpha06.' >&2; exit 2 ;;
esac
evidence_dir=$1
mkdir -p -- "$evidence_dir"
evidence_dir=$(cd -- "$evidence_dir" && pwd)

sdk=${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}
sdk_tools="$sdk/cmdline-tools/latest/bin"
system_image='system-images;android-35;default;x86_64'
if (( $# >= 3 )); then
  app_apk=$(realpath -e -- "$2")
  test_apk=$(realpath -e -- "$3")
  [[ -s "$app_apk" && -s "$test_apk" ]]
  if [[ $# == 5 ]]; then
    previous_app_apk=$(realpath -e -- "$4")
    [[ -s "$previous_app_apk" ]]
    previous_app_version=$5
    if [[ "$previous_app_version" != 2 && "$previous_app_version" != 4 && "$previous_app_version" != 5 ]] ||
       (( previous_app_version >= target_app_version )); then
      printf '%s\n' 'The upgrade source must be supported version 2, 4 or 5 and older than the selected target.' >&2
      exit 2
    fi
  fi
  system_image='system-images;android-35;google_apis;x86_64'
  "$sdk_tools/sdkmanager" --install 'platform-tools' 'emulator' "$system_image"
else
  "$sdk_tools/sdkmanager" --install \
    'platform-tools' 'platforms;android-36' 'build-tools;35.0.0' 'build-tools;36.0.0' \
    'emulator' "$system_image"
fi
emulator="$sdk/emulator/emulator"
"$emulator" -accel-check

work_dir=$(mktemp -d)
emulator_pid=''
synapse_pid=''
second_emulator_pid=''
coordinator_pid=''
os_probe_pids=()
adb=("$sdk/platform-tools/adb" -s emulator-5554)
stop_synapse() {
  if [[ -n "$synapse_pid" ]]; then
    kill "$synapse_pid" 2>/dev/null || true
    wait "$synapse_pid" 2>/dev/null || true
    synapse_pid=''
  fi
}
cleanup() {
  for pid in "${os_probe_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [[ -n "$coordinator_pid" ]]; then kill "$coordinator_pid" || true; fi
  if [[ -n "$second_emulator_pid" ]]; then kill "$second_emulator_pid" || true; fi
  stop_synapse
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

python3.12 -m venv "$work_dir/venv"
python="$work_dir/venv/bin/python"
"$python" -m pip install -r "$messenger_dir/server/requirements.txt"
if [[ $# == 1 ]]; then
  (
    cd -- "$messenger_dir/android"
    ./gradlew --no-daemon --console=plain assembleDebug assembleDebugAndroidTest
  )
  apk_dir="$messenger_dir/android/app/build/outputs/apk"
  app_apk="$apk_dir/debug/app-x86_64-debug.apk"
  test_apk="$apk_dir/androidTest/debug/app-x86_64-debug-androidTest.apk"
  if [[ ! -f "$test_apk" ]]; then
    test_apk="$apk_dir/androidTest/debug/app-debug-androidTest.apk"
  fi
fi

export ANDROID_AVD_HOME="$work_dir/avd"
mkdir -- "$ANDROID_AVD_HOME"
printf 'no\n' | "$sdk_tools/avdmanager" create avd --name vellivex-api35 --package "$system_image"
"${adb[0]}" start-server
"$emulator" -avd vellivex-api35 -port 5554 -accel on -gpu swiftshader \
  -no-window -no-audio -no-snapshot -no-boot-anim >"$work_dir/emulator.log" 2>&1 &
emulator_pid=$!

boot_complete=''
boot_deadline=$((SECONDS + 240))
while (( SECONDS < boot_deadline )) && kill -0 "$emulator_pid" 2>/dev/null; do
  boot_complete=$(timeout 5 "${adb[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
  if [[ "$boot_complete" == 1 ]]; then
    break
  fi
  sleep 2
done
if [[ "$boot_complete" != 1 ]]; then
  tail -80 "$work_dir/emulator.log" >&2
  printf '%s\n' 'The Android 35 emulator did not boot within four minutes.' >&2
  exit 1
fi
"${adb[@]}" shell wm dismiss-keyguard
"${adb[@]}" shell settings put global window_animation_scale 0
"${adb[@]}" shell settings put global transition_animation_scale 0
"${adb[@]}" shell settings put global animator_duration_scale 0
"${adb[@]}" shell settings put secure show_ime_with_hard_keyboard 1
"${adb[@]}" shell wm size 720x1280
"${adb[@]}" shell wm density 320

start_synapse() {
  local name=$1
  local state="$work_dir/$name"
  "$python" "$messenger_dir/server/dev_server.py" \
    --state-dir "$state" --port 8008 --mailbox-port 8025 >"$work_dir/$name.log" 2>&1 &
  synapse_pid=$!
  if ! curl --noproxy '*' --fail --silent --retry 30 --retry-connrefused --retry-delay 1 \
    --max-time 3 http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then
    tail -80 "$work_dir/$name.log" >&2
    printf 'The local Synapse fixture did not become ready: %s\n' "$name" >&2
    return 1
  fi
  mailbox_key=$(<"$state/mailbox-key")
  test -n "$mailbox_key"
}
"${adb[@]}" reverse tcp:8008 tcp:8008
"${adb[@]}" reverse tcp:8025 tcp:8025

test_app=com.vellivex.messenger.alpha
runner="$test_app.test/androidx.test.runner.AndroidJUnitRunner"

verify_installed_arm64() {
  local version=$1
  local package_report
  package_report=$("${adb[@]}" shell dumpsys package "$test_app" | tr -d '\r')
  grep -Eq '^[[:space:]]*primaryCpuAbi=arm64-v8a[[:space:]]*$' <<< "$package_report"
  grep -Eq "^[[:space:]]*versionCode=$version([[:space:]]|$)" <<< "$package_report"
  printf '%s versionCode=%s primaryCpuAbi=arm64-v8a\n' "$test_app" "$version" | tee -a "$evidence_dir/translation.txt"
}

if (( $# >= 3 )); then
  native_bridge=$("${adb[@]}" shell getprop ro.dalvik.vm.native.bridge | tr -d '\r')
  supported_abis=$("${adb[@]}" shell getprop ro.product.cpu.abilist | tr -d '\r')
  if [[ -z "$native_bridge" || "$native_bridge" == 0 || ",$supported_abis," != *,arm64-v8a,* ]]; then
    printf '%s\n' 'The Android emulator does not advertise ARM64 translation.' >&2
    exit 1
  fi
  printf 'Android 35 x86_64 native bridge: %s\nSupported ABIs: %s\n' \
    "$native_bridge" "$supported_abis" | tee "$evidence_dir/translation.txt"
  if [[ $# == 5 ]]; then
    "${adb[@]}" install -t --abi arm64-v8a "$previous_app_apk"
    verify_installed_arm64 "$previous_app_version"
  else
    "${adb[@]}" install -t --abi arm64-v8a "$app_apk"
    verify_installed_arm64 "$target_app_version"
  fi
else
  "${adb[@]}" install -t "$app_apk"
fi
"${adb[@]}" install -t "$test_apk"

run_instrumentation() {
  local test_class=$1
  shift
  local result="$evidence_dir/$test_class.log"
  if ! timeout 8m "${adb[@]}" shell am instrument -w -r \
    -e class "com.vellivex.messenger.$test_class" -e disableAnalytics true "$@" "$runner" \
    | tr -d '\r' | tee "$result"; then
    printf 'Android instrumentation did not complete: %s\n' "$test_class" >&2
    return 1
  fi
  # The shell command can exit zero even if the runner ignored or failed a test.
  if ! grep -Fqx 'INSTRUMENTATION_STATUS_CODE: 0' "$result" ||
     ! grep -Fqx 'INSTRUMENTATION_CODE: -1' "$result" ||
     ! grep -Eq '^OK \([1-9][0-9]* tests?\)$' "$result" ||
     grep -Eq '^INSTRUMENTATION_STATUS_CODE: -[0-9]+$' "$result"; then
    printf 'Android test did not run successfully: %s\n' "$test_class" >&2
    return 1
  fi
}

if [[ $# == 5 ]]; then
  start_synapse upgrade
  run_instrumentation MessengerOnboardingFlowTest -e messengerMailboxKey "$mailbox_key" \
    -e messengerUpgradeSeedVersion "$previous_app_version"
  unset mailbox_key
  "${adb[@]}" shell am force-stop "$test_app"
  "${adb[@]}" install -r -t --abi arm64-v8a "$app_apk"
  verify_installed_arm64 "$target_app_version"
  run_instrumentation MessengerOnboardingRestartTest -e messengerUiRestart true \
    -e messengerUpgradeFromVersion "$previous_app_version" -e messengerUpgradeTargetVersion "$target_app_version"
  exit
fi

if [[ $# == 1 && "${MESSENGER_PAIR_TEST:-}" == notifications ]]; then
  sender=("${adb[@]}")
  recipient=("${adb[0]}" -s emulator-5556)
  printf 'no\n' | "$sdk_tools/avdmanager" create avd --name vellivex-notification-recipient --package "$system_image"
  "$emulator" -avd vellivex-notification-recipient -port 5556 -accel on -memory 1536 -cores 2 -gpu swiftshader \
    -no-window -no-audio -no-snapshot -no-boot-anim >"$work_dir/recipient-boot.log" 2>&1 &
  second_emulator_pid=$!
  deadline=$((SECONDS + 300))
  while [[ $(timeout 5 "${recipient[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true) != 1 ]]; do
    (( SECONDS < deadline )) || { echo 'Second Android emulator did not boot.' >&2; exit 1; }
    sleep 2
  done
  for serial in sender recipient; do
    declare -n phone=$serial
    "${phone[@]}" shell settings get secure android_id | tr -d '\r' >"$work_dir/$serial-id"
    "${phone[@]}" shell wm dismiss-keyguard
    "${phone[@]}" shell wm size 720x1280
    "${phone[@]}" shell wm density 320
    unset -n phone
  done
  [[ -s "$work_dir/sender-id" && -s "$work_dir/recipient-id" ]]
  if cmp -s "$work_dir/sender-id" "$work_dir/recipient-id"; then
    echo 'Two independent device identities are required.' >&2; exit 1
  fi
  "${recipient[@]}" install -t "$app_apk"
  "${recipient[@]}" install -t "$test_apk"
  "${recipient[@]}" reverse tcp:8008 tcp:8008
  "${recipient[@]}" reverse tcp:8025 tcp:8025
  start_synapse notify
  "$python" -c 'import secrets,sys; open(sys.argv[1],"w").write(secrets.token_hex(32))' "$work_dir/pair-key"
  "$python" "$messenger_dir/scripts/app-to-app-coordinator.py" --key-file "$work_dir/pair-key" \
    --mailbox-key-file "$work_dir/notify/mailbox-key" --report "$work_dir/coordinator.json" >"$work_dir/coordinator.log" 2>&1 &
  coordinator_pid=$!
  for serial in emulator-5554 emulator-5556; do
    phone=("${adb[0]}" -s "$serial")
    "${phone[@]}" reverse tcp:8030 tcp:8030
    "${phone[@]}" shell locksettings set-pin 2468 | grep -iq 'pin set'
    "${phone[@]}" shell settings put secure lock_screen_lock_after_timeout 0
    # Complete first-boot setup on the disposable emulators so Android displays third-party alerts.
    "${phone[@]}" shell settings put global device_provisioned 1
    "${phone[@]}" shell settings put secure user_setup_complete 1
    "${phone[@]}" shell settings put secure lock_screen_show_notifications 1
    "${phone[@]}" shell settings put secure lock_screen_allow_private_notifications 0
    "${phone[@]}" shell settings put system screen_off_timeout 1800000
    "${phone[@]}" shell settings put global window_animation_scale 0
    "${phone[@]}" shell settings put global animator_duration_scale 0
    "${phone[@]}" shell settings put global transition_animation_scale 0
  done
  pair_key=$(<"$work_dir/pair-key")
  if ! command -v tesseract >/dev/null; then
    sudo apt-get -qq update
    sudo apt-get -y install tesseract-ocr tesseract-ocr-eng
  fi
  # Inspect only dedicated Android System UI. Frame pixels and OCR output stay in temporary memory.
  cat >"$work_dir/os-probe.py" <<'OSPROBE'
import csv
import io
import re
import subprocess
import sys
import time

adb, serial = sys.argv[1:]
last = ""
def run(*args, data=None, timeout=10):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout).stdout
def shell(*args):
    return run(adb, '-s', serial, 'shell', *args).decode(errors='replace').strip()
while True:
    time.sleep(.15)
    try:
        request = shell("cat", "/data/local/tmp/vx-probe-request")
        if request == last or not re.fullmatch(r"(fresh|restart)-(home|locked|inbox|removed)-(banner|lock|lockshade|tap)", request):
            continue
        last = request
        visible = False
        nonblank = False
        status_text = False
        visible_words = 0
        focus = shell("dumpsys", "window", "windows")
        system_ui = any("com.android.systemui" in line or "NotificationShade" in line for line in focus.splitlines() if "mCurrentFocus=" in line or "mFocusedApp=" in line)
        # The first screen grabbed is the one actually visible, including the heads-up lifetime.
        png = run(adb, "-s", serial, "exec-out", "screencap", "-p")
        if png.startswith(b"\x89PNG"):
            table = run("tesseract","stdin","stdout","-l","eng","--psm","11","tsv",data=png,timeout=10).decode(errors='replace')
            groups = {}
            for row in csv.DictReader(io.StringIO(table), delimiter="\t"):
                if row.get('level') != "5" or not row.get('text','').strip():
                    continue
                group = (row['block_num'],row['par_num'],row['line_num'])
                groups.setdefault(group,[]).append(row)
            for rows in groups.values():
                words = [re.sub(r"[^a-z]", "", row['text'].lower()) for row in rows]
                line = " ".join(words)
                visible_words += len(words)
                if 'background alerts' in line or 'sync is active' in line:
                    status_text = True
                # Require the entire generic title or body. Never match only the app's group label.
                if not (re.search(r"\bnew v[ae]lli[vw]ex message\b",line) or re.search(r"\bopen v[ae]lli[vw]ex to view it\b",line)):
                    continue
                visible = True
                if request.endswith('-tap'):
                    target = rows[len(rows)//2]
                    x = int(target['left']) + int(target['width'])//2
                    y = int(target['top']) + int(target['height'])//2
                    shell('input','tap',str(x),str(y))
                break
        response = ' '.join([request, str(int(visible)),str(min(visible_words,999)),str(int(system_ui)),str(int(status_text))])
        shell("echo "+response+" > /data/local/tmp/vx-probe-result.tmp && mv /data/local/tmp/vx-probe-result.tmp /data/local/tmp/vx-probe-result")
    except (OSError,ValueError,subprocess.SubprocessError):
        continue
OSPROBE
  for serial in emulator-5554 emulator-5556; do
    "$python" "$work_dir/os-probe.py" "${adb[0]}" "$serial" >>"$work_dir/os-probe-$serial.log" 2>&1 &
    os_probe_pids+=("$!")
  done
  evidence="$evidence_dir/notification-pair.log"
  : >"$evidence"
  for phase in fresh restart; do
    if [[ "$phase" == restart ]]; then
      for serial in emulator-5554 emulator-5556; do
        "${adb[0]}" -s "$serial" shell am force-stop "$test_app"
      done
    fi
    pids=()
    for role in A B; do
      if [[ "$role" == A ]]; then serial=emulator-5554; else serial=emulator-5556; fi
      timeout 11m "${adb[0]}" -s "$serial" shell am instrument -w -r \
        -e class com.vellivex.messenger.MessengerNotificationPairTest \
        -e pairRole "$role" -e pairPhase "$phase" -e pairKey "$pair_key" -e messengerMailboxKey "$mailbox_key" \
        "$runner" >"$work_dir/$role-$phase" 2>&1 &
      pids+=("$!")
    done
    status=0
    for pid in "${pids[@]}"; do wait "$pid" || status=1; done
    for role in A B; do
      file="$work_dir/$role-$phase"
      sed -nE 's/^INSTRUMENTATION_STATUS: pairEvidence=([AB] (fresh|restart) [a-z0-9 =-]+)\r?$/\1/p' "$file" | tee -a "$evidence"
      if ! grep -Eq '^OK \(1 test\)' "$file"; then
        status=1
        # Print only in-repository stack locations and fixed exception types, never raw data.
        grep -Eo '([A-Za-z]+Exception|AssertionError)|MessengerNotificationPairTest\.kt:[0-9]+' "$file" | tail -22 || true
      fi
    done
    ((status == 0)) || exit 1
  done
  "$python" - "$evidence" "${NOTIFICATION_TEST_BUILD:?}" <<'PYTHON'
from pathlib import Path
import sys
lines=Path(sys.argv[1]).read_text().splitlines()
assert sys.argv[2] in ('alpha10', 'candidate')
candidate=sys.argv[2]=='candidate'
for role in ('A','B'):
    for phase, cases in [('fresh', ('home','locked','inbox')), ('restart', ('home','removed'))]:
        for case in cases:
            assert f'{role} {phase} {case} delivered=true' in lines
            matches=[line for line in lines if line.startswith(f'{role} {phase} {case} service=')]
            assert len(matches)==1, (role,phase,case)
            if candidate:
                flags=dict(word.split('=') for word in matches[0].split()[3:])
                assert all(flags[key]=='true' for key in ('service','posted','safe','tap')), (role,phase,case,flags)
                assert int(flags['importance']) >= 4
                if case=='locked':
                    assert flags['lock-eligible']=='true' and flags['lock-row']=='true'
    if candidate:
        assert f'{role} restart restored-service=true' in lines
print('Recorded OS alert results on both independent installations.')
PYTHON
  exit 0
fi

overall_status=0
# Old signed-APK acceptance pairs predate the HTTPS and saved-session classes.
# The default source CI must always run both regressions; historical frozen
# Alpha05/06 APK pairs retain their original tests and are not replaced.
if [[ $# == 1 ]]; then
  run_instrumentation MessengerProductionHttpsTest || overall_status=1
fi
run_instrumentation MessengerChatLayoutTest || overall_status=1
run_instrumentation MessengerOnboardingSmokeTest || overall_status=1
if [[ $# == 1 ]]; then
  run_instrumentation MessengerSavedSessionTest || overall_status=1
fi
start_synapse core
run_instrumentation MessengerLocalSynapseTest -e messengerMailboxKey "$mailbox_key" || overall_status=1
# The core fixture uses six OTP requests from one address, the server's minute budget.
stop_synapse
start_synapse onboarding
if ! run_instrumentation MessengerOnboardingFlowTest -e messengerMailboxKey "$mailbox_key"; then
  overall_status=1
elif ! "${adb[@]}" shell am force-stop "$test_app"; then
  overall_status=1
else
  run_instrumentation MessengerOnboardingRestartTest -e messengerUiRestart true || overall_status=1
fi
unset mailbox_key

screenshot=vellivex-alpha-onboarding.png
screenshot_source="/sdcard/Android/data/$test_app/files/$screenshot"
if ! "${adb[@]}" pull "$screenshot_source" "$evidence_dir/$screenshot"; then
  "${adb[@]}" exec-out run-as "$test_app" cat "$screenshot_source" >"$evidence_dir/$screenshot" || overall_status=1
fi
if [[ "$(file -b --mime-type "$evidence_dir/$screenshot")" != image/png ]]; then
  overall_status=1
fi
exit "$overall_status"
