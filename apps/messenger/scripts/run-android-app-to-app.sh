#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $# != 4 && $# != 6 ]]; then
  printf '%s\n' 'Usage: run-android-app-to-app.sh EVIDENCE_DIRECTORY EXACT_ALPHA05_APK HARNESS_APP_APK HARNESS_TEST_APK [SERIAL_A SERIAL_B]' >&2
  exit 2
fi

messenger_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence_dir=$1
mkdir -p -- "$evidence_dir"
evidence_dir=$(cd -- "$evidence_dir" && pwd)
if [[ -n $(ls -A -- "$evidence_dir") ]]; then
  printf '%s\n' 'Use a new empty evidence directory so stale results cannot resemble this run.' >&2
  exit 2
fi
app_apk=$(realpath -e -- "$2")
harness_apk=$(realpath -e -- "$3")
test_apk=$(realpath -e -- "$4")
sdk=${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}
adb="$sdk/platform-tools/adb"
sdk_tools="$sdk/cmdline-tools/latest/bin"
build_tools="$sdk/build-tools/36.0.0"
python_bin=${MESSENGER_A2A_PYTHON:-python3.12}
serial_a=${5:-emulator-5554}
serial_b=${6:-emulator-5556}
if [[ "$serial_a" == "$serial_b" || ! "$serial_a" =~ ^emulator-[0-9]+$ || ! "$serial_b" =~ ^emulator-[0-9]+$ ]]; then
  printf '%s\n' 'Two different dedicated Android emulator serials are required.' >&2
  exit 2
fi

