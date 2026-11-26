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
second_emulator_pid=''
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
  if [[ -n "$second_emulator_pid" ]]; then
    kill "$second_emulator_pid" 2>/dev/null || true
    wait "$second_emulator_pid" 2>/dev/null || true
  fi
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

# This QA branch adds one isolated two-device handoff before the usual integration suite.
if [[ $# == 1 && ${GITHUB_HEAD_REF:-} == test/messenger-alpha10-profile-qr-pair-20261126 ]]; then
  sender=("${adb[@]}")
  recipient=("${adb[0]}" -s emulator-5556)
  printf 'no\n' | "$sdk_tools/avdmanager" create avd --name vellivex-qr-recipient --package "$system_image"
  "$emulator" -avd vellivex-qr-recipient -port 5556 -accel on -memory 1536 -cores 2 -gpu swiftshader \
    -no-window -no-audio -no-snapshot -no-boot-anim >"$work_dir/qr-recipient-boot.log" 2>&1 &
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
  start_synapse qr
  pair_class=com.vellivex.messenger.MessengerProfileQrPairTest
  run_pair_role() {
    local serial=$1 role=$2
    shift 2
    timeout 6m "${adb[0]}" -s "$serial" shell am instrument -w -r -e class "$pair_class" \
      -e qrRole "$role" -e messengerMailboxKey "$mailbox_key" "$@" "$runner" | stdbuf -oL tr -d '\r'
  }
  passed_pair_role() {
    grep -Eq '^OK \(1 test\)$' "$1" && grep -Fxq 'INSTRUMENTATION_CODE: -1' "$1" &&
      ! grep -Eq '^INSTRUMENTATION_STATUS_CODE: -[0-9]+$' "$1"
  }
  run_pair_role emulator-5554 sender >"$work_dir/sender-result"
  if ! passed_pair_role "$work_dir/sender-result"; then
    grep -E 'AssertionError|IllegalStateException|RuntimeException|NotFoundException|Exception:|Unable to' "$work_dir/sender-result" | head -3 | sed -E 's/@[^ ]+/@synthetic/g' || true
    echo 'Sender could not decode its own visible profile QR.' >&2; exit 1
  fi
  scanned=$(sed -n 's/^INSTRUMENTATION_STATUS: qrHandoff=//p' "$work_dir/sender-result")
  [[ "$scanned" =~ ^https://www\.vellivex\.com/invite#/@[a-zA-Z0-9_.=-]+:[a-zA-Z0-9.:-]+$ ]]
  printf '%s\n' 'Decoded public QR pixels rendered in the sender profile. Account data remains local to this fixture.'
  # A debug signer has no association with the production host. Exercise Android's per-user
  # supported-link setting on this dedicated device, leaving domain verification untouched.
  "${recipient[@]}" shell pm set-app-links-user-selection --user 0 --package "$test_app" true www.vellivex.com
  "${recipient[@]}" shell pm get-app-links --user 0 "$test_app" | tr -d '\r' >"$work_dir/link-state"
  if grep -Eq 'www\.vellivex\.com: verified' "$work_dir/link-state"; then
    echo 'Unexpected verified domain on this debug installation.' >&2; exit 1
  fi
  run_pair_role emulator-5556 recipient -e expectedQr "$scanned" >"$work_dir/recipient-result" &
  receiver_pid=$!
  deadline=$((SECONDS + 210))
  until grep -Fxq 'INSTRUMENTATION_STATUS: qrRecipient=ready' "$work_dir/recipient-result"; do
    if (( SECONDS >= deadline )) || ! kill -0 "$receiver_pid" 2>/dev/null; then
      echo 'Second test account did not finish sign-in and recovery.' >&2; exit 1
    fi
    sleep 1
  done
  echo 'Second account is signed in and waiting for the external URI.'
  action=(-a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "$scanned")
  component=$("${recipient[@]}" shell cmd package resolve-activity --brief "${action[@]}" | tr -d '\r' | tail -n 1)
  if [[ "$component" != "$test_app/com.vellivex.messenger.MainActivity" ]]; then
    printf 'Unexpected Android handler: %.150s\n' "$component" >&2; exit 1
  fi
  echo 'External Android resolver selected Vellivex Messenger.'
  "${recipient[@]}" shell am start -W "${action[@]}" >"$work_dir/recipient-launch"
  grep -Eq 'Status: ok|Warning: Activity not started, intent has been delivered' "$work_dir/recipient-launch"
  echo 'Android delivered the captured link.'
  wait "$receiver_pid"
  if ! passed_pair_role "$work_dir/recipient-result"; then
    grep -E 'AssertionError|IllegalStateException|RuntimeException|Exception:|Unable to' "$work_dir/recipient-result" | head -3 | sed -E 's/@[^ ]+/@synthetic/g' || true
    echo 'The recipient UI did not confirm the matching contact and cancel.' >&2; exit 1
  fi
  grep -Fxq 'INSTRUMENTATION_STATUS: qrRecipient=matching-contact-cancelled' "$work_dir/recipient-result"
  cat >"$evidence_dir/profile-qr-handoff.json" <<'RECEIPT'
{"android_api":35,"distinct_emulators":true,"distinct_signed_in_test_accounts":true,"synthetic_synapse":true,"release_signed_build":false,"sender_qr_source":"drawn public profile QR image in app-owned Compose layer","secure_window_enabled":true,"qr_matches_sender_profile":true,"recipient_link_selection":"Android per-user supported link setting on a test-signed install","production_domain_verification_tested_here":false,"external_view_intent_has_no_package_or_component":true,"resolved_activity":"com.vellivex.messenger.alpha/com.vellivex.messenger.MainActivity","recipient_contact_matches_sender":true,"cancel_kept_inbox_unchanged":true,"third_party_chooser_shown":false}
RECEIPT
  cat "$evidence_dir/profile-qr-handoff.json"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    printf '%s\n' 'Two signed-in Android test installations passed the profile QR handoff. The public QR was decoded from its rendered pixels. Android opened Vellivex using a per-user supported-link preference for the test signer. The matching contact appeared and Cancel left the inbox unchanged.' >>"$GITHUB_STEP_SUMMARY"
  fi
  # A fresh run of the ordinary integration suite must start with an unused installation.
  "${sender[@]}" shell pm clear "$test_app" >/dev/null
  stop_synapse
  kill "$second_emulator_pid" || true
  wait "$second_emulator_pid" || true
  second_emulator_pid=''
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
