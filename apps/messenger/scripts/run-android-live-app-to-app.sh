#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $# != 5 && $# != 7 ]]; then
  printf '%s\n' 'Usage: run-android-live-app-to-app.sh EVIDENCE_DIRECTORY EXACT_APP_APK HARNESS_APP_APK HARNESS_TEST_APK PRIVATE_INPUT_DIRECTORY [--profile alpha06-test|alpha07-release]' >&2
  exit 2
fi
profile=alpha06-test
if [[ $# == 7 ]]; then
  [[ "$6" == --profile ]] || { printf '%s\n' 'An explicit --profile option is required.' >&2; exit 2; }
  profile=$7
fi
case "$profile" in
  alpha06-test)
    acceptance_manifest=arm64-alpha06-acceptance.json
    version_code=6
    ;;
  alpha07-release)
    acceptance_manifest=arm64-alpha07-live-acceptance.json
    version_code=7
    ;;
  *) printf '%s\n' 'Unsupported live release profile.' >&2; exit 2 ;;
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

"$python_bin" - "$messenger_dir/android/$acceptance_manifest" "$app_apk" "$work_dir/expected-signer" "$evidence_dir/apk-identity.json" "$profile" <<'PY'
import hashlib, json, pathlib, re, sys
from urllib.parse import urlsplit
manifest_path, app_path, signer_path, report_path = map(pathlib.Path, sys.argv[1:5])
profile = sys.argv[5]
manifest = json.loads(manifest_path.read_text())
release_evidence = {}
if profile == 'alpha07-release':
    required = {'schema_version', 'profile', 'app_url', 'app_sha256', 'app_bytes', 'signer_sha256',
                'application_id', 'version_code', 'version_name', 'debuggable', 'production_origin',
                'production_origin_verified_app_sha256', 'build_source_commit'}
    if set(manifest) != required or any(manifest.get(key) is None for key in required):
        raise SystemExit('Alpha07 live acceptance requires complete reviewed artifact and production-origin metadata.')
    expected = (1, 'alpha07-release', 'com.vellivex.messenger.alpha', 7, '0.1.0-alpha07', False,
                'https://messenger.vellivex.com', '3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2',
                'f3003647565f318da435c5ebdc40b7f55fbef676',
                '4f3ca6d6fd857b690b3c4e78f35e104620966c3d31774a47df2248914820a9e5', 57525706)
    actual = tuple(manifest[key] for key in ('schema_version', 'profile', 'application_id', 'version_code',
                   'version_name', 'debuggable', 'production_origin', 'signer_sha256',
                   'build_source_commit', 'app_sha256', 'app_bytes'))
    if actual != expected or type(manifest['debuggable']) is not bool or any(type(manifest[key]) is not int for key in ('schema_version', 'version_code', 'app_bytes')) or manifest['app_bytes'] <= 0:
        raise SystemExit('Alpha07 metadata does not describe the fixed normal-release profile.')
    digest_field = manifest['app_sha256']
    if not isinstance(digest_field, str) or not re.fullmatch(r'[0-9a-f]{64}', digest_field):
        raise SystemExit('Alpha07 requires its reviewed exact APK SHA-256.')
    if manifest['production_origin_verified_app_sha256'] != digest_field:
        raise SystemExit('Production-origin build verification must be bound to the exact Alpha07 APK.')
    if not isinstance(manifest['app_url'], str):
        raise SystemExit('Alpha07 requires a reviewed public HTTPS download URL.')
    url = urlsplit(manifest['app_url'])
    if (url.scheme != 'https' or not url.hostname or not url.path or url.username is not None or
            url.password is not None or url.query or url.fragment or any(character.isspace() for character in manifest['app_url'])):
        raise SystemExit('Alpha07 requires a stable public HTTPS download URL without credentials.')
    release_evidence = {'profile': profile, 'version_code': 7, 'version_name': '0.1.0-alpha07',
        'production_origin': manifest['production_origin'],
        'production_origin_verified_app_sha256': manifest['production_origin_verified_app_sha256'],
        'production_origin_build_attestation_checked': True,
        'build_source_commit': manifest['build_source_commit']}
elif profile != 'alpha06-test':
    raise SystemExit('Unsupported live release profile.')
digest = hashlib.sha256(app_path.read_bytes()).hexdigest()
if digest != manifest['app_sha256']:
    raise SystemExit('The app is not the exact pinned signed APK for the selected live profile.')
