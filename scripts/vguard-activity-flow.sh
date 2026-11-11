#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Sourced only in the disposable Android QA emulator. Requires the parent
# adb/xml/dump_ui/tap/probe/return_to_guard/assert_off/assert_profile_active helpers.
# Input and successful output: Normal profile ACTIVE, only Blocked probe selected.

activity_picker_point() {
  local kind="$1" label="${2:-}"
  dump_ui || return 2
  python3 - "$xml" "$kind" "$label" <<'PY'
import re,sys,xml.etree.ElementTree as ET
path,kind,label=sys.argv[1:]
root=ET.parse(path).getroot()
parents={child:parent for parent in root.iter() for child in parent}
nodes=[]
for node in root.iter('node'):
    a=node.attrib
    if a.get('package') not in ('com.android.documentsui','com.google.android.documentsui') or a.get('enabled')!='true': continue
    if kind=='filename':
        match=a.get('class')=='android.widget.EditText' and (a.get('text','').startswith('VGuard-') or a.get('resource-id','').endswith(':id/title'))
    elif kind=='root':
        match=a.get('text','').casefold()==label.casefold()
        ancestor=parents.get(node);in_roots=False
        while ancestor is not None:
            aa=ancestor.attrib
            if aa.get('resource-id','').endswith('/roots_list') or aa.get('class')=='android.widget.ListView':in_roots=True
            ancestor=parents.get(ancestor)
        match=match and in_roots
    else: match=a.get('content-desc' if kind=='desc' else 'text','').casefold()==label.casefold()
    if not match: continue
    b=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',a.get('bounds',''))
    if b:
        x,y,r,z=map(int,b.groups())
        if r>x and z>y: nodes.append(((x+r)//2,(y+z)//2))
if len(nodes)!=1:
    print('Expected one Android document control; matches='+str(len(nodes)),file=sys.stderr)
    sys.exit(1)
print(*nodes[0])
PY
}

activity_picker_tap() {
  local kind="$1" label="${2:-}" point attempt
  for ((attempt=0;attempt<5;attempt++)); do
    if point=$(activity_picker_point "$kind" "$label"); then
      read -r activity_x activity_y <<< "$point"
      "$adb" shell input tap "$activity_x" "$activity_y" >/dev/null || return 1
      return 0
    fi
    sleep 1
  done
  echo "FAIL VGuard: missing unambiguous Android document control ($kind:$label)." >&2
  qa_ui_diagnostics
  return 1
}

activity_picker_prepare() {
  local name="$1" point label attempt
  # Use only bounds exposed by this actual Android DocumentsUI instance.
  for ((attempt=0;attempt<5;attempt++)); do
    dump_ui || return 1
    if grep -Eq 'package="com\.(google\.android|android)\.documentsui"' "$xml"; then break; fi
    sleep 1
  done
  if ! grep -Eq 'package="com\.(google\.android|android)\.documentsui"' "$xml"; then
    echo 'FAIL VGuard: Export did not open Android DocumentsUI.' >&2; return 1
  fi
  for label in 'Show roots' 'Open navigation drawer'; do
    if point=$(activity_picker_point desc "$label" 2>/dev/null); then
      read -r activity_x activity_y <<< "$point"
      "$adb" shell input tap "$activity_x" "$activity_y" >/dev/null || return 1
      break
    fi
  done
  activity_picker_tap root Downloads || return 1
  activity_picker_tap filename || return 1
  "$adb" shell input keyevent 123 >/dev/null || return 1
  for ((attempt=0;attempt<4;attempt++)); do
    "$adb" shell input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 >/dev/null || return 1
  done
  "$adb" shell input text "$name" >/dev/null || return 1
  dump_ui || return 1
  python3 - "$xml" "$name" <<'PY'
import sys,xml.etree.ElementTree as ET
nodes=[n for n in ET.parse(sys.argv[1]).getroot().iter('node') if n.attrib.get('class')=='android.widget.EditText' and n.attrib.get('text')==sys.argv[2] and n.attrib.get('package') in ('com.android.documentsui','com.google.android.documentsui')]
assert len(nodes)==1, 'Disposable export filename was not entered exactly'
PY
}

activity_assert_metadata_card() {
  dump_ui || return 1
  python3 - "$xml" <<'PY'
import sys,xml.etree.ElementTree as ET
root=ET.parse(sys.argv[1]).getroot(); parents={child:parent for parent in root.iter() for child in parent}
endpoints=[n for n in root.iter('node') if n.attrib.get('package')=='app.vguard.firewall' and n.attrib.get('text')=='10.0.2.2:18790']
valid=False
for endpoint in endpoints:
    node=endpoint
    for _ in range(3):
        node=parents.get(node)
        if node is None: break
        texts=[n.attrib.get('text','') for n in node.iter('node')]
        if 'Selected app' in texts and 'DROPPED' in texts and any(t.startswith('TCP  /  ') for t in texts): valid=True;break
assert valid, 'No real dropped TCP endpoint card with generic Selected app label'
print('PASS VGuard: native Activity shows DROPPED TCP10.0.2.2:18790 with generic Selected app metadata.')
PY
}

activity_network_diagnostics() {
  [[ "$("$adb" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || return 0
  "$adb" shell dumpsys netpolicy > "$scratch/export-netpolicy.txt" || true
  "$adb" shell dumpsys connectivity trafficcontroller > "$scratch/export-trafficcontroller.txt" || true
  python3 - "$scratch/export-netpolicy.txt" "$scratch/export-trafficcontroller.txt" \
    "$(package_uid app.vguard.qa.blocked)" "$(package_uid app.vguard.qa.allowed)" <<'PY'
import json,sys
from pathlib import Path
for path in sys.argv[1:3]:
    lines=Path(path).read_text(errors='replace').splitlines()
    chosen=set(range(min(40,len(lines))))
    for index,line in enumerate(lines):
        if any(uid in line for uid in sys.argv[3:]):
            chosen.update(range(max(0,index-2),min(len(lines),index+3)))
    print('EMULATOR_NETWORK_POLICY '+json.dumps({'source':Path(path).name,'total_lines':len(lines),'lines':[[i+1,lines[i][:300]] for i in sorted(chosen)[:160]]},sort_keys=True))
PY
}

vguard_activity_flow() {
  local baseline_ok=true payload_ready=true tcp_token udp_token="" udp_stage activity_start_epoch cancel_name save_name remote_csv local_csv attempt
  return_to_guard || return 1
  tap nav 'Overview tab' || return 1
  assert_profile_active Normal || return 1
  # A reachable UDP baseline makes the payload omission test meaningful: a
  # blocked TCP SYN cannot carry the application token, but a UDP datagram can.
  tap text 'Stop blocking' || return 1
  assert_off || return 1
  if ! probe blocked CONNECTED udp; then baseline_ok=false; fi
  if ! probe allowed CONNECTED udp; then baseline_ok=false; fi
  if [[ "$baseline_ok" != true ]];then activity_network_diagnostics;fi
  return_to_guard || return 1
  tap nav 'Overview tab' || return 1
  tap text 'Start blocking' || return 1
  assert_profile_active Normal || return 1
  if [[ "$baseline_ok" != true ]]; then
    echo 'BLOCKED VGuard: Activity payload omission has no complete reachable UDP baseline; export/clear will be checked independently.' >&2
    blockers=$((blockers+1))
    payload_ready=false
  fi
  activity_start_epoch=$("$adb" shell date +%s | tr -d '\r') || return 1
  if [[ ! "$activity_start_epoch" =~ ^[0-9]{10}$ ]]; then
    echo 'FAIL VGuard: missing device timestamp for fresh Activity evidence.' >&2; return 1
  fi
  if [[ "$baseline_ok" == true ]];then
    if ! probe blocked NO_CONNECTION udp;then failures=$((failures+1));payload_ready=false;fi
    udp_token=$(printf '%s\n' "$probe_result" | sed -nE 's/^INSTRUMENTATION_RESULT: test_token=(.*)\r?$/\1/p' | tr -d '\r' | tail -1)
    udp_stage=$(printf '%s\n' "$probe_result" | sed -nE 's/^INSTRUMENTATION_RESULT: udp_stage=(.*)\r?$/\1/p' | tr -d '\r' | tail -1)
    if [[ "$udp_stage" != receive || -z "$udp_token" ]];then
      echo 'FAIL VGuard: blocked UDP did not prove successful send/receive-wait with a unique payload token.' >&2
      failures=$((failures+1));payload_ready=false
    fi
    if ! probe allowed CONNECTED udp;then failures=$((failures+1));payload_ready=false;fi
    if [[ "$payload_ready" != true ]];then activity_network_diagnostics;fi
  fi
  probe blocked NO_CONNECTION tcp || return 1
  tcp_token=$(printf '%s\n' "$probe_result" | sed -nE 's/^INSTRUMENTATION_RESULT: test_token=(.*)\r?$/\1/p' | tr -d '\r' | tail -1)
  probe allowed CONNECTED tcp || return 1
  if [[ -z "$tcp_token" || ( "$payload_ready" == true && ( -z "$udp_token" || "$tcp_token" == "$udp_token" ) ) ]]; then
    echo 'FAIL VGuard: Activity probes lack distinct tokens.' >&2; return 1
  fi
  return_to_guard || return 1
  tap nav 'Activity tab' || return 1
  activity_assert_metadata_card || return 1
  cancel_name="VGuard-QA-cancel-$(date +%s%N).csv"
  save_name="VGuard-QA-activity-$(date +%s%N).csv"
  remote_csv="/sdcard/Download/$save_name"
  local_csv="$scratch/$save_name"
  if "$adb" shell test -e "/sdcard/Download/$cancel_name" || "$adb" shell test -e "$remote_csv"; then
    echo 'FAIL VGuard: disposable export path already exists.' >&2; return 1
  fi
  tap text 'Export CSV' || return 1
  activity_picker_prepare "$cancel_name" || return 1
  # Back can first dismiss an IME. Stop only when the actual picker is gone.
  for ((attempt=0;attempt<3;attempt++)); do
    "$adb" shell input keyevent 4 >/dev/null || return 1
    dump_ui || return 1
    if ! grep -Eq 'package="com\.(google\.android|android)\.documentsui"' "$xml"; then break; fi
  done
  activity_assert_metadata_card || return 1
  if "$adb" shell test -e "/sdcard/Download/$cancel_name"; then
    echo 'FAIL VGuard: canceled export created a file.' >&2; return 1
  fi
  echo 'PASS VGuard: actual Android document-picker cancellation leaves activity intact and creates no selected file.'
  tap text 'Export CSV' || return 1
  activity_picker_prepare "$save_name" || return 1
  activity_picker_tap text Save || return 1
  for ((attempt=0;attempt<15;attempt++)); do
    if "$adb" shell test -s "$remote_csv"; then break; fi
    sleep 1
  done
  "$adb" shell test -s "$remote_csv" || { echo 'FAIL VGuard: Android-selected CSV was not written.' >&2; return 1; }
  "$adb" pull "$remote_csv" "$local_csv" >/dev/null || return 1
  python3 - "$local_csv" "$tcp_token" "$udp_token" "$activity_start_epoch" "$payload_ready" <<'PY'
import csv,datetime,ipaddress,io,re,sys
path,tcp_token,udp_token,start_epoch,payload_ready=sys.argv[1:]; raw=open(path,'r',encoding='utf-8',newline='').read()
for secret in (tcp_token,udp_token,'test_token','app.vguard.qa.blocked','app.vguard.qa.allowed'):
    if secret:assert secret not in raw, 'CSV contained probe payload or inferred package attribution'
reader=csv.DictReader(io.StringIO(raw,newline=''))
assert reader.fieldnames==['timestamp_utc','app','destination','port','protocol'], 'Unexpected CSV schema'
rows=list(reader); assert 1<=len(rows)<=200, 'Activity export outside the documented bound'
for row in rows:
    assert set(row)==set(reader.fieldnames) and all(v is not None for v in row.values()), 'Malformed CSV row'
    assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',row['timestamp_utc']), 'Timestamp lacks exact UTC format'
    datetime.datetime.fromisoformat(row['timestamp_utc'].replace('Z','+00:00'))
    assert row['app']=='Selected app', 'CSV inferred an individual app identity'
    ipaddress.ip_address(row['destination'])
    assert not row['port'] or 1<=int(row['port'])<=65535, 'Invalid port metadata'
expected=[('18790','TCP')]+([('18791','UDP')] if payload_ready=='true' else [])
for port,protocol in expected:
    assert any(r['destination']=='10.0.2.2' and r['port']==port and r['protocol']==protocol and datetime.datetime.fromisoformat(r['timestamp_utc'].replace('Z','+00:00')).timestamp()>=int(start_epoch) for r in rows), 'Missing fresh controlled '+protocol+' metadata'
print('PASS VGuard: Android-saved CSV has exact five-column metadata schema, '+str(len(rows))+' bounded rows and fresh controlled TCP metadata.')
if payload_ready=='true':print('PASS VGuard: CSV includes fresh controlled UDP metadata and omits its actually transmitted unique payload token.')
else:print('BLOCKED VGuard: CSV payload omission remains unproven because UDP evidence was unavailable.')
PY
  if [[ "$?" != 0 ]]; then return 1;fi
  return_to_guard || return 1
  tap nav 'Activity tab' || return 1
  tap text 'Clear activity' || return 1
  tap text Clear || return 1
  dump_ui || return 1
  python3 - "$xml" <<'PY'
import sys,xml.etree.ElementTree as ET
nodes=[n for n in ET.parse(sys.argv[1]).getroot().iter('node') if n.attrib.get('package')=='app.vguard.firewall']
assert any(n.attrib.get('text')=='NO ENTRIES THIS APP SESSION' for n in nodes), 'Clear did not empty Activity'
assert any(n.attrib.get('text')=='No activity recorded' for n in nodes), 'Activity empty-state missing'
for label in ('Export CSV','Clear activity'):
    found=[n for n in nodes if n.attrib.get('text')==label]
    assert len(found)==1 and found[0].attrib.get('enabled')=='false', 'Empty activity action remains enabled'
print('PASS VGuard: actual Clear action empties Activity and disables empty export/clear controls.')
PY
  if [[ "$?" != 0 ]]; then return 1;fi
  tap nav 'Overview tab' || return 1
  assert_profile_active Normal || return 1
  probe blocked NO_CONNECTION tcp || return 1
  probe allowed CONNECTED tcp || return 1
  return_to_guard || return 1
  tap nav 'Overview tab' || return 1
  assert_profile_active Normal || return 1
  echo 'PASS VGuard: export/cancel/clear leave Normal blocking and independent allowed control intact.'
}

