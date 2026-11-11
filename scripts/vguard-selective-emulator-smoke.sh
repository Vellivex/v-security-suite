#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# One-off isolated Android emulator selective-VPN protocol and lifecycle test.
# Requires successful baseline and two fictional probe APKs, firewall initially OFF.
set -euo pipefail
sdk="${1:?SDK root}"
adb="$sdk/platform-tools/adb"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
xml="$scratch/window.xml"

dump_ui() {
  local target='/data/local/tmp/vguard-qa-window.xml'
  local output
  "$adb" shell rm -f "$target" >/dev/null 2>&1 || true
  output=$(timeout 16 "$adb" shell uiautomator dump --compressed "$target" 2>&1) || {
    echo "Android UI dump command failed: ${output:0:180}" >&2
    return 2
  }
  if ! "$adb" shell test -s "$target" >/dev/null 2>&1; then
    echo "Android UI hierarchy file not produced: ${output:0:180}" >&2
    return 2
  fi
  timeout 8 "$adb" exec-out cat "$target" > "$xml"
  test -s "$xml"
}
# Find an element by exact or substring text/description, returning centre coordinates.
find_xy() {
  local selector="$1" needle="$2"
  dump_ui || return $?
  python3 - "$xml" "$selector" "$needle" <<'PY'
import sys,xml.etree.ElementTree as ET,re
source,kind,needle=sys.argv[1:]
raw=open(source,'rb').read()
start=raw.find(b'<?xml')
if start<0: start=raw.find(b'<hierarchy')
if start<0:
    # Only an ephemeral emulator is involved; don't log the UI contents.
    print('QA XML dump has no hierarchy; bytes='+str(len(raw))+
          '; first20_hex='+raw[:20].hex(),file=sys.stderr)
    sys.exit(2)
try: root=ET.fromstring(raw[start:])
except ET.ParseError:
    print('QA XML hierarchy was malformed; bytes='+str(len(raw))+
          '; first20_hex='+raw[:20].hex(),file=sys.stderr)
    sys.exit(2)
for el in root.iter('node'):
    if kind=='vpn_text' and el.attrib.get('package')!='com.android.vpndialogs': continue
    s=el.attrib.get('content-desc' if kind=='desc' else 'text','')
    if s.casefold()==needle.casefold() or (kind=='contains' and needle.casefold() in (s+' '+el.attrib.get('content-desc','')).casefold()):
        if el.attrib.get('enabled')!='true': continue
        m=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',el.attrib.get('bounds',''))
        if m:
            a,b,c,d=map(int,m.groups())
            if c>a and d>b: print((a+c)//2,(b+d)//2);sys.exit(0)
sys.exit(1)
PY
}
tap() {
  local kind="$1" label="$2" point tries
  for ((tries=0;tries<6;tries++)); do
    local rc=0
    point=$(find_xy "$kind" "$label") || rc=$?
    if [[ "$rc" == 0 ]]; then
      read -r x y <<< "$point"
      "$adb" shell input tap "$x" "$y" >/dev/null
      return 0
    fi
    if [[ "$rc" == 2 ]]; then
      echo 'FAIL VGuard QA: accessibility XML unavailable; cannot perform safe UI automation.' >&2
      return 2
    fi
    sleep 1
  done
  echo "FAIL VGuard: cannot find expected emulator control ($kind:$label)." >&2
  return 1
}
failures=0
blockers=0
declare -A baseline_ready
probe_result=''
probe() {
  local role="$1" expected="$2" mode="${3:-http}" host="${4:-10.0.2.2}" result outcome deadline=20
  [[ "$mode" == resolve ]] && deadline=65
  result=$(timeout "$deadline" "$adb" shell am instrument -w -e mode "$mode" -e timeout_ms 2000 \
   -e host "$host" -e url http://10.0.2.2:18789/check "app.vguard.qa.$role/app.vguard.qa.Probe" 2>&1) || {
    echo "FAIL VGuard: fictional $role $mode instrumentation failed or exceeded ${deadline}s; this is not a blocking pass." >&2
    return 1
  }
  probe_result="$result"
  outcome=$(printf '%s\n' "$result" | sed -nE 's/^INSTRUMENTATION_RESULT: outcome=([A-Z_]+)\r?$/\1/p' | tail -1)
  printf '%s\n' "$result" | grep -E '^INSTRUMENTATION_RESULT: (test_uid|process_importance|active_network|failure|failure_detail|failure_cause|udp_stage|networks_tried|network_results)=' || true
  if [[ "$outcome" != "$expected" ]]; then
    echo "FAIL VGuard: fictional $role $mode to $host outcome ${outcome:-unknown}, expected $expected." >&2
    return 1
  fi
  if [[ "$mode" == tcp || "$mode" == udp ]]; then
    local token receipt=false
    token=$(printf '%s\n' "$result" | sed -nE 's/^INSTRUMENTATION_RESULT: test_token=(.*)\r?$/\1/p' | tr -d '\r' | tail -1)
    if [[ -z "$token" ]]; then echo 'FAIL VGuard: probe omitted its unique token.' >&2; return 1; fi
    for ((receipt_try=0;receipt_try<10;receipt_try++)); do
      if grep -Fq "$token" "${VGUARD_PROTOCOL_LOG:?}"; then receipt=true; break; fi
      [[ "$expected" != CONNECTED ]] && break
      sleep .1
    done
    if [[ "$expected" == CONNECTED && "$receipt" != true ]] || [[ "$expected" == NO_CONNECTION && "$receipt" == true ]]; then
      echo "FAIL VGuard: $role $mode host receipt disagrees with expected $expected." >&2
      return 1
    fi
    echo "PASS VGuard: $role $mode unique host receipt=$receipt agrees with expected $expected."
  fi
  if [[ "$mode" == resolve ]]; then
    local addresses receipt=false
    addresses=$(printf '%s\n' "$result" | sed -nE 's/^INSTRUMENTATION_RESULT: addresses=(.*)\r?$/\1/p' | tr -d '\r' | tail -1)
    for ((receipt_try=0;receipt_try<10;receipt_try++)); do
      if grep -Fq "\"name\": \"$host\"" "${VGUARD_DNS_LOG:?}"; then receipt=true;break;fi
      [[ "$expected" != CONNECTED ]] && break
      sleep .1
    done
    if [[ "$expected" == CONNECTED && ( "$addresses" != '10.0.2.2' || "$receipt" != true ) ]] || [[ "$expected" == NO_CONNECTION && "$receipt" == true ]]; then
      echo "FAIL VGuard: $role DNS address/host-receipt does not corroborate $expected." >&2
      return 1
    fi
    echo "PASS VGuard: $role ordinary Android DNS exact-address and unique-name receipt agree with $expected."
  fi
  echo "PASS VGuard: fictional $role $mode to $host outcome=$expected."
}
probe_pair() {
  local selected_expected="$1" phase="$2" mode good
  for mode in http tcp udp underlying_http; do
    if [[ "$selected_expected" == NO_CONNECTION && "${baseline_ready[$mode]:-false}" != true ]]; then
      echo "BLOCKED VGuard: $phase $mode has no matching stable OFF baseline; no filtering pass claimed."
      continue
    fi
    good=true
    echo "CHECK VGuard: $phase $mode selected/control pair."
    if ! probe blocked "$selected_expected" "$mode"; then failures=$((failures+1)); good=false; fi
    if ! probe allowed CONNECTED "$mode"; then failures=$((failures+1)); good=false; fi
    if [[ "$selected_expected" == CONNECTED ]]; then baseline_ready[$mode]="$good"; fi
  done
}
dns_pair() {
  local selected_expected="$1" phase="$2" role expected good=true name
  if [[ "${VGUARD_PROBE_DNS:-false}" != true ]]; then return 0; fi
  if [[ "$selected_expected" == NO_CONNECTION && "${baseline_ready[dns]:-false}" != true ]]; then
    echo 'BLOCKED VGuard: ordinary DNS lacked both matching OFF baselines.'
    return 0
  fi
  for role in blocked allowed; do
    expected=CONNECTED
    [[ "$role" == blocked ]] && expected="$selected_expected"
    name="$phase-$role-$(date +%s%N).vguard.test"
    if ! probe "$role" "$expected" resolve "$name"; then failures=$((failures+1));good=false;fi
  done
  if [[ "$selected_expected" == CONNECTED ]]; then baseline_ready[dns]="$good";fi
}
ipv6_ready=false
ipv6_pair() {
  local selected_expected="$1" phase="$2" mode role expected good=true
  if [[ "$phase" != baseline && "$ipv6_ready" != true ]]; then return 0; fi
  for mode in tcp udp; do
    for role in blocked allowed; do
      expected=CONNECTED
      [[ "$role" == blocked ]] && expected="$selected_expected"
      if ! probe "$role" "$expected" "$mode" fec0::2; then
        good=false
        if [[ "$phase" != baseline ]]; then failures=$((failures+1));fi
      fi
    done
  done
  if [[ "$phase" == baseline ]]; then
    ipv6_ready="$good"
    if [[ "$good" != true ]]; then
      blockers=$((blockers+1))
      echo 'BLOCKED VGuard: controlled IPv6 endpoint lacked complete reachable guest baselines; no IPv6 enforcement claim.'
    else
      echo 'PASS VGuard: both independent apps have controlled native IPv6 TCP/UDP baselines.'
    fi
  fi
}
return_to_guard() {
  local launch
  launch=$(timeout 20 "$adb" shell am start -W -n app.vguard.firewall/.MainActivity)
  if ! grep -q '^Status: ok' <<< "$launch"; then
    echo 'FAIL VGuard: unable to return to the firewall activity.' >&2
    return 1
  fi
}
assert_off() {
  local attempt
  for ((attempt=0;attempt<8;attempt++)); do
    if find_xy text 'Start blocking' >/dev/null; then
      echo 'PASS VGuard: native UI confirms blocking is OFF.'
      return 0
    fi
    sleep 1
  done
  echo 'FAIL VGuard: native UI did not return to Start blocking.' >&2
  return 1
}
assert_active() {
  local attempt
  for ((attempt=0;attempt<8;attempt++)); do
    sleep 1
    dump_ui || continue
    if grep -q 'text="ACTIVE"' "$xml"; then
      echo 'PASS VGuard: native UI confirms blocking is ACTIVE.'
      return 0
    fi
  done
  echo 'FAIL VGuard: native UI never reported ACTIVE.' >&2
  return 1
}
# The preceding baseline harness owns the controlled local HTTP server.
# Reuse its listener; never open a competing port or access remote services.
curl -fsS --max-time 2 http://127.0.0.1:18789/check >/dev/null
echo 'PASS VGuard: previously verified local-only test server remains reachable.'
if [[ "${VGUARD_CORE_ONLY:-false}" == true ]]; then
  baseline_ready[tcp]=true
  if ! probe blocked CONNECTED tcp; then failures=$((failures+1));baseline_ready[tcp]=false;fi
  if ! probe allowed CONNECTED tcp; then failures=$((failures+1));baseline_ready[tcp]=false;fi
else
probe_pair CONNECTED baseline
dns_pair CONNECTED baseline
echo 'CHECK VGuard: disposable guest IPv6 addresses and routes.'
"$adb" shell ip -6 addr show
"$adb" shell ip -6 route show
ipv6_pair CONNECTED baseline
if ! probe blocked PERMISSION_DENIED service_access; then failures=$((failures+1));fi
if ! probe allowed PERMISSION_DENIED service_access; then failures=$((failures+1));fi
fi
"$adb" shell monkey -p app.vguard.firewall -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 1
tap desc 'Apps tab'
tap desc 'Search apps or package names'
# Clear any restored fictional query before entering the expected app name.
"$adb" shell input keyevent 123 >/dev/null
"$adb" shell input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 >/dev/null
"$adb" shell input text 'VGuard%sQA%sBlocked' >/dev/null
"$adb" shell input keyevent 4 >/dev/null
sleep 2
tap desc 'Block internet for VGuard QA Blocked'
echo 'PASS VGuard: fictional Blocked app toggle interacted with via real native UI.'
tap desc 'Overview tab'
dump_ui
if ! grep -q '1 app selected' "$xml"; then
  echo 'FAIL VGuard: blocked-app selection did not persist in Overview. No VPN started.' >&2
  python3 - "$xml" <<'PY'
import sys,xml.etree.ElementTree as ET
root=ET.parse(sys.argv[1]).getroot()
values=[x.attrib.get('text','') for x in root.iter('node') if x.attrib.get('text','')]
print('QA overview labels:',repr([s[:90] for s in values if any(q in s.lower() for q in ['blocking','selected','apps','error'])][:12]))
PY
  exit 1
fi
echo 'PASS VGuard: Overview confirms exactly one fictional app selected before VPN start.'
tap text 'Start blocking'
sleep 1
permission='already_granted'
# VpnService.prepare() can return null if Android consent already exists.
point=$(find_xy text 'Continue') || point=''
if [[ -n "$point" ]]; then
  read -r x y <<< "$point"
  "$adb" shell input tap "$x" "$y" >/dev/null
  permission='dialog_presented'
  sleep 1
  tap vpn_text 'Cancel'
  assert_off
  if [[ "${baseline_ready[tcp]:-false}" == true ]]; then
    if ! probe blocked CONNECTED tcp; then failures=$((failures+1));fi
    if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
  fi
  echo 'CHECK VGuard: initial Android VPN consent canceled; OFF state and independent network results recorded.'
  return_to_guard
  tap text 'Start blocking'
  tap text 'Continue'
  sleep 1
  permission='cancelled_then_pending'
  confirmed=false
  for option in OK Allow Connect; do
    point=$(find_xy vpn_text "$option") || point=''
    if [[ -n "$point" ]]; then
      read -r x y <<< "$point"
      "$adb" shell input tap "$x" "$y" >/dev/null
      confirmed=true
      permission='cancelled_then_approved'
      break
    fi
  done
  if [[ "$confirmed" != 'true' ]]; then
    echo 'NOTICE VGuard: Android VPN permission button not found; checking whether consent is already granted.'
  fi
fi
if [[ "$permission" != 'cancelled_then_approved' ]]; then
  blockers=$((blockers+1))
  echo 'BLOCKED VGuard: fresh Android VPN consent cancellation was not observed.'
fi
assert_active
echo "PASS VGuard: actual Android emulator UI reports ACTIVE, permission path=$permission."
if [[ "${VGUARD_CORE_ONLY:-false}" == true ]]; then
  if [[ "${baseline_ready[tcp]:-false}" == true ]]; then
    if ! probe blocked NO_CONNECTION tcp; then failures=$((failures+1));fi
    if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
  fi
  return_to_guard
  tap text 'Stop blocking'
  assert_off
  if ! probe blocked CONNECTED tcp; then failures=$((failures+1));fi
  if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
else
probe_pair NO_CONNECTION active
dns_pair NO_CONNECTION active
ipv6_pair NO_CONNECTION active
# Return explicitly after instrumentation, retaining the running VPN.
return_to_guard
tap text 'Stop blocking'
assert_off
probe_pair CONNECTED stopped
dns_pair CONNECTED stopped
ipv6_pair CONNECTED stopped

# Restart using the saved rule and consent, then force-stop the app. The
# documented behavior is loss of filtering, not fail-closed protection.
return_to_guard
tap text 'Start blocking'
assert_active
probe_pair NO_CONNECTION restarted
"$adb" shell am force-stop app.vguard.firewall
return_to_guard
assert_off
probe_pair CONNECTED force-stopped
echo 'CHECK VGuard: force-stop/reopen completed; per-protocol results recorded above.'

# Retained selection can be deliberately restarted, and removing the last
# selection through the ordinary interface must stop the VPN.
return_to_guard
tap text 'Start blocking'
assert_active
if [[ "${baseline_ready[tcp]:-false}" == true ]]; then
  if ! probe blocked NO_CONNECTION tcp; then failures=$((failures+1));fi
  if ! probe allowed CONNECTED tcp; then failures=$((failures+1));fi
else
  echo 'BLOCKED VGuard: final TCP selection check lacks a matching OFF baseline.'
fi
return_to_guard
tap desc 'Apps tab'
tap desc 'Search apps or package names'
# Clear any restored fictional query before entering the expected app name.
"$adb" shell input keyevent 123 >/dev/null
"$adb" shell input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 >/dev/null
"$adb" shell input text 'VGuard%sQA%sBlocked' >/dev/null
"$adb" shell input keyevent 4 >/dev/null
sleep 2
tap desc 'Block internet for VGuard QA Blocked'
tap desc 'Overview tab'
assert_off
probe_pair CONNECTED final-rule-removed
echo 'CHECK VGuard: final-rule removal completed; per-protocol results recorded above.'
fi
# Core UI lifecycle checks reuse the same fictional probes and controlled hosts.
if [[ "${VGUARD_FINAL_ONLY:-false}" == true ]];then
  source "${GITHUB_WORKSPACE:?}/scripts/vguard-final-lifecycle.sh"
else
  source "${GITHUB_WORKSPACE:?}/scripts/vguard-core-lifecycle.sh"
fi
echo 'NOTICE VGuard: real GrapheneOS/device, sleep/network transitions and cross-VPN compatibility remain untested. IPv6 is verified only when its explicit baseline/active/stopped comparisons passed.'
if [[ "$failures" -gt 0 ]]; then
  echo "FAIL VGuard: completed independent protocol/lifecycle checks with $failures unresolved assertions; no full acceptance pass."
  exit 1
fi
if [[ "$blockers" -gt 0 ]]; then
  echo "BLOCKED VGuard: available checks completed, but $blockers protocol baseline remains unavailable; no full acceptance pass."
  exit 1
fi
if [[ "${VGUARD_FINAL_ONLY:-false}" == true ]];then
  echo 'PASS VGuard: emulator final identity and recovery acceptance completed.'
elif [[ "${VGUARD_CORE_ONLY:-false}" == true ]]; then
  echo 'PASS VGuard: emulator core lifecycle acceptance completed.'
else
  echo 'PASS VGuard: emulator protocol and lifecycle acceptance completed.'
fi
