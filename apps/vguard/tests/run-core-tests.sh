#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo 'Usage: tests/run-core-tests.sh <jdk-bin-directory> <path-to-android.jar>' >&2
  exit 2
fi

vguard_test_root="$(cd "$(dirname "$0")/.." && pwd)"
vguard_test_output="$vguard_test_root/tests/.classes"
vguard_jdk_bin="$1"
vguard_android_jar="$2"
vguard_java="$vguard_jdk_bin/java"
if [ ! -x "$vguard_java" ]; then
  vguard_java="$(command -v java)"
fi
mkdir -p "$vguard_test_output"
vguard_javac=("$vguard_jdk_bin/javac")
if [ ! -x "$vguard_jdk_bin/javac" ]; then
  vguard_javac=("$vguard_java" -m jdk.compiler/com.sun.tools.javac.Main)
fi
"${vguard_javac[@]}" -source 8 -target 8 -Xlint:-options \
  -cp "$vguard_android_jar" -d "$vguard_test_output" \
  "$vguard_test_root/app/src/main/java/app/vguard/firewall/PacketInfo.java" \
  "$vguard_test_root/app/src/main/java/app/vguard/firewall/RuleStore.java" \
  "$vguard_test_root/tests/CoreTests.java"
"$vguard_java" -cp "$vguard_test_output:$vguard_android_jar" \
  app.vguard.firewall.CoreTests
