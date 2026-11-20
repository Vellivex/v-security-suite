#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Reject ambiguous package evidence and non-owned update targets before ADB."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "live-preserved-session-update.py"
SPEC = importlib.util.spec_from_file_location("live_preserved_update_under_test", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PreservedUpdateChecks(unittest.TestCase):
    def test_original_install_identity_is_exact_and_requires_arm64_version(self):
        report = "  userId=10123\n  primaryCpuAbi=arm64-v8a\n  versionCode=7 minSdk=26\n  firstInstallTime=2026-11-20 12:00:00\n"
        self.assertEqual(MODULE.package_identity(report, 7), ("10123", "2026-11-20 12:00:00"))
        for changed in (
            report.replace("versionCode=7", "versionCode=8"),
            report.replace("arm64-v8a", "x86_64"),
            report.replace("  userId=10123\n", ""),
            report + "  userId=10234\n",
            report + "  firstInstallTime=2026-11-20 12:01:00\n",
        ):
            with self.subTest(report=changed), self.assertRaises(ValueError):
                MODULE.package_identity(changed, 7)

    def test_non_runner_invocation_never_reaches_adb(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(MODULE.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                MODULE.update_owned_installation("adb", "emulator-5554", Path("app.apk"), Path("before"), Path("summary"), Path("out"))
            run.assert_not_called()

    def test_wrong_device_or_unowned_paths_never_reach_adb(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            environment = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "Vellivex/v-security-suite",
                           "RUNNER_TEMP": str(root), "MESSENGER_LIVE_SCENARIO": "upgrade-alpha07"}
            for serial, installer, baseline in (
                ("physical-phone", root / "messenger-live-inputs/app.apk", root / "messenger-live-private/before"),
                ("emulator-5556", root / "messenger-live-inputs/app.apk", root / "messenger-live-private/before"),
                ("emulator-5554", root / "another.apk", root / "messenger-live-private/before"),
                ("emulator-5554", root / "messenger-live-inputs/app.apk", root / "outside/before"),
            ):
                with self.subTest(serial=serial, installer=installer, baseline=baseline), patch.dict(os.environ, environment, clear=True), patch.object(MODULE.subprocess, "run") as run:
                    with self.assertRaises(ValueError):
                        MODULE.update_owned_installation("adb", serial, installer, baseline, root / "summary", root / "out")
                    run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
