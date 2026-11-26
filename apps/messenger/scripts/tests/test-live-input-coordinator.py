#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Behavioral checks of private live-input readiness, expiry and public evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

SOURCE = Path(__file__).resolve().parents[1] / "live-app-to-app-coordinator.py"
SPEC = importlib.util.spec_from_file_location("live_coordinator_under_test", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CoordinatorChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vellivex-live-coordinator-test-")
        self.root = Path(self.temporary.name)
        (self.root / "inbox").mkdir()
        self.descriptor = {"schema": 1, "suite": "vellivex-live-two-app", "repository": "Vellivex/v-security-suite",
                           "run_id": "12345678901", "run_attempt": 1, "head_sha": "a" * 40,
                           "session_id": "b" * 24, "key_id": "c" * 64}
        (self.root / "descriptor.json").write_text(json.dumps(self.descriptor))
        self.state = MODULE.State("d" * 64, self.root, self.root / "summary.json", self.root / "handoff.json")
        self.server = MODULE.ThreadingHTTPServer(("127.0.0.1", 0), MODULE.coordinator_handler(self.state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.opener = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def request(self, role, route, payload=None, key=None):
        request = Request(f"http://127.0.0.1:{self.server.server_port}/v1/{role}/{route}",
                          data=None if payload is None else json.dumps(payload).encode(),
                          headers={"Authorization": "Bearer " + (key if key is not None else "d" * 64),
                                   "Content-Type": "application/json"})
        with self.opener.open(request, timeout=2) as response:
            return json.load(response)

    def input(self, role, purpose, value, *, issued=None, expires=None):
        timestamp = int(time.time())
        data = {"metadata": {"role": role, "purpose": purpose, "issued_at": timestamp if issued is None else issued,
                             "expires_at": timestamp + 300 if expires is None else expires},
                "payload": {purpose: value}}
        filename = self.root / "inbox" / f"{role}-{purpose}.json"
        filename.write_text(json.dumps(data))
        filename.with_suffix(".json.ready").write_text("ready\n")

    def begin(self, role):
        self.input(role, "email", f"disposable-{role.lower()}@example.org")
        self.assertTrue(self.request(role, "mail/config")["ready"])
        self.assertTrue(self.request(role, "mail/begin", {})["ok"])

    def test_private_values_and_stale_phases_cannot_become_reported_sign_in_observations(self):
        for role in ("A", "B"):
            self.request(role, "checkpoint", {"name": "post-login-checking-keys", "phase": "fresh"})
        for name, phase in [("post-login-12345678", "fresh"), ("post-login-arbitrary-error", "fresh"),
                            ("post-login-checking-keys", "restart")]:
            with self.assertRaises(HTTPError):
                self.request("A", "checkpoint", {"name": name, "phase": phase})
        report = (self.root / "summary.json").read_text()
        self.assertNotIn("12345678", report)
        self.assertNotIn("arbitrary-error", report)
        checkpoints = json.loads(report)["checkpoints"]
        self.assertEqual([item["name"] for item in checkpoints], ["post-login-checking-keys"] * 2)

    def test_wrong_coordinator_key_is_rejected(self):
        with self.assertRaises(HTTPError) as error:
            self.request("A", "mail/config", key="incorrect")
        self.assertEqual(error.exception.code, 401)

    def test_email_input_waits_for_ready_marker_and_rejects_duplicate_inbox(self):
        self.assertFalse(self.request("A", "mail/config")["ready"])
        self.begin("A")
        self.input("B", "email", "disposable-a@example.org")
        with self.assertRaises(HTTPError):
            self.request("B", "mail/config")

    def test_code_must_follow_actual_app_request(self):
        self.begin("A")
        self.input("A", "code", "84620017", issued=int(time.time()) - 10)
        with self.assertRaises(HTTPError):
            self.request("A", "mail/code")

    def test_expiry_is_checked_before_first_delivery_and_cached_retrieval(self):
        self.begin("A")
        self.input("A", "code", "84620017", expires=int(time.time()) - 1)
        with self.assertRaises(HTTPError):
            self.request("A", "mail/code")
        self.input("A", "code", "84620017")
        self.assertEqual(self.request("A", "mail/code")["code"], "84620017")
        self.state.code_expiry["A"] = time.time() - 1
        with self.assertRaises(HTTPError):
            self.request("A", "mail/code")

    def test_handoff_requires_both_real_code_screen_checkpoints_and_contains_no_private_values(self):
        for role in ("A", "B"):
            self.begin(role)
        self.request("A", "checkpoint", {"name": "code-screen-shown", "phase": "fresh"})
        self.assertFalse((self.root / "handoff.json").exists())
        self.request("B", "checkpoint", {"name": "code-screen-shown", "phase": "fresh"})
        handoff = json.loads((self.root / "handoff.json").read_text())
        for key, value in self.descriptor.items():
            self.assertEqual(handoff[key], value)
        self.assertEqual(handoff["code_screens_ready"], ["A", "B"])
        self.assertFalse(handoff["private_values_included"])
        self.assertLessEqual(handoff["conservative_code_deadline"], int(time.time()) + 600)
        for filename in ("summary.json", "handoff.json"):
            content = (self.root / filename).read_text()
            for private in ("disposable-a@example.org", "disposable-b@example.org", "84620017", "d" * 64):
                self.assertNotIn(private, content)


if __name__ == "__main__":
    unittest.main()
