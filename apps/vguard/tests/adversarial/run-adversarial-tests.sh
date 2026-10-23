#!/usr/bin/env bash
set -euo pipefail

vguard_adversarial_root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -n "${VGUARD_ADVERSARIAL_CLASSES:-}" ]]; then
  vguard_adversarial_classes="$VGUARD_ADVERSARIAL_CLASSES"
else
  vguard_adversarial_classes="$(mktemp -d)"
  trap 'rm -rf -- "$vguard_adversarial_classes"' EXIT
fi
vguard_adversarial_java="${VGUARD_TEST_JAVA:-java}"
mkdir -p "$vguard_adversarial_classes"
if command -v rg >/dev/null 2>&1; then
  mapfile -t vguard_stub_sources < <(rg --files -g '*.java' "$vguard_adversarial_root/tests/adversarial/stubs" | sort)
else
  mapfile -t vguard_stub_sources < <(find "$vguard_adversarial_root/tests/adversarial/stubs" -name '*.java' -print | sort)
fi
"$vguard_adversarial_java" -m jdk.compiler/com.sun.tools.javac.Main \
  -encoding UTF-8 -source 8 -target 8 -Xlint:-options -d "$vguard_adversarial_classes" \
  "${vguard_stub_sources[@]}" \
  "$vguard_adversarial_root/app/src/main/java/app/vguard/firewall/GuardService.java" \
  "$vguard_adversarial_root/app/src/main/java/app/vguard/firewall/RuleStore.java" \
  "$vguard_adversarial_root/app/src/main/java/app/vguard/firewall/PacketInfo.java" \
  "$vguard_adversarial_root/tests/adversarial/ServiceAdversarialTests.java"
"$vguard_adversarial_java" -cp "$vguard_adversarial_classes" app.vguard.firewall.ServiceAdversarialTests "$@"
