#!/usr/bin/env bash
set -euo pipefail
umask 077
project=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
original=${1:?original alpha08 APK}
sdk=${2:?pinned Matrix AAR}
output=${3:?output QA APK}
bt="${ANDROID_HOME:?}/build-tools/36.0.0"
echo "95661c6ea7f8b5d40e9fd6ba6797a5a2f6b276f681369420b4e55348784579e4  $original" | sha256sum -c -
"$bt/apksigner" verify --print-certs "$original" | grep -F 'Signer #1 certificate SHA-256 digest: 3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2'
gradle=${QA_GRADLE_BIN:-"$project/../android/gradlew"}
"$gradle" --no-daemon --console=plain --max-workers=2 -Dorg.gradle.jvmargs=-Xmx1300m -p "$project" "-PmatrixSdkAar=$sdk" assembleRelease
plain=$(find "$project/build/outputs/apk/release" -name '*unsigned.apk' -print -quit)
test -f "$plain"
python3 - "$original" "$plain" "$work/raw.apk" <<'PY'
import hashlib, sys, zipfile
original, plain, output = sys.argv[1:]
digests = {
    'lib/arm64-v8a/libmatrix_sdk_ffi.so':'ab78268c932792091e8431709b6c21d452ee4579e63a474d77e2e592aad5ca22',
    'lib/arm64-v8a/libjnidispatch.so':'abc26e994517bcaa3309acdb0a27373864086c7569c89d3087b8626fada9ef06',
}
with zipfile.ZipFile(original) as released, zipfile.ZipFile(plain) as qa, zipfile.ZipFile(output, 'w') as out:
    assert {n for n in qa.namelist() if n.startswith('lib/')} == set(digests)
    for entry in qa.infolist():
        payload = released.read(entry.filename) if entry.filename in digests else qa.read(entry)
        if entry.filename in digests:
            assert hashlib.sha256(payload).hexdigest() == digests[entry.filename]
        out.writestr(entry, payload)
PY
"$bt/zipalign" -P 16 -f 4 "$work/raw.apk" "$work/aligned.apk"
keytool -genkeypair -keystore "$work/qa.p12" -storepass fixturekey -keypass fixturekey -alias qa -keyalg RSA -keysize 2048 -validity 3 -dname CN=Vellivex-Native-Integrity-QA
"$bt/apksigner" sign --ks "$work/qa.p12" --ks-pass pass:fixturekey --v4-signing-enabled false --out "$output" "$work/aligned.apk"
"$bt/apksigner" verify --print-certs "$output"
"$bt/zipalign" -c -P 16 4 "$output"
"$bt/aapt" dump badging "$output" | grep -F "package: name='com.vellivex.qa.physical'"
sha256sum "$output"
