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
