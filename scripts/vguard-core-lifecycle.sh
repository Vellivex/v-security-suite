#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Sourced by the isolated emulator harness after its protocol tests.
# Uses the same two fictional probes and the published, unchanged APK.

set_probe_rule() {
  local role="$1" expected="$2" label query current
  case "$role" in
    blocked) label='VGuard QA Blocked'; query='VGuard%sQA%sBlocked' ;;
    allowed) label='VGuard QA Allowed'; query='VGuard%sQA%sAllowed' ;;
    *) echo 'FAIL VGuard: unknown fictional probe role.' >&2; return 1 ;;
  esac
  tap contains 'Apps tab'
  tap desc 'Search apps or package names'
  "$adb" shell input keyevent 123 >/dev/null
  "$adb" shell input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 >/dev/null
  "$adb" shell input text "$query" >/dev/null
  "$adb" shell input keyevent 4 >/dev/null
  sleep 1
  dump_ui
  current=$(python3 - "$xml" "$label" <<'PY'
import sys,xml.etree.ElementTree as ET
nodes=[n for n in ET.parse(sys.argv[1]).getroot().iter('node')
       if n.attrib.get('content-desc')=='Block internet for '+sys.argv[2]]
if len(nodes)!=1: raise SystemExit('Expected one fictional app switch')
value=nodes[0].attrib.get('checked')
if value not in ('true','false'): raise SystemExit('Missing switch state')
print(value)
PY
  )
  if [[ "$current" != "$expected" ]]; then
    tap desc "Block internet for $label"
  fi
  dump_ui
  python3 - "$xml" "$label" "$expected" <<'PY'
import sys,xml.etree.ElementTree as ET
nodes=[n for n in ET.parse(sys.argv[1]).getroot().iter('node')
       if n.attrib.get('content-desc')=='Block internet for '+sys.argv[2]]
assert len(nodes)==1 and nodes[0].attrib.get('checked')==sys.argv[3], 'Fictional app rule did not match requested state'
PY
  echo "PASS VGuard: $label rule state=$expected confirmed through native UI."
}

assert_profile_active() {
  local profile="$1"
  for ((profile_try=0;profile_try<10;profile_try++)); do
    dump_ui
    if grep -q 'text="ACTIVE"' "$xml" && grep -Fq "$profile rules are active." "$xml"; then
      echo "PASS VGuard: native UI confirms $profile rules are ACTIVE."
      return 0
    fi
    sleep 1
  done
  echo "FAIL VGuard: native UI did not confirm active $profile rules." >&2
  return 1
}

device_clock_ms() {
  local uptime
  uptime=$("$adb" shell cat /proc/uptime)
  python3 - "$uptime" <<'PY'
import decimal,sys
print(int(decimal.Decimal(sys.argv[1].split()[0])*1000))
PY
}

wait_persistent_baseline() {
  local file="$1" role="$2" count
  for ((i=0;i<60;i++)); do
    count=$(grep -c '^INSTRUMENTATION_STATUS: outcome=CONNECTED' "$file" || true)
    if [[ "$count" -ge 2 ]]; then
      echo "PASS VGuard: $role existing TCP socket produced at least two connected baseline exchanges."
      return 0
    fi
    sleep .25
  done
  echo "FAIL VGuard: $role persistent TCP socket lacked a reachable baseline." >&2
  echo "Initial persistent attempt evidence ($role):" >&2
  head -n 50 "$file" >&2
  echo "Latest persistent attempt evidence ($role):" >&2
  tail -n 20 "$file" >&2
  return 1
}

return_to_guard
tap contains 'Apps tab'
tap contains 'Normal profile'
set_probe_rule blocked true
set_probe_rule allowed false
tap contains 'Journey profile'
set_probe_rule allowed true
set_probe_rule blocked false
tap contains 'Normal profile'
tap contains 'Overview tab'
assert_off

# Switching the active profile must exchange which independent UID is blocked.
return_to_guard
tap text 'Start blocking'
assert_profile_active Normal
if ! probe blocked NO_CONNECTION tcp; then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
return_to_guard
tap contains 'Journey profile'
assert_profile_active Journey
if ! probe blocked CONNECTED tcp; then failures=$((failures+1));fi
if ! probe allowed NO_CONNECTION tcp; then failures=$((failures+1));fi
return_to_guard
tap contains 'Normal profile'
assert_profile_active Normal
if ! probe blocked NO_CONNECTION tcp; then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
echo 'CHECK VGuard: active Normal/Journey/Normal profile comparisons completed; individual results above.'

# Remove only the selected fictional package, never any real user application.
return_to_guard
"$adb" uninstall app.vguard.qa.blocked
error_seen=false
for ((attempt=0;attempt<10;attempt++)); do
  dump_ui
  if grep -q 'text="ERROR"' "$xml" && grep -q 'None of the selected apps are available' "$xml"; then
    error_seen=true
    break
  fi
  sleep 1
done
if [[ "$error_seen" != true ]]; then
  echo 'FAIL VGuard: removing the final selected installed app did not produce its explicit stopped/error state.' >&2
  failures=$((failures+1))
else
  echo 'PASS VGuard: uninstalling selected fictional app stops blocking with an explicit unavailable-app error.'
fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
"$adb" install -r "${VGUARD_BLOCKED_APK:?}" >/dev/null
return_to_guard
# Reinstallation must not restart filtering without the user's deliberate Retry.
dump_ui
if grep -q 'text="ACTIVE"' "$xml"; then
  echo 'FAIL VGuard: reinstalling a selected package silently restarted filtering.' >&2
  failures=$((failures+1))
