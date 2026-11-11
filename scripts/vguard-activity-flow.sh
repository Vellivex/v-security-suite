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

activity_assert_metadata_card_once() {
  # Preserve native card containers for strict same-record association.
  dump_ui uncompressed || return 1
  python3 - "$xml" <<'PY'
import json,re,sys,xml.etree.ElementTree as ET
root=ET.parse(sys.argv[1]).getroot(); parents={child:parent for parent in root.iter() for child in parent}
def bounds(node):
    match=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.attrib.get('bounds',''))
    if not match:return None
    a,b,c,d=map(int,match.groups())
    return (a,b,c,d) if c>a and d>b else None
viewports=[bounds(n) for n in root.iter('node') if n.attrib.get('package')=='app.vguard.firewall' and n.attrib.get('class')=='android.widget.ScrollView']
if len(viewports)!=1 or viewports[0] is None:raise SystemExit(1)
viewport=viewports[0]
endpoints=[n for n in root.iter('node') if n.attrib.get('package')=='app.vguard.firewall' and n.attrib.get('text')=='10.0.2.2:18790']
valid=False
for endpoint in endpoints:
    node=endpoint
    for _ in range(3):
        node=parents.get(node)
        if node is None: break
        texts=[n.attrib.get('text','') for n in node.iter('node')]
        endpoints_here=[t for t in texts if re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}:\d+',t)]
        if len(endpoints_here)==1 and texts.count('Selected app')==1 and texts.count('DROPPED')==1 and any(t.startswith('TCP  /  ') for t in texts):
            fields=[n for n in node.iter('node') if n.attrib.get('text') in ('Selected app','DROPPED','10.0.2.2:18790') or n.attrib.get('text','').startswith('TCP  /  ')]
            boxes=[bounds(n) for n in fields]
            if len(boxes)==4 and all(b and b[1]>viewport[1] and b[3]<viewport[3] for b in boxes):valid=True;break
if not valid:
    evidence=[]
    for endpoint in endpoints[:3]:
        node=endpoint;ancestry=[]
        for _ in range(3):
            node=parents.get(node)
            if node is None:break
            texts=[n.attrib.get('text','') for n in node.iter('node') if n.attrib.get('text')]
            ancestry.append({'class':node.attrib.get('class'),'bounds':node.attrib.get('bounds'),'texts':texts[:50]})
        evidence.append({'target_bounds':endpoint.attrib.get('bounds'),'ancestors':ancestry})
    if evidence:print('ACTIVITY_TARGET_ANCESTRY '+json.dumps(evidence,sort_keys=True),file=sys.stderr)
    raise SystemExit(1)
print('PASS VGuard: native Activity shows DROPPED TCP10.0.2.2:18790 with generic Selected app metadata.')
PY
}

activity_assert_metadata_card() {
  local attempt point x start end gesture scans=0 corrections=0
  echo 'CHECK VGuard: actual initial Activity viewport before metadata discovery.'
  qa_ui_diagnostics
  for ((attempt=0;attempt<6;attempt++));do
    if activity_assert_metadata_card_once;then return 0;fi
    [[ "$attempt" == 5 ]] && break
    dump_ui uncompressed || return 1
    point=$(python3 - "$xml" <<'PY'
import re,sys,xml.etree.ElementTree as ET
root=ET.parse(sys.argv[1]).getroot()
nodes=[n for n in root.iter('node')
       if n.attrib.get('package')=='app.vguard.firewall'
       and n.attrib.get('class')=='android.widget.ScrollView'
       and n.attrib.get('scrollable')=='true' and n.attrib.get('enabled')=='true']
if len(nodes)!=1:raise SystemExit(1)
m=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',nodes[0].attrib.get('bounds',''))
if not m:raise SystemExit(1)
left,top,right,bottom=map(int,m.groups())
if right<=left or bottom-top<100:raise SystemExit(1)
height=bottom-top;middle=(top+bottom)//2;targets=[]
for node in root.iter('node'):
    if node.attrib.get('package')!='app.vguard.firewall' or node.attrib.get('text')!='10.0.2.2:18790':continue
    match=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.attrib.get('bounds',''))
    if match:
        x1,y1,x2,y2=map(int,match.groups())
        if x2>x1 and y2>y1 and top<=y1<y2<=bottom:targets.append((y2-y1,(y1+y2)//2))
if targets:
    _,target=max(targets,key=lambda pair:(pair[0],-abs(pair[1]-middle)))
    delta=max(-(height//4),min(height//4,middle-target))
    if abs(delta)<height//10:raise SystemExit(1)
    print((left+right)//2,middle,middle+delta,'center')
else:
    print((left+right)//2,top+3*height//4,top+height//4,'scan')
PY
    ) || break
    read -r x start end gesture <<< "$point"
    if [[ "$gesture" == center ]];then
      [[ "$corrections" -ge 2 ]] && break
      corrections=$((corrections+1))
    else
      [[ "$scans" -ge 3 ]] && break
      scans=$((scans+1))
    fi
    echo "CHECK VGuard: native metadata $gesture gesture from fresh viewport; scans=$scans corrections=$corrections."
    "$adb" shell input swipe "$x" "$start" "$x" "$end" 300 >/dev/null || return 1
  done
  return 1
}

vguard_card_flow() {
  return_to_guard || return 1
  tap nav 'Overview tab' || return 1
  assert_profile_active Normal || return 1
  probe blocked NO_CONNECTION tcp || return 1
  probe allowed CONNECTED tcp || return 1
  return_to_guard || return 1
  tap nav 'Overview tab' || return 1
  tap text 'Stop blocking' || return 1
  assert_off || return 1
  tap nav 'Activity tab' || return 1
  if ! activity_assert_metadata_card;then
    echo 'FAIL VGuard: retained controlled TCP history card was not fully observed after Stop.' >&2
    qa_ui_diagnostics
    return 1
  fi
  echo 'PASS VGuard: real Stop retains a complete native controlled TCP history card with generic app label and dropped status.'
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
  if ! activity_assert_metadata_card;then
    failures=$((failures+1))
    echo 'FAIL VGuard: bounded native viewports did not show a complete controlled TCP metadata card.' >&2
    qa_ui_diagnostics
  fi
  # Rebuild the Activity screen at its top for the actual export controls.
  tap nav 'Activity tab' || return 1
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
  if ! activity_assert_metadata_card;then
    failures=$((failures+1))
    echo 'FAIL VGuard: bounded native viewports did not show a complete controlled TCP metadata card.' >&2
    qa_ui_diagnostics
  fi
  # Rebuild the Activity screen at its top for the actual export controls.
  tap nav 'Activity tab' || return 1
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

