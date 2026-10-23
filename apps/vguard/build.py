#!/usr/bin/env python3
"""Build VGuard with official Android SDK tools, JDK 17+, and Python 3.

No Gradle, third-party dependencies, network downloads, or embedded signing key.
Private signing files are created only when no existing key is supplied.
"""

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
VERSION = "0.1.3-candidate"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", default=os.environ.get("VGUARD_ANDROID_SDK")
                        or os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME"))
    parser.add_argument("--build-tools", default="36.0.0")
    parser.add_argument("--api", default="36")
    parser.add_argument("--keystore", type=Path, default=ROOT / ".local-signing" / "vguard.p12")
    parser.add_argument("--password-file", type=Path,
                        default=ROOT / ".local-signing" / "vguard.pass")
    parser.add_argument("--alias", default="vguard")
    parser.add_argument("--require-existing-key", action="store_true",
                        help="Refuse to generate a new update identity for an official candidate")
    parser.add_argument("--expected-cert-sha256", help="Required expected public signing certificate digest")
    args = parser.parse_args()
    os.umask(0o077)
    if args.require_existing_key and (not args.keystore.is_file() or not args.password_file.is_file()):
        parser.error("Official candidates require the existing signing key and password file.")
    if args.expected_cert_sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", args.expected_cert_sha256):
        parser.error("Expected certificate digest must be 64 hexadecimal characters.")
    if not args.sdk:
        parser.error("Set --sdk to your Android SDK directory (build-tools 36.0.0, platform android-36).")
    sdk = Path(args.sdk).expanduser().resolve()
    bt = sdk / "build-tools" / args.build_tools
    android_jar = sdk / "platforms" / ("android-" + args.api) / "android.jar"
    java = shutil.which("java")
    if not java or not android_jar.is_file():
        parser.error("JDK 17+ and the selected Android SDK platform must already be installed.")

    def sdk_tool(name):
        suffix = ".bat" if os.name == "nt" and name in ("d8", "apksigner") else (
            ".exe" if os.name == "nt" else "")
        path = bt / (name + suffix)
        if not path.is_file():
            parser.error("Missing Android SDK tool: " + str(path))
        return str(path)

    aapt2, d8, zipalign, apksigner = [sdk_tool(n) for n in
                                      ("aapt2", "d8", "zipalign", "apksigner")]
    keytool = shutil.which("keytool")
    if not keytool:
        candidate = Path(java).resolve().parent / ("keytool.exe" if os.name == "nt" else "keytool")
        if candidate.is_file():
            keytool = str(candidate)

    # Only this project's generated build directory is cleaned.
    if BUILD.exists():
        shutil.rmtree(BUILD)
    for name in ("gen", "classes", "dex"):
        (BUILD / name).mkdir(parents=True, exist_ok=True)
    log = []

    def run(command, label):
        print(label, flush=True)
        result = subprocess.run([str(item) for item in command], cwd=ROOT,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log.append(label + "\n" + result.stdout)
        (BUILD / "build-log.txt").write_text("\n".join(log), encoding="utf-8")
        if result.returncode:
            print(result.stdout, file=sys.stderr)
            raise SystemExit(result.returncode)
        return result.stdout

    manifest = ROOT / "app" / "src" / "main" / "AndroidManifest.xml"
    res = manifest.parent / "res"
    run([aapt2, "compile", "--dir", res, "-o", BUILD / "resources.zip"], "Compiling resources")
    run([aapt2, "link", "-o", BUILD / "resources.ap_", "-I", android_jar,
         "--manifest", manifest, "--min-sdk-version", "29", "--target-sdk-version", "35",
         "--java", BUILD / "gen", BUILD / "resources.zip"], "Linking Android package")

    sources = sorted((manifest.parent / "java").rglob("*.java")) + sorted((BUILD / "gen").rglob("*.java"))
    if len(sources) < 4:
        parser.error("VGuard source files are incomplete.")
    bootclasspath = str(bt / "core-lambda-stubs.jar") + os.pathsep + str(android_jar)
    run([java, "-m", "jdk.compiler/com.sun.tools.javac.Main", "-encoding", "UTF-8",
         "-source", "8", "-target", "8", "-bootclasspath", bootclasspath,
         "-d", BUILD / "classes", *sources], "Compiling Java")
    with zipfile.ZipFile(BUILD / "classes.jar", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((BUILD / "classes").rglob("*.class")):
            archive.write(path, path.relative_to(BUILD / "classes").as_posix())
    run([d8, "--release", "--min-api", "29", "--lib", android_jar,
         "--output", BUILD / "dex", BUILD / "classes.jar"], "Creating Android bytecode")
    shutil.copyfile(BUILD / "resources.ap_", BUILD / "unsigned.apk")
    with zipfile.ZipFile(BUILD / "unsigned.apk", "a", zipfile.ZIP_STORED) as archive:
        for path in sorted((BUILD / "dex").glob("*.dex")):
            archive.write(path, path.name)
    run([zipalign, "-f", "-p", "4", BUILD / "unsigned.apk", BUILD / "aligned.apk"], "Aligning package")

    keystore = args.keystore.expanduser().resolve()
    password = args.password_file.expanduser().resolve()
    if not keystore.exists():
        if not keytool:
            parser.error("keytool is required to create a signing key.")
        keystore.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        password.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not password.exists():
            # Never print passwords or include them in a subprocess argument.
            descriptor = os.open(str(password), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(secrets.token_urlsafe(48) + "\n")
        run([keytool, "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12",
             "-storepass:file", password, "-keypass:file", password, "-alias", args.alias,
             "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
             "-dname", "CN=VGuard Preview, OU=Personal Android Firewall"], "Creating private app signing key")
        if os.name != "nt":
            keystore.chmod(0o600)
    elif not password.is_file():
        parser.error("The existing signing key needs its original password file.")

    apk = BUILD / ("VGuard-" + VERSION + ".apk")
    run([apksigner, "sign", "--ks", keystore, "--ks-key-alias", args.alias,
         "--ks-pass", "file:" + str(password),
         "--v1-signing-enabled", "false", "--v2-signing-enabled", "true",
         "--v3-signing-enabled", "true", "--v4-signing-enabled", "false",
         "--out", apk, BUILD / "aligned.apk"], "Signing VGuard")
    signature = run([apksigner, "verify", "--verbose", "--print-certs", apk], "Verifying APK signature")
    certificate = re.search(r"certificate SHA-256 digest:\s*([0-9a-fA-F]{64})", signature)
    if args.expected_cert_sha256 and (not certificate or certificate.group(1).lower()!=args.expected_cert_sha256.lower()):
        raise SystemExit("Signing identity mismatch: candidate must not be published.")
    alignment = run([zipalign, "-c", "4", apk], "Verifying alignment")
    manifest_info = run([aapt2, "dump", "badging", apk], "Verifying manifest")
    permissions = run([aapt2, "dump", "permissions", apk], "Verifying permissions")
    sha256 = hashlib.sha256(apk.read_bytes()).hexdigest()
    report = {
        "artifact": apk.name,
        "version": VERSION,
        "package": "app.vguard.firewall",
        "min_sdk": 29,
        "target_sdk": 35,
        "compile_sdk": int(args.api),
        "build_tools": args.build_tools,
        "bytes": apk.stat().st_size,
        "sha256": sha256,
        "signature_verified": True,
        "alignment_verified": True,
        "device_runtime_verified": False,
        "source_fingerprint_sha256": hashlib.sha256(b"".join(
            path.relative_to(ROOT).as_posix().encode("utf-8") + b"\0" + path.read_bytes()
            for path in sorted((ROOT / "app").rglob("*")) if path.is_file())).hexdigest(),
        "signing_certificate_sha256": certificate.group(1).lower() if certificate else None,
        "verification_scope": "Build-time compilation, packaging, manifest, alignment and signature only. Android runtime outcomes are recorded separately.",
    }
    (BUILD / "build-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (BUILD / "verification.txt").write_text(signature + "\n" + alignment + "\n" + manifest_info
                                           + "\n" + permissions + "\nSHA-256: " + sha256 + "\n",
                                           encoding="utf-8")
    print("Built: " + str(apk))
    print("SHA-256: " + sha256)
    print("Native package verified. Device runtime testing is a separate step.")


if __name__ == "__main__":
    main()
