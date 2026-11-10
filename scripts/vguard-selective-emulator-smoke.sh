#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# One-off isolated Android emulator selective-VPN smoke test.
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
  dump_ui || return 1
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
probe() {
  local role="$1" expected="$2" result outcome
  result=$(timeout 18 "$adb" shell am instrument -w -e mode http -e timeout_ms 2000 \
   -e url http://10.0.2.2:18789/check "app.vguard.qa.$role/app.vguard.qa.Probe" 2>&1) || {
    echo "FAIL VGuard: fictional $role probe instrumentation unavailable." >&2
    return 1
  }
  outcome=$(printf '%s\n' "$result" | sed -nE 's/^INSTRUMENTATION_RESULT: outcome=([A-Z_]+)\r?$/\1/p' | tail -1)
  if [[ "$outcome" != "$expected" ]]; then
    echo "FAIL VGuard: fictional $role network outcome ${outcome:-unknown}, expected $expected." >&2
    return 1
  fi
  echo "PASS VGuard: fictional $role probe outcome=$expected."
}
# The preceding baseline harness owns the controlled local HTTP server.
# Reuse its listener; never open a competing port or access remote services.
curl -fsS --max-time 2 http://127.0.0.1:18789/check >/dev/null
echo 'PASS VGuard: previously verified local-only test server remains reachable.'
probe blocked CONNECTED
probe allowed CONNECTED
"$adb" shell monkey -p app.vguard.firewall -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 1
tap desc 'Apps tab'
tap desc 'Search apps or package names'
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
  confirmed=false
  for option in OK Allow Connect; do
    point=$(find_xy text "$option") || point=''
    if [[ -n "$point" ]]; then
      read -r x y <<< "$point"
      "$adb" shell input tap "$x" "$y" >/dev/null
      confirmed=true
      break
    fi
  done
  if [[ "$confirmed" != 'true' ]]; then
    echo 'NOTICE VGuard: Android VPN permission button not found; checking whether consent is already granted.'
  fi
fi
active=false
for ((attempt=0;attempt<8;attempt++)); do
  sleep 1
  dump_ui || continue
  if grep -q 'text="ACTIVE"' "$xml";then active=true;break;fi
done
if [[ "$active" != 'true' ]];then
  echo "FAIL VGuard: Android UI never reported ACTIVE; permission path=$permission." >&2
  python3 - "$xml" <<'PY'
import sys,xml.etree.ElementTree as ET
root=ET.parse(sys.argv[1]).getroot()
values=[x.attrib.get('text','') for x in root.iter('node') if x.attrib.get('text','')]
print('QA visible labels:',repr([s[:110] for s in values if any(q in s.lower() for q in ['vpn','blocking','permission','connect','continue','app','retry','error','allow'])][:20]))
PY
  exit 1
fi
echo "PASS VGuard: actual Android emulator UI reports ACTIVE, permission path=$permission."
probe blocked NO_CONNECTION
probe allowed CONNECTED
echo 'PASS VGuard: selective VPN rule blocks only the selected fictional app.'
# Return to the activity explicitly after the two probe instrumentations.
# Keep its task and VPN running so Stop is the action that restores access.
launch=$(timeout 20 "$adb" shell am start -W -n app.vguard.firewall/.MainActivity)
if ! grep -q '^Status: ok' <<< "$launch"; then
  echo 'FAIL VGuard: unable to return to the firewall activity to stop blocking.' >&2
  exit 1
fi
tap text 'Stop blocking'
stopped=false
for ((attempt=0;attempt<8;attempt++)); do
  if find_xy text 'Start blocking' >/dev/null; then stopped=true; break; fi
  sleep 1
done
if [[ "$stopped" != 'true' ]]; then
  echo 'FAIL VGuard: Android UI never returned to Start blocking after Stop.' >&2
  exit 1
fi
probe blocked CONNECTED
probe allowed CONNECTED
echo 'PASS VGuard: stopping the firewall restores both fictional apps network access.'
echo 'NOTICE VGuard: Android 15 emulator, IPv4 local HTTP only. GrapheneOS, real device, IPv6, DNS, lifecycle and cross-VPN compatibility remain untested.'
