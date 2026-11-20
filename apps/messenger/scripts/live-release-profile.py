#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Validate reviewed public installers before live inputs or devices are used."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

SIGNER = "3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2"
ORIGIN = "https://messenger.vellivex.com"
APPLICATION = "com.vellivex.messenger.alpha"
PROFILES = {
    "alpha06-test": "arm64-alpha06-acceptance.json",
    "alpha07-release": "arm64-alpha07-live-acceptance.json",
    "alpha08-release": "arm64-alpha08-live-acceptance.json",
}
ALPHA06_URL = "https://github.com/Vellivex/v-security-suite/releases/download/messenger-v0.1.0-alpha06/Vellivex-Messenger-0.1.0-alpha06-arm64.apk"
ALPHA06_HASH = "13f22deb969792f6b73a8c945ef16f682520a46ea78a93b8ddf14c470fc3dc9b"
ALPHA08_URL = "https://www.vellivex.com/downloads/Vellivex-Messenger-0.1.0-alpha08-arm64.apk"
ALPHA08_SOURCE = "6e29154ce8f67da8828abb198cd4e74f00951730"
RELEASE_FIELDS = {
    "schema_version", "profile", "app_url", "app_sha256", "app_bytes", "signer_sha256",
    "application_id", "version_code", "version_name", "debuggable", "production_origin",
    "production_origin_verified_app_sha256", "build_source_commit",
}


def validate_manifest(profile: str, manifest: dict) -> dict:
    """No network, input relay or device action is permitted before this succeeds."""
    if profile not in PROFILES or not isinstance(manifest, dict):
        raise ValueError("Unsupported live release profile.")
    if profile == "alpha06-test":
        expected = {
            "app_url": ALPHA06_URL, "app_sha256": ALPHA06_HASH,
            "instrumentation_url": ALPHA06_URL.replace("-arm64.apk", "-synthetic-tests.apk"),
            "instrumentation_sha256": "1468244f442ee1a55af492b406c03bb5ac7fc07d5a7fd672a36230a57094113e",
            "signer_sha256": SIGNER,
        }
        if manifest != expected:
            raise ValueError("The historical Alpha06 profile must retain its exact original inputs.")
        return dict(manifest)

    if set(manifest) != RELEASE_FIELDS or any(value is None for value in manifest.values()):
        raise ValueError("Live release acceptance requires complete reviewed installer and production-origin metadata.")
    version = 7 if profile == "alpha07-release" else 8
    expected = (1, profile, APPLICATION, version, f"0.1.0-alpha0{version}", False, ORIGIN, SIGNER)
    actual = tuple(manifest[key] for key in (
        "schema_version", "profile", "application_id", "version_code", "version_name",
        "debuggable", "production_origin", "signer_sha256",
    ))
    if (actual != expected or type(manifest["debuggable"]) is not bool or
            any(type(manifest[key]) is not int for key in ("schema_version", "version_code", "app_bytes")) or
            manifest["app_bytes"] <= 0):
        raise ValueError("Metadata does not describe the selected fixed normal-release profile.")
    digest = manifest["app_sha256"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("A reviewed exact installer SHA-256 is required.")
    if manifest["production_origin_verified_app_sha256"] != digest:
        raise ValueError("Production-origin verification must be bound to the exact installer.")
    url_value = manifest["app_url"]
    if not isinstance(url_value, str):
        raise ValueError("A reviewed public HTTPS download URL is required.")
    url = urlsplit(url_value)
    if (url.scheme != "https" or not url.hostname or not url.path or url.username is not None or
            url.password is not None or url.query or url.fragment or any(c.isspace() for c in url_value)):
        raise ValueError("The installer URL must be stable public HTTPS without credentials.")
    if profile == "alpha07-release":
        if (manifest["build_source_commit"], digest, manifest["app_bytes"]) != (
            "f3003647565f318da435c5ebdc40b7f55fbef676",
            "4f3ca6d6fd857b690b3c4e78f35e104620966c3d31774a47df2248914820a9e5", 57525706,
        ):
            raise ValueError("The Alpha07 profile must retain its reviewed original installer.")
    elif (manifest["build_source_commit"] != ALPHA08_SOURCE or url_value != ALPHA08_URL):
        raise ValueError("Alpha08 requires its reviewed build source and exact public download route.")
    return dict(manifest)


def load_manifest(profile: str) -> dict:
    if profile not in PROFILES:
        raise ValueError("Unsupported live release profile.")
    path = Path(__file__).resolve().parents[1] / "android" / PROFILES[profile]
    return validate_manifest(profile, json.loads(path.read_text(encoding="utf-8")))


def verify_installer(profile: str, manifest: dict, installer: Path) -> dict:
    manifest = validate_manifest(profile, manifest)
    with installer.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    size = installer.stat().st_size
    if digest != manifest["app_sha256"] or (profile != "alpha06-test" and size != manifest["app_bytes"]):
        raise ValueError("Downloaded bytes do not match the exact reviewed installer.")
    report = {
        "app_sha256": digest, "app_bytes": size,
        "expected_signer_sha256": manifest["signer_sha256"], "release_url": manifest["app_url"],
    }
    if profile != "alpha06-test":
        report.update({
            "profile": profile, "version_code": manifest["version_code"],
            "version_name": manifest["version_name"], "production_origin": manifest["production_origin"],
            "production_origin_verified_app_sha256": manifest["production_origin_verified_app_sha256"],
            "production_origin_build_attestation_checked": True,
            "build_source_commit": manifest["build_source_commit"],
        })
    return report


def download_installer(profile: str, destination: Path) -> dict:
    manifest = load_manifest(profile)
    if destination.exists():
        raise ValueError("Use a fresh installer destination; do not overwrite retained bytes.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "180",
        "--proto", "=https", "--proto-redir", "=https", manifest["app_url"], "--output", str(destination),
    ], check=True)
    return verify_installer(profile, manifest, destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("download", "verify"))
    parser.add_argument("profile", choices=tuple(PROFILES))
    parser.add_argument("installer", type=Path)
    parser.add_argument("--signer-output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        report = (download_installer(args.profile, args.installer) if args.action == "download" else
                  verify_installer(args.profile, load_manifest(args.profile), args.installer))
        if args.signer_output:
            args.signer_output.write_text(report["expected_signer_sha256"], encoding="ascii")
            args.signer_output.chmod(0o600)
        if args.report:
            args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # Public artifact metadata only; no mailbox, code or session input is read here.
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
