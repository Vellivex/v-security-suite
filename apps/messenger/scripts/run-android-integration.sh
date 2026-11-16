#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $# != 1 ]]; then
  printf '%s\n' 'Usage: bash run-android-integration.sh EVIDENCE_DIRECTORY' >&2
  exit 2
fi

messenger_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence_dir=$1
mkdir -p -- "$evidence_dir"
evidence_dir=$(cd -- "$evidence_dir" && pwd)

sdk=${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}
sdk_tools="$sdk/cmdline-tools/latest/bin"
system_image='system-images;android-35;default;x86_64'
"$sdk_tools/sdkmanager" --install \
  'platform-tools' 'platforms;android-36' 'build-tools;35.0.0' 'build-tools;36.0.0' \
  'emulator' "$system_image"
emulator="$sdk/emulator/emulator"
"$emulator" -accel-check

work_dir=$(mktemp -d)
emulator_pid=''
synapse_pid=''
adb=("$sdk/platform-tools/adb" -s emulator-5554)
cleanup() {
  if [[ -n "$synapse_pid" ]]; then
    kill "$synapse_pid" 2>/dev/null || true
    wait "$synapse_pid" 2>/dev/null || true
  fi
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
(
  cd -- "$messenger_dir/android"
  ./gradlew --no-daemon --console=plain assembleDebug assembleDebugAndroidTest
)

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

server_state="$work_dir/synapse"
"$python" "$messenger_dir/server/dev_server.py" \
  --state-dir "$server_state" --port 8008 --mailbox-port 8025 >"$work_dir/synapse.log" 2>&1 &
synapse_pid=$!
if ! curl --noproxy '*' --fail --silent --retry 30 --retry-connrefused --retry-delay 1 \
  --max-time 3 http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then
  tail -80 "$work_dir/synapse.log" >&2
  printf '%s\n' 'The local Synapse fixture did not become ready.' >&2
  exit 1
fi
"${adb[@]}" reverse tcp:8008 tcp:8008
"${adb[@]}" reverse tcp:8025 tcp:8025

apk_dir="$messenger_dir/android/app/build/outputs/apk"
test_apk="$apk_dir/androidTest/debug/app-x86_64-debug-androidTest.apk"
if [[ ! -f "$test_apk" ]]; then
  test_apk="$apk_dir/androidTest/debug/app-debug-androidTest.apk"
fi
"${adb[@]}" install -t "$apk_dir/debug/app-x86_64-debug.apk"
"${adb[@]}" install -t "$test_apk"
test_app=com.vellivex.messenger.alpha
runner="$test_app.test/androidx.test.runner.AndroidJUnitRunner"

run_instrumentation() {
  local test_class=$1
  shift
  local result="$evidence_dir/$test_class.log"
  timeout 8m "${adb[@]}" shell am instrument -w -r \
    -e class "com.vellivex.messenger.$test_class" -e disableAnalytics true "$@" "$runner" \
    | tr -d '\r' | tee "$result"
  # The shell command can exit zero even if the runner ignored or failed a test.
  if ! grep -Fqx 'INSTRUMENTATION_STATUS_CODE: 0' "$result" ||
     ! grep -Fqx 'INSTRUMENTATION_CODE: -1' "$result" ||
     ! grep -Eq '^OK \([1-9][0-9]* tests?\)$' "$result" ||
     grep -Eq '^INSTRUMENTATION_STATUS_CODE: -[0-9]+$' "$result"; then
    printf 'Android test did not run successfully: %s\n' "$test_class" >&2
    return 1
  fi
}

run_instrumentation MessengerOnboardingSmokeTest
mailbox_key=$(<"$server_state/mailbox-key")
test -n "$mailbox_key"
run_instrumentation MessengerLocalSynapseTest -e messengerMailboxKey "$mailbox_key"

screenshot=vellivex-alpha-onboarding.png
screenshot_source="/sdcard/Android/data/$test_app/files/$screenshot"
if ! "${adb[@]}" pull "$screenshot_source" "$evidence_dir/$screenshot"; then
  "${adb[@]}" exec-out run-as "$test_app" cat "$screenshot_source" >"$evidence_dir/$screenshot"
fi
test "$(file -b --mime-type "$evidence_dir/$screenshot")" = image/png
