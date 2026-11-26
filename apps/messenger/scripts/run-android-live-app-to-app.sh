#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $# != 5 && $# != 7 ]]; then
  printf '%s\n' 'Usage: run-android-live-app-to-app.sh EVIDENCE_DIRECTORY EXACT_APP_APK HARNESS_APP_APK HARNESS_TEST_APK PRIVATE_INPUT_DIRECTORY [--profile alpha06-test|alpha07-release|alpha08-release]' >&2
  exit 2
fi
profile=alpha06-test
if [[ $# == 7 ]]; then
  [[ "$6" == --profile ]] || { printf '%s\n' 'An explicit --profile option is required.' >&2; exit 2; }
  profile=$7
fi
case "$profile" in
  alpha06-test)
    version_code=6
    ;;
  alpha07-release)
    version_code=7
    ;;
  alpha08-release)
    version_code=8
    ;;
  *) printf '%s\n' 'Unsupported live release profile.' >&2; exit 2 ;;
esac
scenario=${MESSENGER_LIVE_SCENARIO:-fresh}
case "$profile:$scenario" in
  alpha06-test:fresh|alpha07-release:fresh|alpha08-release:fresh|alpha08-release:upgrade-alpha07) ;;
  *) printf '%s\n' 'Unsupported live installer/scenario combination.' >&2; exit 2 ;;
esac

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
private_dir=$(realpath -e -- "$5")
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REPOSITORY:-}" == 'Vellivex/v-security-suite' ]]
[[ "$private_dir" == "$(realpath -m -- "${RUNNER_TEMP:?}/messenger-live-private")" ]]
[[ -f "$private_dir/private-key.pem" && -f "$private_dir/descriptor.json" ]]
"$python_bin" - "$private_dir/descriptor.json" <<'PYCONTEXT'
import json, os, pathlib, sys
d=json.loads(pathlib.Path(sys.argv[1]).read_text())
if (d['repository'] != os.environ['GITHUB_REPOSITORY'] or
        d['run_id'] != os.environ['GITHUB_RUN_ID'] or
        d['run_attempt'] != int(os.environ['GITHUB_RUN_ATTEMPT']) or
        d['head_sha'] != os.environ['CHECK_SHA']):
    raise SystemExit('Private input directory belongs to another workflow run.')
PYCONTEXT
serial_a=emulator-5554
serial_b=emulator-5556
if [[ "$serial_a" == "$serial_b" || ! "$serial_a" =~ ^emulator-[0-9]+$ || ! "$serial_b" =~ ^emulator-[0-9]+$ ]]; then
  printf '%s\n' 'Two different dedicated Android emulator serials are required.' >&2
  exit 2
fi

