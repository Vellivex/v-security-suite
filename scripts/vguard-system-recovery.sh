#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Isolated Android 15 emulator QA only. Source this file, then call
# vguard_system_recovery. Requires the existing adb/xml/dump_ui/tap/probe/
# return_to_guard/assert_active/assert_off helpers and global failures counter.
# Entry and successful exit: Normal ACTIVE, only regular Blocked selected,
# regular Allowed unselected. Production APK and app data stay intact. The
# disposable emulator's VPN authorization changes through real Settings/consent UI.

vguard_recovery_ui() {
  local mode="$1"
  shift
  dump_ui || return 2
  python3 - "$xml" "$mode" "$@" <<'PY'
import re,sys,xml.etree.ElementTree as ET
try:
    root=ET.parse(sys.argv[1]).getroot()
except (OSError,ET.ParseError) as error:
    print('FAIL recovery: invalid current UI hierarchy: '+str(error),file=sys.stderr)
    raise SystemExit(2)
mode=sys.argv[2];args=sys.argv[3:]
nodes=list(root.iter('node'));parent={c:p for p in root.iter() for c in p}
def need(condition,message):
    if not condition:
        print('FAIL recovery UI: '+message,file=sys.stderr)
        raise SystemExit(1)
def package(name):return [n for n in nodes if n.attrib.get('package')==name]
def point(node):
    need(node.attrib.get('enabled')=='true','target is disabled')
    match=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.attrib.get('bounds',''))
    need(match is not None,'target has no usable bounds')
    left,top,right,bottom=map(int,match.groups())
    need(right>left and bottom>top,'target has empty bounds')
    print((left+right)//2,(top+bottom)//2)
def unique(items,message):
    need(len(items)==1,message)
    return items[0]
def text_node(items,text):
    return [n for n in items if n.attrib.get('text','').casefold()==text.casefold()]
guard=package('app.vguard.firewall')
texts=[n.attrib.get('text','') for n in guard]
if mode=='text':
    items=[n for n in text_node(package(args[0]),args[1]) if n.attrib.get('enabled')=='true']
    point(unique(items,'expected one enabled '+args[0]+' control '+repr(args[1])))
elif mode=='approve':
    items=[n for n in package('com.android.vpndialogs')
           if n.attrib.get('text','').casefold() in ('ok','allow','connect')
           and n.attrib.get('enabled')=='true']
    point(unique(items,'real Android VPN approval button not found uniquely'))
elif mode=='gear':
    settings=package('com.android.settings')
    labels=[n for n in settings if n.attrib.get('text') in
            ('VGuard','VGuard · selected app firewall','app.vguard.firewall')]
    label=unique(labels,'expected one VGuard VPN row in system Settings')
    row=label
    candidates=[]
    while row in parent:
        row=parent[row]
        candidates=[n for n in row.iter('node')
                    if n.attrib.get('package')=='com.android.settings'
                    and n.attrib.get('resource-id','').endswith('/settings_button')
                    and n.attrib.get('enabled')=='true']
        if candidates:break
    point(unique(candidates,'VGuard row has no unique system Settings gear'))
elif mode=='policies':
    settings=package('com.android.settings')
    for title in ('Always-on VPN','Block connections without VPN'):
        label=unique(text_node(settings,title),'missing system policy title '+title)
        row=label;switches=[]
        while row in parent:
            row=parent[row]
            switches=[n for n in row.iter('node') if n.attrib.get('package')=='com.android.settings'
                      and ('Switch' in n.attrib.get('class','') or
                           n.attrib.get('resource-id','').endswith('/switch_widget'))]
            if switches:break
        switch=unique(switches,'missing unique system policy switch '+title)
        need(switch.attrib.get('enabled')=='false' and switch.attrib.get('checked')=='false',
             title+' must be disabled and unchecked for this APK')
    print('PASS VGuard: system Settings exposes always-on and lockdown as disabled and unchecked.')
elif mode in ('normal_active','normal_off','inactive'):
    phase=sorted(set(t for t in texts if t in ('OFF','ERROR','STARTING','ACTIVE')))
    need(len(phase)==1,'missing or ambiguous VGuard phase')
    if mode=='normal_active':
        need(phase==['ACTIVE'] and any('Normal rules are active.' in t for t in texts),
             'Normal profile is not ACTIVE')
    elif mode=='normal_off':
        need(phase==['OFF'],'rebooted UI must explicitly show OFF')
        need(any('1 app selected.' in t for t in texts),'saved one-app selection missing')
        need(any(n.attrib.get('enabled')=='true' for n in text_node(guard,'Start blocking')),
             'explicit Start is not available')
    else:
        need(phase[0] in ('OFF','ERROR'),'system revocation left VGuard ACTIVE/STARTING')
        need(any(n.attrib.get('enabled')=='true' for n in guard
                 if n.attrib.get('text') in ('Start blocking','Retry blocking')),
             'revoked UI does not offer explicit Start/Retry')
    print('PASS VGuard: recovery UI state '+mode+' confirmed.')
elif mode=='history_nonempty':
    need('DROPPED' in texts and any(re.fullmatch(r'LATEST [1-9][0-9]* OF [1-9][0-9]* SESSION ENTRIES',t) for t in texts),
         'pre-reboot discarded packet history is not observable')
    print('PASS VGuard: discarded packet history exists before reboot.')
elif mode=='history_empty':
    need('NO ENTRIES THIS APP SESSION' in texts and 'DROPPED' not in texts,
         'rebooted process retained packet history')
    for label in ('Export CSV','Clear activity'):
        node=unique(text_node(guard,label),'missing empty-history action '+label)
        need(node.attrib.get('enabled')=='false','empty-history action must be disabled: '+label)
    print('PASS VGuard: rebooted process has empty history and disabled history actions.')
elif mode=='rule':
    label,expected=args
    # The Overview profile selector may be below the viewport. Assert the saved
    # profile here on Apps, where its selector is visible above the search field.
    need(any(n.attrib.get('content-desc')=='Normal profile, selected' for n in guard),
         'saved Normal profile was not retained on the Apps tab')
    switch=unique([n for n in guard if n.attrib.get('content-desc')=='Block internet for '+label],
                  'saved probe switch missing: '+label)
    need(switch.attrib.get('checked')==expected,'saved rule changed: '+label)
    print('PASS VGuard: reboot retained '+label+' rule='+expected+'.')
else:
    raise SystemExit('Unknown recovery selector')
PY
}