if profile == 'alpha07-release' and app_path.stat().st_size != manifest['app_bytes']:
    raise SystemExit('Alpha07 installer length does not match the reviewed artifact.')
signer_path.write_text(manifest['signer_sha256'])
signer_path.chmod(0o600)
pathlib.Path(report_path).write_text(json.dumps({
    'app_sha256': digest, 'app_bytes': app_path.stat().st_size,
    'expected_signer_sha256': manifest['signer_sha256'],
    'release_url': manifest['app_url'],
    **release_evidence,
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
if [[ "$profile" == alpha06-test ]]; then
  grep -Eq "^package: name='com\.vellivex\.messenger\.alpha' versionCode='6' versionName='0\.1\.0-alpha06-test'" <<< "$app_badging"
else
  grep -Eq "^package: name='com\.vellivex\.messenger\.alpha' versionCode='7' versionName='0\.1\.0-alpha07'" <<< "$app_badging"
  "$build_tools/aapt" dump xmltree "$app_apk" AndroidManifest.xml >"$work_dir/app-manifest.txt"
  "$python_bin" - "$work_dir/app-manifest.txt" "$evidence_dir/apk-identity.json" <<'PYRELEASE'
import json, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
if not re.search(r'^\s*E: application\b', text, re.M):
    raise SystemExit('Could not inspect the Alpha07 application manifest.')
debuggable = [line for line in text.splitlines() if 'android:debuggable(' in line]
if len(debuggable) > 1 or any(not re.search(r'=\(type 0x12\)0x0\s*$', line) for line in debuggable):
    raise SystemExit('Alpha07 must not be a debuggable installer.')
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
  "$adb" -s "$serial" install -r -t --abi arm64-v8a "$app_apk" >/dev/null
  "$adb" -s "$serial" install -r -t "$harness_apk" >/dev/null
  "$adb" -s "$serial" install -r -t "$test_apk" >/dev/null
  "$adb" -s "$serial" shell dumpsys package com.vellivex.messenger.alpha >"$work_dir/package-$serial.txt"
  grep -Eq '^[[:space:]]*primaryCpuAbi=arm64-v8a[[:space:]]*$' "$work_dir/package-$serial.txt"
  grep -Eq "^[[:space:]]*versionCode=$version_code([[:space:]]|$)" "$work_dir/package-$serial.txt"
  "$adb" -s "$serial" shell settings get secure android_id >"$work_dir/android-id-$serial"
  printf '%s versionCode=%s primaryCpuAbi=arm64-v8a native-bridge=%s\n' "$serial" "$version_code" "$native_bridge" >>"$evidence_dir/installed-apps.txt"
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
  "$python" - "$1" "$2" <<'PYSAN'
import pathlib, re, sys
raw = pathlib.Path(sys.argv[1]).read_text(errors='replace').replace('\r', '')
allowed = re.compile(
    r'^(?:INSTRUMENTATION_STATUS: stream=)?Live two-app [AB] (?:fresh|restart): [a-z0-9-]{1,80}$|'
    r'^(?:INSTRUMENTATION_STATUS: stream=)?Live two-app diagnostic [AB] (?:fresh|restart): category=(?:stale-ui|missing-ui|network-timeout|network-io|assertion|argument|state|other) action=[a-z0-9-]{1,80} expected=(?:new-conversation|contact-continue|text-control|described-control|editable-field|labelled-field)$|'
    r'^INSTRUMENTATION_(?:STATUS_)?CODE: -?[0-9]+$|^OK \(1 test\)$|^FAILURES!!!$|^Tests run: [0-9]+,  Failures: [0-9]+$|'
    r'^java\.lang\.AssertionError: Live two-app UI acceptance failed for role [AB] in (?:fresh|restart); last safe checkpoint: [a-z0-9-]+$'
)
lines = [line for line in raw.splitlines() if allowed.fullmatch(line)]
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
"$python" - "$evidence_dir/two-app-summary.json" "$profile" "$evidence_dir/apk-identity.json" <<'PY'
import json, pathlib, sys
summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
profile = sys.argv[2]
if profile == 'alpha06-test':
    profile_checkpoints = {'default-production-https-confirmed'}
elif profile == 'alpha07-release':
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
                'disposable-live-session-signed-out'}
    if not required <= completed:
        raise SystemExit('A required production UI checkpoint was not reached.')
print('PASS: two exact installed ARM64 apps completed real-email production HTTPS and cold-restart UI exchanges.')
PY