# All service state, codes, token-bearing logs and raw instrumentation logs stay private.
# Only allowlisted evidence is retained after cleanup.
work_dir=$(mktemp -d)
chmod 700 "$work_dir"
emulator_pids=()
reverse_mappings=()
synapse_pid=''
coordinator_pid=''
cleanup() {
  for pid in "$coordinator_pid" "$synapse_pid" "${emulator_pids[@]}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  for mapping in "${reverse_mappings[@]}"; do
    "$adb" -s "${mapping%%|*}" reverse --remove "${mapping#*|}" >/dev/null 2>&1 || true
  done
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

"$python_bin" - "$messenger_dir/android/arm64-alpha05-acceptance.json" "$app_apk" "$work_dir/expected-signer" "$evidence_dir/apk-identity.json" <<'PY'
import hashlib, json, pathlib, sys
manifest_path, app_path, signer_path, report_path = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
digest = hashlib.sha256(app_path.read_bytes()).hexdigest()
if digest != manifest['app_sha256']:
    raise SystemExit('The app is not the exact pinned signed Alpha05 APK.')
signer_path.write_text(manifest['signer_sha256'])
signer_path.chmod(0o600)
pathlib.Path(report_path).write_text(json.dumps({
    'app_sha256': digest, 'app_bytes': app_path.stat().st_size,
    'expected_signer_sha256': manifest['signer_sha256'],
    'release_url': manifest['app_url'],
}, indent=2) + '\n')
PY
expected_signer=$(<"$work_dir/expected-signer")
for input in "$app_apk" "$harness_apk" "$test_apk"; do
  "$build_tools/apksigner" verify "$input" >/dev/null
done
signer_for() {
  "$build_tools/apksigner" verify --print-certs "$1" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p'
}
app_signer=$(signer_for "$app_apk")
harness_signer=$(signer_for "$harness_apk")
test_signer=$(signer_for "$test_apk")
[[ "$app_signer" == "$expected_signer" && "$harness_signer" == "$test_signer" && "$harness_signer" != "$app_signer" ]]
app_badging=$("$build_tools/aapt" dump badging "$app_apk")
harness_badging=$("$build_tools/aapt" dump badging "$harness_apk")
test_badging=$("$build_tools/aapt" dump badging "$test_apk")
grep -Eq "^package: name='com\.vellivex\.messenger\.alpha' versionCode='5' versionName='0\.1\.0-alpha05-test'" <<< "$app_badging"
grep -Eq "^native-code: 'arm64-v8a'[[:space:]]*$" <<< "$app_badging"
grep -Eq "^package: name='com\.vellivex\.messenger\.a2a' " <<< "$harness_badging"
grep -Eq "^package: name='com\.vellivex\.messenger\.a2a\.test' " <<< "$test_badging"
"$build_tools/aapt" dump xmltree "$test_apk" AndroidManifest.xml >"$work_dir/test-manifest.txt"
grep -Eq 'targetPackage\([^)]*\)="com\.vellivex\.messenger\.a2a"' "$work_dir/test-manifest.txt"
"$python_bin" - "$evidence_dir/apk-identity.json" "$harness_apk" "$test_apk" "$harness_signer" <<'PY'
import hashlib, json, pathlib, sys
report, host, test = map(pathlib.Path, sys.argv[1:4])
data = json.loads(report.read_text())
data.update({
    'app_signature_verified': True,
    'harness_signer_sha256': sys.argv[4],
    'harness_signer_distinct_from_app': True,
    'harness_app_sha256': hashlib.sha256(host.read_bytes()).hexdigest(),
    'harness_test_sha256': hashlib.sha256(test.read_bytes()).hexdigest(),
    'instrumentation_targets_own_harness_package': True,
})
report.write_text(json.dumps(data, indent=2) + '\n')
PY

"$adb" start-server >/dev/null
if [[ $# == 4 ]]; then
  if [[ ! -c /dev/kvm || ! -r /dev/kvm || ! -w /dev/kvm ]]; then
    printf '%s\n' 'Hardware acceleration is required when this runner creates Android emulators.' >&2
    exit 1
  fi
  for serial in "$serial_a" "$serial_b"; do
    if "$adb" -s "$serial" get-state >/dev/null 2>&1; then
      printf '%s\n' 'An emulator already occupies a requested test port; no existing device was changed.' >&2
      exit 1
    fi
  done
  image='system-images;android-35;google_apis;x86_64'
  "$sdk_tools/sdkmanager" --install 'platform-tools' 'emulator' "$image"
  export ANDROID_AVD_HOME="$work_dir/avd"
  mkdir -p "$ANDROID_AVD_HOME"
  for role in a b; do
    printf 'no\n' | "$sdk_tools/avdmanager" create avd --name "vellivex-a2a-$role" --package "$image"
    if [[ "$role" == a ]]; then port=5554; else port=5556; fi
    "$sdk/emulator/emulator" -avd "vellivex-a2a-$role" -port "$port" -accel on \
      -memory 1536 -cores 2 -gpu swiftshader -no-window -no-audio -no-snapshot -no-boot-anim \
      >"$work_dir/emulator-$role.log" 2>&1 &
    emulator_pids+=("$!")
  done
fi

for serial in "$serial_a" "$serial_b"; do
  boot_complete=''
  deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    boot_complete=$(timeout 5 "$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    [[ "$boot_complete" == 1 ]] && break
    sleep 2
  done
  if [[ "$boot_complete" != 1 ]]; then
    printf 'Dedicated emulator did not finish booting: %s\n' "$serial" >&2
    exit 1
  fi
  if "$adb" -s "$serial" shell pm path com.vellivex.messenger.alpha | grep -q '^package:'; then
    printf 'Refusing to change an existing Messenger installation: %s\n' "$serial" >&2
    exit 1
  fi
  if "$adb" -s "$serial" reverse --list | grep -Eq ' tcp:(8008|8030) '; then
    printf 'Refusing to replace existing test-port forwarding: %s\n' "$serial" >&2
    exit 1
  fi
  "$adb" -s "$serial" shell wm dismiss-keyguard
  "$adb" -s "$serial" shell settings put global window_animation_scale 0
  "$adb" -s "$serial" shell settings put global transition_animation_scale 0
  "$adb" -s "$serial" shell settings put global animator_duration_scale 0
  "$adb" -s "$serial" shell settings put secure show_ime_with_hard_keyboard 1
  "$adb" -s "$serial" shell wm size 720x1280
  "$adb" -s "$serial" shell wm density 320
  native_bridge=$("$adb" -s "$serial" shell getprop ro.dalvik.vm.native.bridge | tr -d '\r')
  supported_abis=$("$adb" -s "$serial" shell getprop ro.product.cpu.abilist | tr -d '\r')
  if [[ -z "$native_bridge" || "$native_bridge" == 0 || ",$supported_abis," != *,arm64-v8a,* ]]; then
    printf 'Dedicated emulator lacks ARM64 native translation: %s\n' "$serial" >&2
    exit 1
  fi
  "$adb" -s "$serial" install -r -t --abi arm64-v8a "$app_apk" >/dev/null
  "$adb" -s "$serial" install -r -t "$harness_apk" >/dev/null
  "$adb" -s "$serial" install -r -t "$test_apk" >/dev/null
  "$adb" -s "$serial" shell dumpsys package com.vellivex.messenger.alpha >"$work_dir/package-$serial.txt"
  grep -Eq '^[[:space:]]*primaryCpuAbi=arm64-v8a[[:space:]]*$' "$work_dir/package-$serial.txt"
  grep -Eq '^[[:space:]]*versionCode=5([[:space:]]|$)' "$work_dir/package-$serial.txt"
  "$adb" -s "$serial" shell settings get secure android_id >"$work_dir/android-id-$serial"
  printf '%s versionCode=5 primaryCpuAbi=arm64-v8a native-bridge=%s\n' "$serial" "$native_bridge" >>"$evidence_dir/installed-apps.txt"
done
"$python_bin" - "$work_dir/android-id-$serial_a" "$work_dir/android-id-$serial_b" "$evidence_dir/device-separation.json" <<'PY'
import hashlib, json, pathlib, sys
ids = [pathlib.Path(path).read_text().strip() for path in sys.argv[1:3]]
if any(not value or value == 'null' for value in ids) or ids[0] == ids[1]:
    raise SystemExit('Two independent Android device identities were not observed.')
pathlib.Path(sys.argv[3]).write_text(json.dumps({
    'different_android_device_ids': True,
    'android_id_sha256': [hashlib.sha256(value.encode()).hexdigest() for value in ids],
}, indent=2) + '\n')
PY

"$python_bin" -m venv "$work_dir/venv"
python="$work_dir/venv/bin/python"
"$python" -m pip install -r "$messenger_dir/server/requirements.txt"
"$python" "$messenger_dir/server/dev_server.py" --state-dir "$work_dir/synapse" \
  --port 8008 --mailbox-port 8025 >"$work_dir/synapse.log" 2>&1 &
synapse_pid=$!
if ! curl --noproxy '*' --fail --silent --retry 30 --retry-connrefused --retry-delay 1 \
  --max-time 3 http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then
  printf '%s\n' 'The isolated synthetic messaging service did not start.' >&2
  exit 1
fi
"$python" - "$work_dir/coordinator-key" "$work_dir/run-id" <<'PY'
import pathlib, secrets, sys
for path, value in zip(sys.argv[1:], (secrets.token_hex(32), secrets.token_hex(6))):
    destination = pathlib.Path(path)
    destination.write_text(value)
    destination.chmod(0o600)
PY
"$python" "$messenger_dir/scripts/app-to-app-coordinator.py" \
  --key-file "$work_dir/coordinator-key" --mailbox-key-file "$work_dir/synapse/mailbox-key" \
  --report "$evidence_dir/two-app-summary.json" >"$work_dir/coordinator.log" 2>&1 &
coordinator_pid=$!
"$python" - "$work_dir/coordinator-key" <<'PY'
import pathlib, sys, time, urllib.request
key = pathlib.Path(sys.argv[1]).read_text()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(40):
    try:
        req = urllib.request.Request('http://127.0.0.1:8030/status', headers={'Authorization': 'Bearer ' + key})
        with opener.open(req, timeout=1) as response:
            if response.status == 200:
                break
    except OSError:
        time.sleep(.25)
else:
    raise SystemExit('Private two-app coordinator did not start.')
PY
"$adb" -s "$serial_a" reverse tcp:8008 tcp:18081 >/dev/null
reverse_mappings+=("$serial_a|tcp:8008")
"$adb" -s "$serial_b" reverse tcp:8008 tcp:18082 >/dev/null
reverse_mappings+=("$serial_b|tcp:8008")
for serial in "$serial_a" "$serial_b"; do
  "$adb" -s "$serial" reverse tcp:8030 tcp:8030 >/dev/null
  reverse_mappings+=("$serial|tcp:8030")
done
coordinator_key=$(<"$work_dir/coordinator-key")
run_id=$(<"$work_dir/run-id")
runner='com.vellivex.messenger.a2a.test/androidx.test.runner.AndroidJUnitRunner'

sanitise_result() {
  "$python" - "$1" "$2" <<'PY'
import pathlib, re, sys
raw = pathlib.Path(sys.argv[1]).read_text(errors='replace').replace('\r', '')
target = r'(?:new-conversation|contact-continue|text-control|described-control|editable-field|labelled-field)'
boolean = r'(?:true|false|unavailable)'
prefix = r'^(?:INSTRUMENTATION_STATUS: stream=)?Two-app '
allowed = re.compile(
    prefix + r'[AB] (?:fresh|restart): [a-z0-9-]+$|'
    + prefix + r'diagnostic [AB] (?:fresh|restart): category=(?:stale-ui|missing-ui|network-timeout|network-io|assertion|argument|state|other) action=[a-z0-9-]{1,80} line=[0-9]+ expected=' + target
    + r' caller=(?:fresh-exchange|restart-exchange|sign-in|verification|unknown) caller-line=[0-9]+ dialog=' + boolean + r' error=' + boolean + r' empty-inbox=' + boolean + r' room-row=' + boolean + r' composer=' + boolean + r' editable-count=-?[0-9]+$|'
    + prefix + r'control [AB] (?:fresh|restart): expected=new-conversation channel=(?:text|anonymous-button) role=(?:button|view) enabled=(?:true|false) clickable=(?:true|false) bounds=-?[0-9]+,-?[0-9]+,-?[0-9]+,-?[0-9]+ role-child=(?:true|false) child-bounds=-?[0-9]+,-?[0-9]+,-?[0-9]+,-?[0-9]+ screen=[0-9]+,[0-9]+$|'
    + prefix + r'target [AB] (?:fresh|restart): expected=' + target + r' text-count=[0-9]+ description-count=[0-9]+ anonymous-count=[0-9]+ bounds=-?[0-9]+,-?[0-9]+,-?[0-9]+,-?[0-9]+ role=(?:button|editor|text|view|none|other) focus-app=' + boolean + r' ime=' + boolean + r'$|'
    + prefix + r'structure [AB] (?:fresh|restart): messages=(?:true|false) empty-inbox=(?:true|false) share-id=(?:true|false) profile-dialog=(?:true|false) new-chat-dialog=(?:true|false) room-row=(?:true|false) composer=(?:true|false) app-clickable-count=[0-9]+ button-count=[0-9]+ button-visible-count=[0-9]+ button-clickable-count=[0-9]+ view-clickable-count=[0-9]+ anonymous-button-count=[0-9]+ anonymous-view-count=[0-9]+ role-child-view-count=[0-9]+ truncated=(?:true|false)$|'
    + prefix + r'node [AB] (?:fresh|restart): kind=(?:clickable|button) index=[0-9]+ role=(?:button|image-button|editor|text|view|other) enabled=(?:true|false) clickable=(?:true|false) visible=(?:true|false) text-present=(?:true|false) description-present=(?:true|false) named-descendants=(?:true|false) role-children=[0-9]+ bounds=-?[0-9]+,-?[0-9]+,-?[0-9]+,-?[0-9]+$|'
    + r'^INSTRUMENTATION_(?:STATUS_)?CODE: -?[0-9]+$|^OK \(1 test\)$|^FAILURES!!!$|^Tests run: [0-9]+,  Failures: [0-9]+$|^java\.lang\.AssertionError: Two-app UI acceptance failed for role [AB] in (?:fresh|restart); last safe checkpoint: [a-z0-9-]+$'
)
lines = [line for line in raw.splitlines() if allowed.fullmatch(line)]
pathlib.Path(sys.argv[2]).write_text('\n'.join(lines) + '\n')
passed = 'OK (1 test)' in raw.splitlines() and 'INSTRUMENTATION_CODE: -1' in raw.splitlines() and 'INSTRUMENTATION_STATUS_CODE: 0' in raw.splitlines() and not re.search(r'^INSTRUMENTATION_STATUS_CODE: -[0-9]+$', raw, re.M)
raise SystemExit(0 if passed else 1)
PY
}

run_phase() {
  local phase=$1
  local status=0
  local pids=()
  for role in A B; do
    if [[ "$role" == A ]]; then serial=$serial_a; else serial=$serial_b; fi
    timeout 15m "$adb" -s "$serial" shell am instrument -w -r \
      -e class com.vellivex.messenger.a2a.MessengerAppToAppTest \
      -e disableAnalytics true -e messengerA2aRole "$role" -e messengerA2aPhase "$phase" \
      -e messengerA2aCoordinator http://127.0.0.1:8030 -e messengerA2aKey "$coordinator_key" \
      -e messengerA2aRunId "$run_id" "$runner" >"$work_dir/$phase-$role.log" 2>&1 &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid" || status=1; done
  for role in A B; do
    sanitise_result "$work_dir/$phase-$role.log" "$evidence_dir/$phase-$role.log" || status=1
    cat "$evidence_dir/$phase-$role.log"
  done
  return "$status"
}

run_phase fresh
for serial in "$serial_a" "$serial_b"; do
  before=$("$adb" -s "$serial" shell pidof com.vellivex.messenger.alpha | tr -d '\r' || true)
  [[ -n "$before" ]]
  "$adb" -s "$serial" shell am force-stop com.vellivex.messenger.alpha
  after=$("$adb" -s "$serial" shell pidof com.vellivex.messenger.alpha | tr -d '\r' || true)
  [[ -z "$after" ]]
  printf '%s existing-app-process-observed=true app-process-stopped=true data-cleared=false\n' "$serial" >>"$evidence_dir/cold-restart.txt"
done
run_phase restart
"$python" - "$evidence_dir/two-app-summary.json" <<'PY'
import json, pathlib, sys
summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
if summary['failures'] or any(summary['completed_phases'][role] != ['fresh', 'restart'] for role in ('A', 'B')):
    raise SystemExit('Both actual apps did not complete both UI phases.')
if any(summary['sas_comparisons'].get(round_name, {}).get('matched') is not True for round_name in ('rejected', 'accepted')):
    raise SystemExit('Both full UI verification comparisons were not proven.')
if summary['blocked_matrix_requests']['B'] < 1:
    raise SystemExit('No Matrix request was observed on the disconnected app path.')
if summary['network_transitions'] != [{'role': 'B', 'online': False}, {'role': 'B', 'online': True}]:
    raise SystemExit('The recipient network path did not complete the expected off/on sequence.')
if any(summary['encrypted_send_successes'][role] < 3 for role in ('A', 'B')):
    raise SystemExit('Three successful encrypted app sends per participant were not observed.')
if any(summary['plaintext_send_attempts'][role] != 0 for role in ('A', 'B')):
    raise SystemExit('A tested app attempted a plaintext message send.')
print('PASS: two exact installed ARM64 apps completed fresh and cold-restart UI exchanges.')
PY
