#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# VGuard emulator network baseline using two independently signed synthetic QA probes.
# Does NOT enable the Android VPN or claim filtering results.
set -euo pipefail
sdk="${1:?SDK root required}"
adb="$sdk/platform-tools/adb"
root=$(mktemp -d)
server_pid=''
protocol_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$protocol_pid" ]]; then kill "$protocol_pid" 2>/dev/null || true; fi
  rm -rf "$root"
}
trap cleanup EXIT

source_url='https://www.vellivex.com/downloads/VGuard-Source-GPL.zip'
expected_sha='abf4b7aec5b8848418a8abbb5b67ebbc6fceb009a5ff9e1c7146d528ee23bcfe'
curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
  --connect-timeout 15 --max-time 90 --retry 2 \
  --output "$root/source.zip" "$source_url"
actual=$(sha256sum "$root/source.zip" | cut -d' ' -f1)
if [[ "$actual" != "$expected_sha" ]]; then echo 'FAIL VGuard: QA probe source ZIP hash mismatch.' >&2; exit 1; fi
unzip -tqq "$root/source.zip" >/dev/null
unzip -q "$root/source.zip" -d "$root"
echo 'PASS VGuard: independent QA probe source matches published ZIP hash.'

if [[ ! -x "$sdk/build-tools/36.0.0/apksigner" ||
      ! -f "$sdk/platforms/android-36/android.jar" ]]; then
  sdkmanager=$(find "$sdk/cmdline-tools" -maxdepth 4 -type f -name sdkmanager -perm /111 | sort -V | tail -1)
  if [[ -z "$sdkmanager" ]]; then echo 'FAIL VGuard: official Android SDK manager unavailable.' >&2; exit 1; fi
  echo 'Installing official free platform and build tools for QA probes with previously accepted licences.'
  timeout 150 "$sdkmanager" --sdk_root="$sdk" --install 'build-tools;36.0.0' 'platforms;android-36' < /dev/null >/dev/null
fi

password=$(openssl rand -hex 16)
password_file="$root/probe-pass.txt"
printf '%s' "$password" > "$password_file"
chmod 0600 "$password_file"
keytool -genkeypair -noprompt -alias vguard -keyalg RSA -keysize 2048 \
  -validity 2 -storetype PKCS12 -keystore "$root/qa-probe-only.p12" \
  -storepass "$password" -keypass "$password" \
  -dname 'CN=VGuard Fictional QA, OU=Test, O=Ephemeral, C=GB' >/dev/null 2>&1
unset password

cd "$root/VGuard"
if [[ "${VGUARD_PROBE_ENFORCEMENT:-false}" == 'true' ]]; then
  cp "${GITHUB_WORKSPACE:?}/apps/vguard/device-qa/Probe.java" device-qa/Probe.java
  cp "${GITHUB_WORKSPACE:?}/apps/vguard/device-qa/protocol-server.py" device-qa/protocol-server.py
  echo 'NOTICE VGuard: using reviewed branch probes/endpoints with bounded diagnostics and arrival receipts; production APK is unchanged.'
fi
probe_build_options=()
if [[ "${VGUARD_FINAL_ONLY:-false}" == true ]];then probe_build_options+=(--shared-uid);fi
python3 device-qa/build-probes.py --sdk "$sdk" "${probe_build_options[@]}" \
  --keystore "$root/qa-probe-only.p12" \
  --password-file "$password_file" > "$root/probes-build.log"
test -f build/qa-probes/VGuard-QA-blocked.apk
test -f build/qa-probes/VGuard-QA-allowed.apk
echo 'PASS VGuard: two independently packaged probe APKs built using temporary QA-only signing key.'

for role in blocked allowed; do
  "$adb" install -r "build/qa-probes/VGuard-QA-$role.apk" >/dev/null
done
echo 'PASS VGuard: fictional Blocked and Allowed QA probes installed with separate Android packages.'

python3 device-qa/http-server.py > "$root/http-server.log" 2>&1 &
server_pid=$!
server_ready=false
for ((i=0;i<20;i++)); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:18789/check >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  sleep .3
done
if [[ "$server_ready" != 'true' ]]; then
  echo 'FAIL VGuard: controlled local HTTP test server not reachable on host.' >&2
  tail -n 8 "$root/http-server.log" >&2
  exit 1
fi
echo 'PASS VGuard: host-side controlled HTTP test server is reachable.'

for role in blocked allowed; do
  echo "Probing fictional app role: $role, with VGuard firewall OFF."
  output=$(timeout 25 "$adb" shell am instrument -w \
    -e mode http -e url http://10.0.2.2:18789/check \
    "app.vguard.qa.$role/app.vguard.qa.Probe" 2>&1) || {
       echo "FAIL VGuard: $role instrument could not start." >&2
       printf '%s\n' "$output" | grep -E 'INSTRUMENTATION_RESULT: (outcome|failure)|Error|Exception|INSTRUMENTATION_CODE' | head -n 12 >&2 || true
       exit 1
    }
  outcome=$(printf '%s\n' "$output" | sed -nE 's/^INSTRUMENTATION_RESULT: outcome=([A-Z_]+)\r?$/\1/p' | tail -1)
  if [[ "$outcome" != 'CONNECTED' ]]; then
    echo "FAIL VGuard: $role baseline outcome was ${outcome:-missing}; connection blocking is NOT proven." >&2
    printf '%s\n' "$output" | grep -E 'INSTRUMENTATION_RESULT: (outcome|failure|mode)|INSTRUMENTATION_CODE' | head -n 12 >&2 || true
    exit 1
  fi
  echo "PASS VGuard: $role independent Android app connected to controlled host while firewall OFF."
done

echo 'PASS VGuard: both independent Android probe applications have proven off-state HTTP baselines.'
echo 'NOTICE VGuard: selective VPN blocking, VPN consent, stop/restart and GrapheneOS remain UNTESTED by these baselines.'
if [[ "${VGUARD_PROBE_ENFORCEMENT:-false}" == 'true' ]]; then
  python3 device-qa/protocol-server.py > "$root/protocol-server.log" 2>&1 &
  protocol_pid=$!
  python3 - <<'CHECK_PROTOCOL_SERVER'
import socket,time
for attempt in range(30):
    try:
        with socket.create_connection(('127.0.0.1',18790),timeout=1) as connection:
            connection.sendall(b'host-readiness\n')
            assert connection.makefile('rb').readline(100) == b'VGUARD_QA_OK host-readiness\n'
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as connection:
            connection.settimeout(1)
            connection.sendto(b'host-readiness',('127.0.0.1',18791))
            assert connection.recv(100) == b'VGUARD_QA_OK host-readiness'
        print('PASS VGuard: controlled host TCP and UDP endpoints respond correctly.')
        break
    except (OSError,AssertionError):
        if attempt==29: raise
        time.sleep(.2)
CHECK_PROTOCOL_SERVER
  export VGUARD_PROTOCOL_LOG="$root/protocol-server.log"
  export VGUARD_BLOCKED_APK="$root/VGuard/build/qa-probes/VGuard-QA-blocked.apk"
  export VGUARD_QA_APK_DIR="$root/VGuard/build/qa-probes"
  echo 'Running one-off selective VPN protocol/lifecycle test before removing fictional probes and local servers.'
  outcome=0
  bash "${GITHUB_WORKSPACE:?}/scripts/vguard-selective-emulator-smoke.sh" "$sdk" || outcome=$?
  echo 'Controlled protocol server receipts (last 20 entries, fictional test tokens only):'
  tail -n 20 "$root/protocol-server.log"
  exit "$outcome"
fi
