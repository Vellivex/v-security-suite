"""Two physical stock Android phones using only the exact signed installer and reviewed UI."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from pathlib import Path

from device import DeviceError
from flow import STAGES, run_pair
from handoff import PrivateHandoff
from provider import APK_SHA, MODELS, Provider

ROLES = ("A", "B")
ROOT = Path(__file__).resolve().parent
INPUT_REPO = "https://github.com/Vellivex/v-security-suite.git"
INPUT_REF = "refs/heads/test/messenger-live-inputs"


def write_public(path, value):
    temp = path.with_suffix(".new")
    temp.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def source_digest():
    digest = hashlib.sha256()
    for name in ("run.py", "device.py", "provider.py", "flow.py", "handoff.py"):
        digest.update(name.encode() + b"\0" + (ROOT / name).read_bytes() + b"\0")
    return digest.hexdigest()


class MailInput:
    """Accept only same-commit role pairs on the existing encrypted input branch."""
    def __init__(self, sealed, descriptor, root):
        self.sealed, self.descriptor = sealed, descriptor
        self.git = root / "sealed-input.git"
        self.lock = threading.RLock()
        self.received = {}
        self.requested = {}
        self.screens = set()
        self.ready_report = None
        subprocess.run(["git", "init", "--bare", "-q", self.git], check=True, capture_output=True)

    def _git(self, *args):
        env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "TMPDIR", "LANG"}}
        env["GIT_TERMINAL_PROMPT"] = "0"
        return subprocess.run(["git", "--git-dir", self.git, *args], capture_output=True, timeout=18, env=env)

    def _pair(self, purpose, deadline):
        root = f"live-input/{self.descriptor['run_id']}/{self.descriptor['session_id']}"
        while time.time() < deadline:
            try:
                fetch = self._git("fetch", "--no-tags", "--depth=1", INPUT_REPO, INPUT_REF)
                if fetch.returncode == 0:
                    pair = {}
                    for role in ROLES:
                        path = f"FETCH_HEAD:{root}/{role}-{purpose}.json"
                        size = self._git("cat-file", "-s", path)
                        if size.returncode:
                            break
                        if not size.stdout.strip().isdigit() or not 0 < int(size.stdout) <= 16_384:
                            raise DeviceError("invalid sealed input size")
                        payload = self._git("cat-file", "blob", path)
                        if payload.returncode:
                            raise DeviceError("invalid sealed input record")
                        pair[role] = json.loads(payload.stdout)
                    if len(pair) == 2:
                        return self.sealed.read_emails(pair) if purpose == "email" else self.sealed.read_pair(pair)
            except subprocess.TimeoutExpired:
                pass
            time.sleep(3)
        raise DeviceError("private input timed out")

    def email(self, role):
        with self.lock:
            if "email" not in self.received:
                self.received["email"] = self._pair("email", time.time() + 480)
            return self.received["email"][role]

    def begin(self, role):
        with self.lock:
            if role not in ROLES or "email" not in self.received or role in self.requested:
                raise DeviceError("duplicate role request")
            self.requested[role] = int(time.time())

    def ready(self, role):
        with self.lock:
            if role not in self.requested or role in self.screens:
                raise DeviceError("unexpected code screen")
            self.screens.add(role)
            if self.screens == set(ROLES):
                self.ready_report = self.sealed.publish_ready(self.requested)

    def code(self, role):
        with self.lock:
            if self.screens != set(ROLES) or role not in ROLES:
                raise DeviceError("both real code screens are required")
            if "code" not in self.received:
                self.received["code"] = self._pair("code", min(time.time() + 210, self.ready_report["conservative_code_deadline"]))
            return self.received["code"].pop(role)


def open_pair(provider, stack, app, build):
    # Distinct real models rule out a single device/session being counted twice.
    devices = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(provider.start, role, app, build): role for role in ROLES}
        errors = []
        for future in concurrent.futures.as_completed(futures):
            try:
                dev = future.result()
                devices[futures[future]] = dev
                stack.callback(dev.close)
            except Exception:
                errors.append(True)
        if errors:
            raise DeviceError("could not open both devices")
    stop = threading.Event()
    keepers = [threading.Thread(target=dev.keep_alive, args=(stop,), daemon=True) for dev in devices.values()]
    for keeper in keepers:
        keeper.start()
    stack.callback(stop.set)
    for role in ROLES:
        until = time.monotonic() + 30
        while True:
            try:
                provider.describe(devices[role], role, app, build)
                if devices[role].command("GET", "appium/device/current_package") != "com.vellivex.messenger.alpha":
                    raise DeviceError("foreground app identity unverified")
                break
            except DeviceError:
                if time.monotonic() >= until:
                    raise
                time.sleep(2)
    return devices


def exercise_canaries(provider, devices):
    fake = {role: "privacy-" + secrets.token_hex(22) for role in ROLES}
    for role, dev in devices.items():
        provider.effective_privacy(dev)
        dev.find_text("Continue with email")
        fields = dev.find_all("android.widget.EditText")
        if len(fields) != 1:
            raise DeviceError("canary field unavailable")
        fields[0].send(fake[role])
        if fields[0].text() != fake[role]:
            raise DeviceError("canary readback failed")
        fields[0].clear()
        # Do not submit: no mail or production sign-in occurs during the privacy audit.
    return fake


def audit(provider, app, build, devices, fake, live):
    checks = [provider.audit_canary(devices[r], r, app, build, fake[r], live=live) for r in ROLES]
    return {"schema": 1, "apk_sha256": APK_SHA, "driver_sha256": source_digest(), "devices": checks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["canary", "acceptance"])
    parser.add_argument("apk", type=Path)
    parser.add_argument("artifacts", type=Path)
    args = parser.parse_args()
    run, attempt, sha = (os.environ.get(k, "") for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"))
    expected = "refs/heads/test/messenger-physical-" + args.mode
    if (os.environ.get("GITHUB_REPOSITORY") != "Vellivex/v-security-suite" or
        os.environ.get("GITHUB_REF") != expected or not re.fullmatch(r"[1-9][0-9]{0,19}", run) or
        not re.fullmatch(r"[1-9][0-9]{0,5}", attempt) or not re.fullmatch(r"[a-f0-9]{40}", sha)):
        raise DeviceError("approved run identity missing")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    args.artifacts.mkdir(mode=0o700, exist_ok=False)
    provider = Provider()
    provider.capacity()
    app = provider.upload(args.apk)
    build = f"Messenger-{run}-{attempt}"
    privacy_path = args.artifacts / "privacy-preflight.json"
    with ExitStack() as stack:
        canary_devices = open_pair(provider, stack, app, build + "-privacy")
        canaries = exercise_canaries(provider, canary_devices)
    completed = audit(provider, app, build + "-privacy", canary_devices, canaries, live=False)
    write_public(privacy_path, completed)
    if args.mode == "canary":
        return
    provider.capacity()
    with tempfile.TemporaryDirectory(prefix="messenger-physical-private-") as private, ExitStack() as stack:
        devices = open_pair(provider, stack, app, build)
        actual_canaries = exercise_canaries(provider, devices)
        in_session = audit(provider, app, build, devices, actual_canaries, live=True)
        write_public(privacy_path, {"finished_pair": completed, "actual_live_pair": in_session})
        sealed = PrivateHandoff(private, args.artifacts, run, int(attempt), sha)
        descriptor = sealed.prepare()
        sealed.bind_physical(source_digest(), hashlib.sha256(privacy_path.read_bytes()).hexdigest(),
                             {r: devices[r].session for r in ROLES})
        inputs = MailInput(sealed, descriptor, Path(private))
        events = {r: [] for r in ROLES}

        def checkpoint(role, stage):
            if role not in ROLES or stage not in STAGES:
                raise DeviceError("unexpected checkpoint")
            events[role].append(stage)
            write_public(args.artifacts / "checkpoints.json", events)

        run_pair(devices, inputs, checkpoint)
        if not all("signed-out" in events[r] for r in ROLES):
            raise DeviceError("both signed-out completions required")
        write_public(args.artifacts / "result.json", {"fresh_two_stock_phones": "passed", "roles": list(ROLES),
                     "apk_sha256": APK_SHA, "driver_sha256": source_digest(), "grapheneos_tested": False})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print remote details, request or response values, tracebacks or locals.
        sys.exit("Physical test stopped. Review the fixed checkpoints and provider privacy preflight.")
