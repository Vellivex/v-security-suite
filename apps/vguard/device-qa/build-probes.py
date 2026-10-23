#!/usr/bin/env python3
"""Build two isolated network probes for an Android emulator; not part of VGuard."""
from pathlib import Path
import argparse
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--sdk", type=Path, required=True)
parser.add_argument("--keystore", type=Path, required=True)
parser.add_argument("--password-file", type=Path, required=True)
parser.add_argument("--alias", default="vguard")
parser.add_argument("--shared-uid", action="store_true", help="Also build two same-signature shared-UID probes")
args = parser.parse_args()
sdk = args.sdk.resolve()
bt = sdk / "build-tools/36.0.0"
api = sdk / "platforms/android-36/android.jar"
out = root.parent / "build" / "qa-probes"
out.mkdir(parents=True, exist_ok=True)
(out / "classes").mkdir(exist_ok=True)
(out / "dex").mkdir(exist_ok=True)

def run(command):
    subprocess.run([str(value) for value in command], check=True)

run(["java", "-m", "jdk.compiler/com.sun.tools.javac.Main", "-source", "8", "-target", "8",
     "-bootclasspath", api, "-d", out / "classes", root / "Probe.java"])
with zipfile.ZipFile(out / "classes.jar", "w") as archive:
    for path in (out / "classes").rglob("*.class"):
        archive.write(path, path.relative_to(out / "classes").as_posix())
run([bt / "d8", "--min-api", "29", "--lib", api, "--output", out / "dex", out / "classes.jar"])
roles = ("blocked", "allowed", "shared_one", "shared_two") if args.shared_uid else ("blocked", "allowed")
for role in roles:
    package = "app.vguard.qa." + role
    folder = out / role
    folder.mkdir(exist_ok=True)
    manifest = folder / "AndroidManifest.xml"
    shared_attribute = ' android:sharedUserId="app.vguard.qa.shared"' if role.startswith("shared_") else ""
    manifest.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
package="''' + package + '''"''' + shared_attribute + ''' android:versionCode="2" android:versionName="2">
<uses-sdk android:minSdkVersion="29" android:targetSdkVersion="35"/>
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<queries><package android:name="app.vguard.firewall"/></queries>
<application android:label="VGuard QA ''' + role.replace("_", " ").title() + '''" android:usesCleartextTraffic="true"/>
<instrumentation android:name="app.vguard.qa.Probe" android:targetPackage="''' + package + '''"/>
</manifest>''')
    unsigned = folder / "unsigned.apk"
    run([bt / "aapt2", "link", "-I", api, "--manifest", manifest, "-o", unsigned])
    with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_STORED) as archive:
        archive.write(out / "dex/classes.dex", "classes.dex")
    run([bt / "zipalign", "-f", "4", unsigned, folder / "aligned.apk"])
    final = out / ("VGuard-QA-" + role + ".apk")
    run([bt / "apksigner", "sign", "--ks", args.keystore.resolve(), "--ks-key-alias", args.alias,
         "--ks-pass", "file:" + str(args.password_file.resolve()),
         "--v4-signing-enabled", "false", "--out", final, folder / "aligned.apk"])
    print(final)
