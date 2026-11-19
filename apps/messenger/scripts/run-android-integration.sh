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
adb=("$sdk/platform-tools/adb" -s emulator-5554)
stop_synapse() {
  if [[ -n "$synapse_pid" ]]; then
    kill "$synapse_pid" 2>/dev/null || true
    wait "$synapse_pid" 2>/dev/null || true
    synapse_pid=''
  fi
}
cleanup() {
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

overall_status=0
run_instrumentation MessengerChatLayoutTest || overall_status=1
run_instrumentation MessengerOnboardingSmokeTest || overall_status=1
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
