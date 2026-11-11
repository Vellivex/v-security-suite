#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Final finite emulator batch; fictional apps and controlled endpoints only.
VGUARD_CORE_FUNCTIONS_ONLY=true
source "${GITHUB_WORKSPACE:?}/scripts/vguard-core-lifecycle.sh"
unset VGUARD_CORE_FUNCTIONS_ONLY

package_uid() {
  local package="$1" result
  result=$("$adb" shell cmd package list packages -U "$package")
  python3 - "$package" "$result" <<'PY'
import re,sys
matches=re.findall(r'^package:'+re.escape(sys.argv[1])+r' uid:(\d+)\r?$',sys.argv[2],re.M)
assert len(matches)==1, 'Expected exact installed fictional package UID'
print(matches[0])
PY
}

assert_scope_error() {
  local attempt
  for ((attempt=0;attempt<10;attempt++));do
    dump_ui
    if grep -q 'text="ERROR"' "$xml" && grep -q 'shared Android identity' "$xml" && ! grep -q 'text="ACTIVE"' "$xml";then
      echo 'PASS VGuard: incomplete shared Android identity produces an explicit stopped/error state.'
      return 0
    fi
    sleep 1
  done
  echo 'FAIL VGuard: shared Android identity scope change lacked the expected explicit error.' >&2
  return 1
}

start_or_retry() {
  return_to_guard
  if find_xy text 'Retry blocking' >/dev/null;then tap text 'Retry blocking';else tap text 'Start blocking';fi
}

if [[ "${VGUARD_REMAINING_ONLY:-false}" == true ]];then
  # Prior job recorded complete shared-identity/replacement comparisons.
  # This run starts from the ordinary pair's fresh, consented OFF state.
  return_to_guard
  tap nav 'Overview tab'
  tap text 'Start blocking'
  assert_profile_active Normal
else
# Install only the first sibling before activating its rule.
"$adb" install -r "${VGUARD_QA_APK_DIR:?}/VGuard-QA-shared_one.apk" >/dev/null
return_to_guard
tap nav 'Apps tab'
tap text 'Normal'
set_probe_rule blocked false
set_probe_rule allowed false
set_probe_rule shared_one true
tap nav 'Overview tab'
assert_off
probe shared_one CONNECTED tcp
probe allowed CONNECTED tcp
tap text 'Start blocking'
assert_profile_active Normal
if ! probe shared_one NO_CONNECTION tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi

# A late, unselected sibling may inherit the selected UID. Prove actual Android
# assignment before claiming any shared-identity acceptance result.
"$adb" install -r "$VGUARD_QA_APK_DIR/VGuard-QA-shared_two.apk" >/dev/null
one_uid=$(package_uid app.vguard.qa.shared_one)
two_uid=$(package_uid app.vguard.qa.shared_two)
control_uid=$(package_uid app.vguard.qa.allowed)
if [[ "$one_uid" != "$two_uid" || "$one_uid" == "$control_uid" ]];then
  echo "BLOCKED VGuard: shared UID arrangement unavailable (one=$one_uid two=$two_uid control=$control_uid)." >&2
  blockers=$((blockers+1))
  shared_supported=false
else
  shared_supported=true
fi
if [[ "$shared_supported" == true ]];then
echo "PASS VGuard: shared fictional packages have actual Android UID $one_uid; independent control UID is $control_uid."
return_to_guard
if ! assert_scope_error;then failures=$((failures+1));fi
if ! probe shared_one CONNECTED tcp;then failures=$((failures+1));fi
if ! probe shared_two CONNECTED tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi

# Retrying the same partial selection must still refuse, without restricting
# the unselected sibling or independent control.
start_or_retry
if ! assert_scope_error;then failures=$((failures+1));fi
if ! probe shared_one CONNECTED tcp;then failures=$((failures+1));fi
if ! probe shared_two CONNECTED tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi
return_to_guard
set_probe_rule shared_two true
tap nav 'Overview tab'
start_or_retry
assert_profile_active Normal
if ! probe shared_one NO_CONNECTION tcp;then failures=$((failures+1));fi
if ! probe shared_two NO_CONNECTION tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi
return_to_guard
tap text 'Stop blocking'
assert_off
if ! probe shared_one CONNECTED tcp;then failures=$((failures+1));fi
if ! probe shared_two CONNECTED tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi
echo 'CHECK VGuard: late shared sibling, partial selection, complete selection, and Stop comparisons completed.'
fi

# Restore the ordinary independent pair for the remaining lifecycle cases.
return_to_guard
set_probe_rule shared_one false
set_probe_rule shared_two false
set_probe_rule blocked true
tap nav 'Overview tab'
start_or_retry
assert_profile_active Normal
original_uid=$(package_uid app.vguard.qa.blocked)
"$adb" install -r "$VGUARD_QA_APK_DIR/VGuard-QA-blocked.apk" >/dev/null
updated_uid=$(package_uid app.vguard.qa.blocked)
if [[ "$original_uid" != "$updated_uid" ]];then
  echo 'FAIL VGuard: same-signed replacement unexpectedly changed the fictional package UID.' >&2
  failures=$((failures+1))
fi
return_to_guard
assert_profile_active Normal
if ! probe blocked NO_CONNECTION tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi
echo 'CHECK VGuard: selected fictional package same-signed replacement completed.'
fi

# The fresh Journey profile is empty: activating it must stop, and returning
# to the saved Normal selection must require a deliberate new Start.
if [[ "${VGUARD_EXPORT_ONLY:-false}" != true ]];then
return_to_guard
tap nav 'Apps tab'
tap text 'Journey'
tap nav 'Overview tab'
assert_off
if ! probe blocked CONNECTED tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi
return_to_guard
tap nav 'Apps tab'
tap text 'Normal'
tap nav 'Overview tab'
assert_off
tap text 'Start blocking'
assert_profile_active Normal
if ! probe blocked NO_CONNECTION tcp;then failures=$((failures+1));fi
if ! probe allowed CONNECTED tcp;then failures=$((failures+1));fi
echo 'CHECK VGuard: empty-profile switch stops; returning to saved rules requires explicit Start.'
fi

source "${GITHUB_WORKSPACE:?}/scripts/vguard-activity-flow.sh"
VGUARD_PROBE_READY_MS=5000
if ! vguard_activity_flow;then
  failures=$((failures+1))
  echo 'FAIL VGuard: native Activity/export flow incomplete; preserving failure and continuing independent system recovery.' >&2
  qa_ui_diagnostics
  return_to_guard
fi
unset VGUARD_PROBE_READY_MS
if [[ "${VGUARD_EXPORT_ONLY:-false}" == true ]];then return 0;fi
source "${GITHUB_WORKSPACE:?}/scripts/vguard-system-recovery.sh"
if ! vguard_system_recovery;then
  failures=$((failures+1))
  echo 'FAIL VGuard: native system recovery flow incomplete.' >&2
  qa_ui_diagnostics
fi
