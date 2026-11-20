#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Update only the disposable live runner's Alpha07 installation, preserving data."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.request import ProxyHandler, Request, build_opener

PACKAGE = "com.vellivex.messenger.alpha"


def package_identity(report: str, expected_version: int) -> tuple[str, str]:
    if not re.search(rf"^\s*versionCode={expected_version}(?:\s|$)", report, re.M):
        raise ValueError("Unexpected installed version at the update boundary.")
    if not re.search(r"^\s*primaryCpuAbi=arm64-v8a\s*$", report, re.M):
        raise ValueError("The update must preserve the ARM64 installation.")
    uid = re.findall(r"^\s*userId=(\d+)\s*$", report, re.M)
    installed = re.findall(r"^\s*firstInstallTime=([^\r\n]+)$", report, re.M)
    if len(uid) != 1 or len(installed) != 1 or not installed[0].strip():
        raise ValueError("The original installation identity was not unambiguously observed.")
    return uid[0], installed[0].strip()


def update_owned_installation(adb: str, serial: str, installer: Path, original_report: Path,
                              summary: Path, output: Path) -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "Vellivex/v-security-suite":
        raise ValueError("This update is restricted to the dedicated hosted live test.")
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    if serial != "emulator-5554" or os.environ.get("MESSENGER_LIVE_SCENARIO") != "upgrade-alpha07":
        raise ValueError("Only participant A in the explicit upgrade scenario may be changed.")
    if installer.resolve() != runner_temp / "messenger-live-inputs/app.apk":
        raise ValueError("Use the runner's verified Alpha08 installer.")
    if not original_report.resolve().is_relative_to(runner_temp / "messenger-live-private"):
        raise ValueError("The baseline must belong to this disposable runner.")
    # Independently recheck exact immutable download bytes before installation.
    profile_source = Path(__file__).with_name("live-release-profile.py")
    spec = importlib.util.spec_from_file_location("live_update_profile", profile_source)
    profiles = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profiles)
    profiles.verify_installer("alpha08-release", profiles.load_manifest("alpha08-release"), installer)
    original = package_identity(original_report.read_text(), 7)
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        if summary.exists():
            state = json.loads(summary.read_text())
            if state.get("failures"):
                raise ValueError("The live UI failed before the preserved-session update.")
            if any(item.get("role") == "A" and item.get("phase") == "fresh" and
                   item.get("name") == "alpha07-saved-session-blocks-new-login" for item in state.get("checkpoints", [])):
                break
        time.sleep(.25)
    else:
        raise ValueError("The original app never proved its saved-session guard.")

    def command(*arguments: str) -> str:
        return subprocess.run([adb, "-s", serial, *arguments], check=True, capture_output=True,
                              text=True, timeout=120).stdout

    before = package_identity(command("shell", "dumpsys", "package", PACKAGE), 7)
    if before != original:
        raise ValueError("The old installation changed before its update.")
    if not command("shell", "pidof", PACKAGE).strip():
        raise ValueError("The original app process was not observed before the update.")
    command("shell", "am", "force-stop", PACKAGE)
    # No uninstall, data-clear, sign-out, repository method or session-store read.
    command("install", "-r", "-t", "--abi", "arm64-v8a", str(installer))
    after = package_identity(command("shell", "dumpsys", "package", PACKAGE), 8)
    if after != original:
        raise ValueError("The updated app did not retain its original installation identity.")
    output.write_text(json.dumps({
        "source_version_code": 7, "target_version_code": 8,
        "application_id_retained": True, "application_uid_retained": True,
        "first_install_time_retained": True, "data_clear_requested": False,
        "uninstall_requested": False, "sign_out_before_update": False,
        "scope": "installation identity retained; actual saved-session restore is separately required through UI",
    }, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adb")
    parser.add_argument("serial")
    parser.add_argument("installer", type=Path)
    parser.add_argument("original_report", type=Path)
    parser.add_argument("coordinator_key", type=Path)
    parser.add_argument("summary", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        update_owned_installation(args.adb, args.serial, args.installer, args.original_report, args.summary, args.output)
        key = args.coordinator_key.read_text().strip()
        if not re.fullmatch(r"[0-9a-f]{64}", key):
            raise ValueError("Invalid private coordinator key.")
        opener = build_opener(ProxyHandler({}))
        request = Request("http://127.0.0.1:8030/v1/A/barrier/alpha08-update-installed", data=b"{}",
                          headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with opener.open(request, timeout=5) as response:
            if response.status != 200:
                raise ValueError("Could not hand the preserved installation back to its UI driver.")
    except (ValueError, OSError, subprocess.SubprocessError):
        # Never print command output, private paths, coordinator input or app text.
        raise SystemExit("The preserved-session update did not complete; no acceptance pass is claimed.") from None


if __name__ == "__main__":
    main()