vguard_recovery_tap() {
  local mode="$1" point rc attempt x y
  shift
  for ((attempt=0;attempt<6;attempt++)); do
    rc=0
    point=$(vguard_recovery_ui "$mode" "$@") || rc=$?
    if [[ "$rc" == 0 ]]; then
      read -r x y <<< "$point"
      "$adb" shell input tap "$x" "$y" >/dev/null || return 1
      return 0
    fi
    [[ "$rc" == 2 ]] && return 2
    sleep 1
  done
  echo "FAIL VGuard: recovery target not found ($mode)." >&2
  return 1
}

vguard_recovery_pair() {
  local expected="$1" role result
  for role in blocked allowed; do
    result=CONNECTED
    [[ "$role" == blocked ]] && result="$expected"
    if ! probe "$role" "$result" tcp; then failures=$((failures+1));fi
  done
}

vguard_recovery_saved_rule() {
  local role="$1" expected="$2" label query attempt
  case "$role" in
    blocked) label='VGuard QA Blocked';query='VGuard%sQA%sBlocked' ;;
    allowed) label='VGuard QA Allowed';query='VGuard%sQA%sAllowed' ;;
    *) return 1 ;;
  esac
  tap contains 'Apps tab' || return 1
  tap desc 'Search apps or package names' || return 1
  "$adb" shell input keyevent 123 >/dev/null || return 1
  "$adb" shell input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 >/dev/null || return 1
  "$adb" shell input text "$query" >/dev/null || return 1
  "$adb" shell input keyevent 4 >/dev/null || return 1
  for ((attempt=0;attempt<6;attempt++));do
    if vguard_recovery_ui rule "$label" "$expected";then return 0;fi
    sleep 1
  done
  return 1
}

vguard_recovery_explicit_start() {
  local require_consent="$1" point
  point=$(find_xy text 'Retry blocking') || point=''
  if [[ -n "$point" ]]; then
    tap text 'Retry blocking' || return 1
  else
    tap text 'Start blocking' || return 1
  fi
  if [[ "$require_consent" == true ]]; then
    vguard_recovery_tap text app.vguard.firewall Continue || return 1
    vguard_recovery_tap approve || return 1
    echo 'PASS VGuard: Settings Forget required fresh real Android VPN consent.'
  else
    # Reboot normally retains consent. If this Android image asks again, the
    # same explicit user action must approve its real system dialog.
    point=$(find_xy text Continue) || point=''
    if [[ -n "$point" ]]; then
      vguard_recovery_tap text app.vguard.firewall Continue || return 1
      vguard_recovery_tap approve || return 1
    fi
  fi
  assert_active || return 1
  vguard_recovery_ui normal_active
}

