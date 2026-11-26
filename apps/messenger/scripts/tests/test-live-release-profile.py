#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Installer preflight must fail before requesting private live input."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from contextlib import ExitStack
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "live-release-profile.py"
SPEC = importlib.util.spec_from_file_location("live_release_profile_under_test", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseProfileChecks(unittest.TestCase):
    def candidate(self):
        path = SOURCE.parents[1] / "android" / "arm64-alpha08-live-acceptance.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_alpha08_rejects_matching_replacement_digests(self):
        manifest = self.candidate()
        self.assertEqual(MODULE.validate_manifest("alpha08-release", manifest), manifest)
        manifest["app_sha256"] = manifest["production_origin_verified_app_sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            MODULE.validate_manifest("alpha08-release", manifest)

    def test_alpha08_rejects_changed_byte_count(self):
        manifest = self.candidate()
        manifest["app_bytes"] += 1
        with self.assertRaises(ValueError):
            MODULE.validate_manifest("alpha08-release", manifest)

    def test_pending_alpha08_manifest_fails_before_any_download(self):
        pending = self.candidate()
        for field in ("app_url", "app_sha256", "app_bytes", "production_origin_verified_app_sha256"):
            pending[field] = None
        with tempfile.TemporaryDirectory() as root, patch.object(MODULE, "load_manifest", side_effect=lambda profile: MODULE.validate_manifest(profile, pending)), patch.object(MODULE.subprocess, "run") as run:
            destination = Path(root) / "not-created" / "app.apk"
            with self.assertRaises(ValueError):
                MODULE.download_installer("alpha08-release", destination)
            run.assert_not_called()
            self.assertFalse(destination.parent.exists())

    def test_wrong_profile_identity_endpoint_or_unbound_origin_is_rejected(self):
        changes = {
            "profile": "alpha07-release", "version_code": 7, "version_name": "0.1.0-alpha08-test",
            "debuggable": True, "application_id": "com.vellivex.messenger",
            "signer_sha256": "0" * 64, "build_source_commit": "0" * 40,
            "production_origin": "http://messenger.vellivex.com",
            "production_origin_verified_app_sha256": "0" * 64,
            "app_url": MODULE.ALPHA08_URL + "?source=unreviewed", "app_bytes": True,
        }
        for field, value in changes.items():
            with self.subTest(field=field):
                manifest = self.candidate()
                manifest[field] = value
                with self.assertRaises(ValueError):
                    MODULE.validate_manifest("alpha08-release", manifest)

    def test_each_missing_release_field_is_rejected(self):
        for field in self.candidate():
            with self.subTest(field=field):
                manifest = self.candidate()
                del manifest[field]
                with self.assertRaises(ValueError):
                    MODULE.validate_manifest("alpha08-release", manifest)

    def test_installer_bytes_and_length_are_both_checked(self):
        content = b"fictional installer fixture"
        digest = hashlib.sha256(content).hexdigest()
        manifest = dict(self.candidate(), app_sha256=digest, app_bytes=len(content),
                        production_origin_verified_app_sha256=digest)
        with tempfile.TemporaryDirectory() as root, patch.object(MODULE, "ALPHA08_INSTALLER", (digest, len(content))):
            installer = Path(root) / "fixture.apk"
            installer.write_bytes(content)
            report = MODULE.verify_installer("alpha08-release", manifest, installer)
            self.assertEqual(report["app_sha256"], digest)
            self.assertEqual(report["build_source_commit"], MODULE.ALPHA08_SOURCE)
            wrong_length = dict(manifest, app_bytes=len(content) + 1)
            with patch.object(MODULE, "ALPHA08_INSTALLER", (digest, len(content) + 1)), self.assertRaisesRegex(ValueError, "Downloaded bytes"):
                MODULE.verify_installer("alpha08-release", wrong_length, installer)
            installer.write_bytes(content[:-1] + b"!")
            with self.assertRaisesRegex(ValueError, "Downloaded bytes"):
                MODULE.verify_installer("alpha08-release", manifest, installer)

    def test_unapproved_universal_cannot_download(self):
        manifest = dict(self.candidate(), profile="alpha09-release", version_code=9,
                        version_name="0.1.0-alpha09", app_url=MODULE.ALPHA09_URL)
        with patch.object(MODULE, "ALPHA09_INSTALLER", None), \
                patch.object(MODULE, "load_manifest", side_effect=lambda _: MODULE.validate_manifest("alpha09-release", manifest)), \
                patch.object(MODULE.subprocess, "run") as commands, tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "missing" / "app.apk"
            with self.assertRaises(ValueError):
                MODULE.download_installer("alpha09-release", dest)
            commands.assert_not_called()
            self.assertFalse(dest.parent.exists())

    def test_universal_uses_exact_normal_release_and_both_native_payloads(self):
        # Fixture source and native bytes are isolated from every real release pin.
        source = "a" * 40
        payloads = {name: name.encode() for name in MODULE.ALPHA09_NATIVE}
        native = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
        broken = dict(payloads)
        broken["lib/x86_64/libmatrix_sdk_ffi.so"] = b"bad-native"
        absent = {k: v for k, v in payloads.items() if "x86_64" not in k}
        extra = dict(payloads, **{"lib/x86/test.so": b"unexpected ABI"})
        for content, valid in [(payloads, True), (broken, False), (absent, False), (extra, False)]:
            with self.subTest(valid=valid), ExitStack() as ctx:
                apk = Path(ctx.enter_context(tempfile.TemporaryDirectory())) / "fixture.apk"
                with zipfile.ZipFile(apk, "w") as archive:
                    for name, data in content.items():
                        archive.writestr(name, data)
                blob = apk.read_bytes()
                digest = hashlib.sha256(blob).hexdigest()
                manifest = dict(self.candidate(), profile="alpha09-release", version_code=9,
                    version_name="0.1.0-alpha09", app_url=MODULE.ALPHA09_URL, build_source_commit=source,
                    app_sha256=digest, app_bytes=len(blob), production_origin_verified_app_sha256=digest)
                ctx.enter_context(patch.object(MODULE, "ALPHA09_SOURCE", source))
                ctx.enter_context(patch.object(MODULE, "ALPHA09_INSTALLER", (digest, len(blob))))
                ctx.enter_context(patch.object(MODULE, "ALPHA09_NATIVE", native))
                if valid:
                    report = MODULE.verify_installer("alpha09-release", manifest, apk)
                    self.assertEqual(report["verified_native_abis"], ["arm64-v8a", "x86_64"])
                    for key, value in (("version_code", 8), ("debuggable", True), ("signer_sha256", "0" * 64),
                                       ("app_url", MODULE.ALPHA08_URL), ("build_source_commit", "b" * 40)):
                        with self.assertRaises(ValueError):
                            MODULE.validate_manifest("alpha09-release", dict(manifest, **{key: value}))
                else:
                    with self.assertRaises(ValueError):
                        MODULE.verify_installer("alpha09-release", manifest, apk)

    def test_historical_alpha06_original_manifest_stays_accepted(self):
        manifest = MODULE.load_manifest("alpha06-test")
        self.assertEqual(manifest["app_sha256"], MODULE.ALPHA06_HASH)
        altered = dict(manifest, app_sha256="0" * 64)
        with self.assertRaises(ValueError):
            MODULE.validate_manifest("alpha06-test", altered)

    def test_historical_alpha07_identity_stays_fixed(self):
        path = SOURCE.parents[1] / "android" / "arm64-alpha07-live-acceptance.json"
        manifest = json.loads(path.read_text())
        # The retained draft's URL is deliberately still null. Supply a fixture
        # public URL only in memory to exercise its unchanged original byte pins.
        manifest["app_url"] = "https://www.vellivex.com/downloads/Vellivex-Messenger-0.1.0-alpha07-arm64.apk"
        MODULE.validate_manifest("alpha07-release", manifest)
        for field, value in (("app_bytes", 1), ("app_sha256", "0" * 64), ("build_source_commit", MODULE.ALPHA08_SOURCE)):
            altered = copy.deepcopy(manifest)
            altered[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                MODULE.validate_manifest("alpha07-release", altered)


if __name__ == "__main__":
    unittest.main()