# All service state, codes, token-bearing logs and raw instrumentation logs stay private.
# Only allowlisted evidence is retained after cleanup.
work_dir=$(mktemp -d "$private_dir/work.XXXXXXXX")
chmod 700 "$work_dir"
emulator_pids=()
reverse_mappings=()
relay_pid=''
coordinator_pid=''
cleanup() {
  for pid in "$coordinator_pid" "$relay_pid" "${emulator_pids[@]}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  for mapping in "${reverse_mappings[@]}"; do
    "$adb" -s "${mapping%%|*}" reverse --remove "${mapping#*|}" >/dev/null 2>&1 || true
  done
  rm -rf -- "$private_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$python_bin" "$messenger_dir/scripts/live-release-profile.py" verify "$profile" "$app_apk" \
  --signer-output "$work_dir/expected-signer" --report "$evidence_dir/apk-identity.json"

expected_signer=$(<"$work_dir/expected-signer")
previous_apk=''
if [[ "$scenario" == upgrade-alpha07 ]]; then
  previous_apk=$(realpath -e -- "${RUNNER_TEMP:?}/messenger-live-inputs/previous-alpha07.apk")
  "$python_bin" "$messenger_dir/scripts/live-release-profile.py" verify alpha07-release "$previous_apk" \
    --report "$work_dir/previous-alpha07-identity.json"
  "$build_tools/apksigner" verify "$previous_apk" >/dev/null
  previous_signer=$("$build_tools/apksigner" verify --print-certs "$previous_apk" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
  [[ "$previous_signer" == "$expected_signer" ]]
  "$build_tools/aapt" dump badging "$previous_apk" >"$work_dir/previous-alpha07-badging.txt"
  grep -Eq "^package: name='com\.vellivex\.messenger\.alpha' versionCode='7' versionName='0\.1\.0-alpha07'" "$work_dir/previous-alpha07-badging.txt"
  grep -Eq "^native-code: 'arm64-v8a'[[:space:]]*$" "$work_dir/previous-alpha07-badging.txt"
fi
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
if [[ "$profile" == alpha06-test ]]; then
  grep -Eq "^package: name='com\.vellivex\.messenger\.alpha' versionCode='6' versionName='0\.1\.0-alpha06-test'" <<< "$app_badging"
else
  grep -Eq "^package: name='com\.vellivex\.messenger\.alpha' versionCode='$version_code' versionName='0\.1\.0-alpha0$version_code'" <<< "$app_badging"
  "$build_tools/aapt" dump xmltree "$app_apk" AndroidManifest.xml >"$work_dir/app-manifest.txt"
  "$python_bin" - "$work_dir/app-manifest.txt" "$evidence_dir/apk-identity.json" <<'PYRELEASE'
import json, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
if not re.search(r'^\s*E: application\b', text, re.M):
    raise SystemExit('Could not inspect the normal-release application manifest.')
debuggable = [line for line in text.splitlines() if 'android:debuggable(' in line]
if len(debuggable) > 1 or any(not re.search(r'=\(type 0x12\)0x0\s*$', line) for line in debuggable):
    raise SystemExit('The selected normal release must not be a debuggable installer.')
report_path = pathlib.Path(sys.argv[2])
report = json.loads(report_path.read_text())
report['app_manifest_debuggable'] = False
report_path.write_text(json.dumps(report, indent=2) + '\n')
PYRELEASE
fi
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
if [[ $# == 5 || $# == 7 ]]; then
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
  if "$adb" -s "$serial" reverse --list | grep -Eq ' tcp:8030 '; then
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
  installed_apk=$app_apk
  installed_version=$version_code
  if [[ "$scenario" == upgrade-alpha07 && "$serial" == "$serial_a" ]]; then
    installed_apk=$previous_apk
    installed_version=7
  fi
  "$adb" -s "$serial" install -r -t --abi arm64-v8a "$installed_apk" >/dev/null
  "$adb" -s "$serial" install -r -t "$harness_apk" >/dev/null
  "$adb" -s "$serial" install -r -t "$test_apk" >/dev/null
  "$adb" -s "$serial" shell dumpsys package com.vellivex.messenger.alpha >"$work_dir/package-$serial.txt"
  grep -Eq '^[[:space:]]*primaryCpuAbi=arm64-v8a[[:space:]]*$' "$work_dir/package-$serial.txt"
  grep -Eq "^[[:space:]]*versionCode=$installed_version([[:space:]]|$)" "$work_dir/package-$serial.txt"
  "$adb" -s "$serial" shell settings get secure android_id >"$work_dir/android-id-$serial"
  printf '%s versionCode=%s primaryCpuAbi=arm64-v8a native-bridge=%s\n' "$serial" "$installed_version" "$native_bridge" >>"$evidence_dir/installed-apps.txt"
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

python="$python_bin"
"$python" - "$work_dir/coordinator-key" <<'PYKEY'
import pathlib, secrets, sys
p=pathlib.Path(sys.argv[1])
p.write_text(secrets.token_hex(32))
p.chmod(0o600)
PYKEY
"$python" "$messenger_dir/scripts/live-input-relay.py" --private-directory "$private_dir" \
  --envelope-script "$messenger_dir/scripts/live-input-envelope.mjs" >"$work_dir/relay.log" 2>&1 &
relay_pid=$!
"$python" "$messenger_dir/scripts/live-app-to-app-coordinator.py" \
  --key-file "$work_dir/coordinator-key" --private-directory "$private_dir" \
  --report "$evidence_dir/two-app-summary.json" --handoff "$evidence_dir/code-handoff.json" \
  >"$work_dir/coordinator.log" 2>&1 &
coordinator_pid=$!
"$python" - "$work_dir/coordinator-key" <<'PYREADY'
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
    raise SystemExit('Private live two-app coordinator did not start.')
PYREADY
for serial in "$serial_a" "$serial_b"; do
  "$adb" -s "$serial" reverse tcp:8030 tcp:8030 >/dev/null
  reverse_mappings+=("$serial|tcp:8030")
done
coordinator_key=$(<"$work_dir/coordinator-key")
run_id=$("$python" -c 'import json,sys;print(json.load(open(sys.argv[1]))["session_id"])' "$private_dir/descriptor.json")
runner='com.vellivex.messenger.a2a.test/androidx.test.runner.AndroidJUnitRunner'

sanitise_result() {
  "$python" - "$1" "$2" "$messenger_dir/scripts/live-app-to-app-coordinator.py" <<'PYSAN'
import pathlib, re, runpy, sys
post_login_states = runpy.run_path(sys.argv[3])['POST_LOGIN_STATES']
raw = pathlib.Path(sys.argv[1]).read_text(errors='replace').replace('\r', '')
allowed = re.compile(
    r'^(?:INSTRUMENTATION_STATUS: stream=)?Live two-app [AB] (?:fresh|restart): [a-z0-9-]{1,80}$|'
    r'^(?:INSTRUMENTATION_STATUS: stream=)?Live two-app diagnostic [AB] (?:fresh|restart): category=(?:stale-ui|missing-ui|network-timeout|network-io|assertion|argument|state|other) action=[a-z0-9-]{1,80} expected=(?:new-conversation|contact-continue|text-control|described-control|editable-field|labelled-field)$|'
    r'^INSTRUMENTATION_(?:STATUS_)?CODE: -?[0-9]+$|^OK \(1 test\)$|^FAILURES!!!$|^Tests run: [0-9]+,  Failures: [0-9]+$|'
    r'^java\.lang\.AssertionError: Live two-app UI acceptance failed for role [AB] in (?:fresh|restart); last safe checkpoint: [a-z0-9-]+$'
)
lines = []
for line in raw.splitlines():
    if not allowed.fullmatch(line):
        continue
    if 'post-login-' in line and line.rsplit('post-login-', 1)[-1] not in post_login_states:
        continue
    lines.append(line)
pathlib.Path(sys.argv[2]).write_text('\n'.join(lines) + '\n')
passed = 'OK (1 test)' in raw.splitlines() and 'INSTRUMENTATION_CODE: -1' in raw.splitlines() and 'INSTRUMENTATION_STATUS_CODE: 0' in raw.splitlines() and not re.search(r'^INSTRUMENTATION_STATUS_CODE: -[0-9]+$', raw, re.M)
raise SystemExit(0 if passed else 1)
PYSAN
}

run_phase() {
  local phase=$1
  local status=0
  local pids=()
  for role in A B; do
    if [[ "$role" == A ]]; then serial=$serial_a; else serial=$serial_b; fi
    timeout 25m "$adb" -s "$serial" shell am instrument -w -r \
      -e class com.vellivex.messenger.a2a.MessengerLiveAppToAppTest \
      -e disableAnalytics true -e messengerA2aRole "$role" -e messengerA2aPhase "$phase" \
      -e messengerLiveReleaseProfile "$profile" \
      -e messengerLiveScenario "$scenario" \
      -e messengerA2aCoordinator http://127.0.0.1:8030 -e messengerA2aKey "$coordinator_key" \
      -e messengerA2aRunId "$run_id" "$runner" >"$work_dir/$phase-$role.log" 2>&1 &
    pids+=("$!")
  done
  if [[ "$phase" == fresh && "$scenario" == upgrade-alpha07 ]]; then
    if ! complete_alpha07_update; then
      status=1
      for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
    fi
  fi
  for pid in "${pids[@]}"; do wait "$pid" || status=1; done
  for role in A B; do
    sanitise_result "$work_dir/$phase-$role.log" "$evidence_dir/$phase-$role.log" || status=1
    cat "$evidence_dir/$phase-$role.log"
  done
  return "$status"
}

complete_alpha07_update() {
  "$python" "$messenger_dir/scripts/live-preserved-session-update.py" \
    "$adb" "$serial_a" "$app_apk" "$work_dir/package-$serial_a.txt" \
    "$work_dir/coordinator-key" "$evidence_dir/two-app-summary.json" \
    "$evidence_dir/upgrade-alpha07.json"
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
"$python" - "$evidence_dir/two-app-summary.json" "$profile" "$evidence_dir/apk-identity.json" "$scenario" "$evidence_dir/upgrade-alpha07.json" "$evidence_dir/installation-scenario.json" <<'PY'
import json, pathlib, sys
summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
profile = sys.argv[2]
scenario = sys.argv[4]
if profile == 'alpha06-test':
    profile_checkpoints = {'default-production-https-confirmed'}
elif profile in ('alpha07-release', 'alpha08-release'):
    identity = json.loads(pathlib.Path(sys.argv[3]).read_text())
    if (identity.get('profile') != profile or identity.get('app_manifest_debuggable') is not False or
            identity.get('production_origin') != 'https://messenger.vellivex.com' or
            identity.get('production_origin_verified_app_sha256') != identity.get('app_sha256') or
            identity.get('production_origin_build_attestation_checked') is not True):
        raise SystemExit('The exact normal-release identity and production-origin build verification are required.')
    profile_checkpoints = {'normal-release-package-confirmed', 'normal-release-settings-absent'}
else:
    raise SystemExit('Unsupported live release profile.')
if summary['failures'] or any(summary['completed_phases'][role] != ['fresh', 'restart'] for role in ('A', 'B')):
    raise SystemExit('Both actual apps did not complete both UI phases.')
if any(summary['sas_comparisons'].get(round_name, {}).get('matched') is not True for round_name in ('rejected', 'accepted')):
    raise SystemExit('Both full UI verification comparisons were not proven.')
if not all(summary['email_requests_started'].values()) or not all(summary['received_codes_supplied'].values()):
    raise SystemExit('Both real email-code inputs were not exercised.')
if summary['production_origin'] != 'https://messenger.vellivex.com' or summary['traffic_interception'] or summary['synthetic_mailbox']:
    raise SystemExit('The live scope was not preserved.')
for role in ('A', 'B'):
    completed = {item['name'] for item in summary['checkpoints'] if item['role'] == role}
    required = profile_checkpoints | {'email-code-and-recovery-setup-through-ui',
                'bidirectional-message-visible-on-peer', 'new-bidirectional-messages-after-cold-restart',
                'disposable-live-session-signed-out', 'received-code-field-confirmed', 'received-code-submit-tapped'}
    if scenario == 'fresh' or role == 'B':
        required.add('post-login-create-recovery')
    if not required <= completed:
        raise SystemExit('A required production UI checkpoint was not reached.')
if scenario == 'upgrade-alpha07':
    upgrade = json.loads(pathlib.Path(sys.argv[5]).read_text())
    required_update = {'source_version_code': 7, 'target_version_code': 8,
        'application_id_retained': True, 'application_uid_retained': True,
        'first_install_time_retained': True, 'data_clear_requested': False,
        'uninstall_requested': False, 'sign_out_before_update': False}
    if profile != 'alpha08-release' or any(upgrade.get(key) != value for key, value in required_update.items()):
        raise SystemExit('The non-destructive Alpha07-to-Alpha08 installation evidence is incomplete.')
    observed = {item['name'] for item in summary['checkpoints'] if item['role'] == 'A' and item['phase'] == 'fresh'}
    if not {'alpha07-saved-session-blocks-new-login', 'alpha07-saved-session-restored-without-new-code'} <= observed:
        raise SystemExit('The original Alpha07 saved-session failure and in-place restoration were not both observed.')
    scenario_report = {'installation_scenario': 'upgrade-alpha07',
        'scope': 'one preserved saved session after failed Alpha07 connection and one fresh Alpha08 app; no pre-upgrade message-history claim'}
else:
    scenario_report = {'installation_scenario': 'fresh', 'scope': 'two fresh installations of the selected exact release'}
pathlib.Path(sys.argv[6]).write_text(json.dumps(scenario_report, indent=2) + '\n')
print('PASS: two exact installed ARM64 apps completed real-email production HTTPS and cold-restart UI exchanges.')
PY