vguard_system_recovery() {
  local launch attempt inactive=false boot_before boot_after booted deadline route ready=false emulator
  emulator=$(timeout 8 "$adb" shell getprop ro.kernel.qemu | tr -d '\r') || return 1
  if [[ "$emulator" != 1 ]];then
    echo 'FAIL VGuard: system recovery/reboot test is restricted to the disposable emulator.' >&2
    return 1
  fi
  # Caller must select Normal with only the ordinary Blocked probe before this
  # batch. Never silently repair the entry state and conceal an earlier failure.
  return_to_guard || return 1
  tap contains 'Overview tab' || return 1
  vguard_recovery_ui normal_active || return 1
  vguard_recovery_pair NO_CONNECTION

  launch=$(timeout 20 "$adb" shell am start -W -a android.settings.VPN_SETTINGS) || return 1
  if ! grep -q '^Status: ok' <<< "$launch";then
    echo 'FAIL VGuard: system VPN Settings failed to open.' >&2
    return 1
  fi
  vguard_recovery_tap gear || return 1
  # These switches are inspection-only; never force unsupported lockdown on.
  if ! vguard_recovery_ui policies;then failures=$((failures+1));fi
  vguard_recovery_tap text com.android.settings 'Forget VPN' || return 1
  vguard_recovery_tap text com.android.settings Forget || return 1
  return_to_guard || return 1
  tap contains 'Overview tab' || return 1
  for ((attempt=0;attempt<8;attempt++));do
    if vguard_recovery_ui inactive;then inactive=true;break;fi
    sleep 1
  done
  if [[ "$inactive" != true ]];then
    echo 'FAIL VGuard: actual system revocation did not produce an inactive UI.' >&2
    return 1
  fi
  vguard_recovery_pair CONNECTED
  return_to_guard || return 1
  vguard_recovery_explicit_start true || return 1
  vguard_recovery_pair NO_CONNECTION
  echo 'CHECK VGuard: system Forget/revoke and explicit re-consent comparisons completed.'

  return_to_guard || return 1
  tap contains 'Activity tab' || return 1
  vguard_recovery_ui history_nonempty || return 1
  boot_before=$(timeout 8 "$adb" shell cat /proc/sys/kernel/random/boot_id | tr -d '\r') || return 1
  if [[ ! "$boot_before" =~ ^[0-9a-f-]{36}$ ]];then
    echo 'FAIL VGuard: cannot identify emulator boot before reboot.' >&2
    return 1
  fi
  timeout 15 "$adb" reboot || return 1
  deadline=$((SECONDS+180))
  while ((SECONDS<deadline));do
    boot_after=$(timeout 4 "$adb" shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r') || boot_after=''
    booted=$(timeout 4 "$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') || booted=''
    if [[ "$boot_after" =~ ^[0-9a-f-]{36}$ && "$boot_after" != "$boot_before" && "$booted" == 1 ]];then
      ready=true;break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]];then
    echo 'FAIL VGuard: new emulator boot did not complete within the bounded wait.' >&2
    return 1
  fi
  echo 'PASS VGuard: Android reboot completed with a different kernel boot ID.'
  "$adb" shell input keyevent 224 >/dev/null || return 1
  "$adb" shell input keyevent 82 >/dev/null || return 1
  "$adb" shell input keyevent 3 >/dev/null || return 1
  ready=false
  for ((attempt=0;attempt<20;attempt++));do
    route=$(timeout 4 "$adb" shell ip -4 route get 10.0.2.2 2>/dev/null) || route=''
    if [[ "$route" == *' dev '* && "$route" != *unreachable* ]];then ready=true;break;fi
    sleep 1
  done
  if [[ "$ready" != true ]];then
    echo 'FAIL VGuard: rebooted guest has no controlled-host route; cannot assert restored networking.' >&2
    return 1
  fi
  # No VGuard launch, force-stop, data reset or settings change precedes these
  # independent probes. They test actual reboot/no-autostart behavior.
  vguard_recovery_pair CONNECTED
  return_to_guard || return 1
  tap contains 'Overview tab' || return 1
  assert_off || return 1
  vguard_recovery_ui normal_off || return 1
  vguard_recovery_saved_rule blocked true || return 1
  vguard_recovery_saved_rule allowed false || return 1
  tap contains 'Activity tab' || return 1
  vguard_recovery_ui history_empty || return 1
  tap contains 'Overview tab' || return 1
  vguard_recovery_explicit_start false || return 1
  vguard_recovery_pair NO_CONNECTION
  return_to_guard || return 1
  tap contains 'Overview tab' || return 1
  vguard_recovery_ui normal_active || return 1
  echo 'CHECK VGuard: reboot restored connectivity, retained rules, cleared process history and required explicit restart; individual results above.'
}