fi
if ! probe blocked CONNECTED tcp; then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
return_to_guard
retry_point=$(find_xy text 'Retry blocking') || retry_point=''
if [[ -n "$retry_point" ]]; then
  tap text 'Retry blocking'
else
  # Recreated UI processes truthfully start OFF; the saved rule still needs an
  # explicit start, and must be resolved against the newly installed package.
  tap text 'Start blocking'
fi
assert_profile_active Normal
if ! probe blocked NO_CONNECTION tcp; then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
return_to_guard
tap text 'Stop blocking'
assert_off
if ! probe blocked CONNECTED tcp; then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
echo 'CHECK VGuard: selected package uninstall/reinstall/retry completed; individual results above.'

# Each process establishes exactly one socket and keeps it across activation.
# The probe's tcp_persist mode never reconnects after a failed exchange.
selected_series="$scratch/existing-selected.log"
control_series="$scratch/existing-control.log"
timeout 250 "$adb" shell am instrument -w -e mode tcp_persist -e host 10.0.2.2 \
  -e attempts 90 -e interval_ms 500 -e timeout_ms 2000 \
  app.vguard.qa.blocked/app.vguard.qa.Probe > "$selected_series" 2>&1 &
selected_pid=$!
persistent_baselines=true
if ! wait_persistent_baseline "$selected_series" selected; then persistent_baselines=false;fi
# Start the control only after observing the first app. This is one connection
# attempt per app, not a retry of a failed socket or suppressed failure.
timeout 250 "$adb" shell am instrument -w -e mode tcp_persist -e host 10.0.2.2 \
  -e attempts 90 -e interval_ms 500 -e timeout_ms 2000 \
  app.vguard.qa.allowed/app.vguard.qa.Probe > "$control_series" 2>&1 &
control_pid=$!
if ! wait_persistent_baseline "$control_series" control; then persistent_baselines=false;fi
if [[ "$persistent_baselines" == true ]]; then
return_to_guard
before_activation_ms=$(device_clock_ms)
tap text 'Start blocking'
assert_profile_active Normal
active_ms=$(device_clock_ms)
sleep 8
return_to_guard
before_stop_ms=$(device_clock_ms)
# Freeze receipts before Stop; queued data delivered only after Stop is outside
# the asserted active observation window, so must not be mislabeled as a leak.
active_receipts="$scratch/protocol-before-stop.log"
cp "${VGUARD_PROTOCOL_LOG:?}" "$active_receipts"
tap text 'Stop blocking'
assert_off
# Keep the series intact for its completion/count checks. A dead selected
# socket need not recover after Stop; fresh sockets are tested separately.
wait "$selected_pid" || true
wait "$control_pid" || true
"$adb" shell am force-stop app.vguard.qa.blocked
"$adb" shell am force-stop app.vguard.qa.allowed
if ! python3 "${GITHUB_WORKSPACE:?}/scripts/vguard-persistent-check.py" \
  "$selected_series" "$control_series" "$active_receipts" \
  "$before_activation_ms" "$active_ms" "$before_stop_ms"; then
  failures=$((failures+1))
  python3 - "$selected_series" "$control_series" "$active_receipts" "$before_activation_ms" "$active_ms" "$before_stop_ms" <<'DIAGNOSTICS'
import json,sys
from pathlib import Path
before,active,stop=map(int,sys.argv[4:])
keys=('attempt','outcome','test_token','started_at_ms','ended_at_ms','failure','failure_detail')
active_tokens=set()
for role,path in zip(('selected','control'),sys.argv[1:3]):
    records=[];pending={}
    for line in Path(path).read_text(errors='replace').splitlines():
        if line.startswith('INSTRUMENTATION_STATUS: ') and '=' in line:
            k,v=line[len('INSTRUMENTATION_STATUS: '):].split('=',1);pending[k]=v
        elif line.startswith('INSTRUMENTATION_STATUS_CODE:'):
            records.append(pending);pending={}
    baseline=[r for r in records if r.get('ended_at_ms','').isdigit() and int(r['ended_at_ms'])<before]
    settled=[r for r in records if r.get('started_at_ms','').isdigit() and active<=int(r['started_at_ms'])<stop]
    active_tokens.update(r.get('test_token') for r in settled)
    print('PERSISTENT_EVIDENCE '+json.dumps({'role':role,'baseline':[ {k:r[k] for k in keys if k in r} for r in baseline[-3:]],'active':[ {k:r[k] for k in keys if k in r} for r in settled[:40]],'pending_record':bool(pending)},sort_keys=True))
receipts=[]
for line in Path(sys.argv[3]).read_text(errors='replace').splitlines():
    try:r=json.loads(line)
    except ValueError:continue
    if r.get('token') in active_tokens:receipts.append(r)
print('PERSISTENT_RECEIPTS '+json.dumps(receipts[:80],sort_keys=True))
DIAGNOSTICS
fi
else
  # Baseline failure remains an acceptance failure. Preserve the original
  # attempt before cleanup; independent profile/package cases already ran.
  failures=$((failures+1))
  echo 'FAIL VGuard: existing-socket acceptance blocked by its OFF-state baseline; no activation result claimed.' >&2
  wait "$selected_pid" || true
  wait "$control_pid" || true
  "$adb" shell am force-stop app.vguard.qa.blocked
  "$adb" shell am force-stop app.vguard.qa.allowed
  for series in "$selected_series" "$control_series"; do
    head -n 50 "$series" >&2
    tail -n 20 "$series" >&2
  done
  echo 'DIAGNOSTIC VGuard: emulator network policy and UID process state after baseline failure.'
  "$adb" shell dumpsys netpolicy | head -n 180 || true
  "$adb" shell dumpsys connectivity trafficcontroller | head -n 180 || true
fi
if ! probe blocked CONNECTED tcp; then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi

