#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Read sealed data from one public input branch; execute no fetched source.

The operator must first authenticate the public key artifact's workflow run and
reviewed source head. The branch contains only authenticated encrypted envelopes.
The private key, decoded inputs and this temporary Git object store are destroyed
by the parent runner. Provider credentials are never used by this process.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import signal
import subprocess
import threading
import time

REPOSITORY = "https://github.com/Vellivex/v-security-suite.git"
BRANCH = "refs/heads/test/messenger-live-inputs"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-directory", type=Path, required=True)
    parser.add_argument("--envelope-script", type=Path, required=True)
    args = parser.parse_args()
    private = args.private_directory.resolve(strict=True)
    descriptor = json.loads((private / "descriptor.json").read_text())
    run_id, session = descriptor.get("run_id"), descriptor.get("session_id")
    if (descriptor.get("repository") != "Vellivex/v-security-suite" or
            descriptor.get("input_branch") != "test/messenger-live-inputs" or
            not isinstance(run_id, str) or not re.fullmatch(r"[0-9]{1,20}", run_id) or
            not isinstance(session, str) or not re.fullmatch(r"[0-9a-f]{24}", session)):
        raise SystemExit("Invalid public run descriptor; relay not started")
    git_dir = private / "input-git"
    git_dir.mkdir(mode=0o700)
    subprocess.run(["git", "init", "--bare", str(git_dir)], check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    subprocess.run(["git", "--git-dir", str(git_dir), "remote", "add", "origin", REPOSITORY],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    prior = ""
    while not stopped.is_set() and time.time() < descriptor["expires_at"]:
        try:
            listed = subprocess.run(["git", "ls-remote", "--exit-code", REPOSITORY, BRANCH],
                                    capture_output=True, timeout=20, check=False)
            match = re.fullmatch(rb"([0-9a-f]{40})\trefs/heads/test/messenger-live-inputs\n", listed.stdout)
            if listed.returncode != 0 or not match:
                stopped.wait(5)
                continue
            head = match.group(1).decode()
            if head == prior:
                stopped.wait(5)
                continue
            fetched = subprocess.run(["git", "--git-dir", str(git_dir), "fetch", "--quiet", "--no-tags",
                                      "--depth=1", "origin", head], capture_output=True, timeout=30)
            if fetched.returncode != 0:
                stopped.wait(5)
                continue
            for role in ("A", "B"):
                for purpose in ("email", "code"):
                    if (private / "inbox" / f"{role}-{purpose}.json.ready").exists():
                        continue
                    ref = f"{head}:live-input/{run_id}/{session}/{role}-{purpose}.json"
                    size = subprocess.run(["git", "--git-dir", str(git_dir), "cat-file", "-s", ref],
                                          capture_output=True, timeout=10)
                    if size.returncode != 0:
                        continue
                    if not size.stdout.strip().isdigit() or not 1 <= int(size.stdout.strip()) <= 16384:
                        raise ValueError("invalid envelope size")
                    content = subprocess.run(["git", "--git-dir", str(git_dir), "show", ref],
                                             capture_output=True, timeout=10, check=True)
                    target = private / f"sealed-{role}-{purpose}.json"
                    target.write_bytes(content.stdout)
                    target.chmod(0o600)
                    decoded = subprocess.run(["node", str(args.envelope_script.resolve()), "open",
                                              str(private), str(target)], capture_output=True, timeout=10)
                    if decoded.returncode != 0:
                        raise ValueError("sealed input rejected")
            prior = head
            if all((private / "inbox" / f"{role}-{purpose}.json.ready").exists()
                   for role in ("A", "B") for purpose in ("email", "code")):
                return
        except (OSError, subprocess.TimeoutExpired):
            stopped.wait(5)
            continue
        except Exception:
            # No exception detail can disclose decoded data or untrusted Git content.
            (private / "relay-failed").write_text("sealed-input-rejected\n")
            raise SystemExit("Live input relay rejected an envelope; private input was not printed")
        stopped.wait(5)
    if not stopped.is_set():
        (private / "relay-failed").write_text("input-session-expired\n")
        raise SystemExit("Live input relay session expired")


if __name__ == "__main__":
    main()
