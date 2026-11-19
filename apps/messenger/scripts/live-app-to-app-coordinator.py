#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Private loopback coordination for two installed, unmodified Android apps.

This service is not a Matrix client. It supplies privately delivered real email
codes and compares UI-read SAS digests. The app connects directly to production HTTPS.
Only an allowlisted summary is written to the evidence directory. OTPs, public
contact IDs, SAS values/digests, HTTP headers and Matrix traffic are never logged.
"""

from __future__ import annotations

import argparse
import hmac
import json
from pathlib import Path
import re
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


NAME = re.compile(r"[a-z0-9-]{1,80}\Z")
MAX_BODY = 8 * 1024 * 1024


class State:
    def __init__(self, key: str, private_directory: Path, report: Path, handoff: Path):
        self.key = key
        self.private_directory = private_directory
        self.report = report
        self.handoff = handoff
        self.lock = threading.RLock()
        self.barriers: dict[str, set[str]] = {}
        self.values: dict[tuple[str, str], str] = {}
        self.sas: dict[str, dict[str, dict]] = {}
        self.mail_before: dict[str, float] = {}
        self.emails: dict[str, str] = {}
        self.codes: dict[str, str] = {}
        self.code_expiry: dict[str, float] = {}
        self.checkpoints: list[dict] = []
        self.completed: dict[str, list[str]] = {"A": [], "B": []}
        self.failed: list[dict] = []
        self.started = time.monotonic()
        self.save()

    def summary(self) -> dict:
        with self.lock:
            return {
                "schema": 1,
                "scope": "two separately installed released apps; direct production HTTPS and received email codes",
                "production_origin": "https://messenger.vellivex.com",
                "traffic_interception": False,
                "synthetic_mailbox": False,
                "email_requests_started": {role: role in self.mail_before for role in ("A", "B")},
                "received_codes_supplied": {role: role in self.codes for role in ("A", "B")},
                "disposable_sessions_signed_out": {
                    role: any(item["role"] == role and item["name"] == "disposable-live-session-signed-out"
                              for item in self.checkpoints) for role in ("A", "B")},
                "participants": ["A", "B"],
                "completed_phases": self.completed.copy(),
                "checkpoints": list(self.checkpoints),
                "sas_comparisons": {
                    name: {"participants": sorted(values), "matched": self.sas_match(values)}
                    for name, values in self.sas.items()
                },
                "failures": list(self.failed),
            }

    @staticmethod
    def sas_match(values: dict) -> bool | None:
        if set(values) != {"A", "B"}:
            return None
        return values["A"] == values["B"]

    def save(self) -> None:
        with self.lock:
            self.report.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.report.with_suffix(".pending")
            temporary.write_text(json.dumps(self.summary(), indent=2) + "\n", encoding="utf-8")
            temporary.chmod(0o600)
            temporary.replace(self.report)

    def input(self, role: str, purpose: str) -> dict | None:
        if (self.private_directory / "relay-failed").exists():
            raise ValueError("input relay failed")
        filename = self.private_directory / "inbox" / f"{role}-{purpose}.json"
        if not filename.with_suffix(filename.suffix + ".ready").exists():
            return None
        value = json.loads(filename.read_text())
        metadata = value.get("metadata", {})
        if (metadata.get("role") != role or metadata.get("purpose") != purpose or
                not isinstance(metadata.get("expires_at"), int) or metadata["expires_at"] <= time.time()):
            raise ValueError("input is stale or assigned to another participant")
        return value


def coordinator_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.dispatch(False)

        def do_POST(self):
            self.dispatch(True)

        def dispatch(self, post: bool) -> None:
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                       ("Bearer " + state.key).encode()):
                self.reply(401, {"error": "unauthorised"})
                return
            if self.path == "/status" and not post:
                self.reply(200, state.summary())
                return
            match = re.fullmatch(r"/v1/([AB])/([a-z0-9/-]{1,160})", self.path)
            if not match:
                self.reply(404, {"error": "unknown route"})
                return
            role, path = match.groups()
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 8192:
                    raise ValueError("invalid request size")
                body = json.loads(self.rfile.read(length) or b"{}") if post else {}
                if not isinstance(body, dict):
                    raise ValueError("invalid request")
                result = self.handle_action(role, path, post, body)
                with state.lock:
                    result["peer_failed"] = any(item["role"] != role for item in state.failed)
                self.reply(200, result)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                # Even malformed requests cannot cause an OTP or UI value to reach an error log.
                self.reply(500, {"error": "coordinator action failed"})

        def handle_action(self, role: str, path: str, post: bool, body: dict) -> dict:
            name = path.split("/", 1)[1] if "/" in path else None
            if name is not None and not NAME.fullmatch(name):
                raise ValueError("invalid name")
            with state.lock:
                if path.startswith("barrier/"):
                    arrivals = state.barriers.setdefault(name, set())
                    if post:
                        arrivals.add(role)
                    return {"ready": bool(arrivals), "count": len(arrivals)}
                if path == "value/public-id" and post:
                    value = body.get("value")
                    if not isinstance(value, str) or not re.fullmatch(r"@[A-Za-z0-9_.=+/\-]+:messenger\.vellivex\.com", value):
                        raise ValueError("unexpected production contact")
                    state.values[(role, "public-id")] = value
                    return {"ok": True}
                if path == "peer/public-id" and not post:
                    value = state.values.get(("B" if role == "A" else "A", "public-id"))
                    return {"ready": value is not None, **({"value": value} if value is not None else {})}
                if path.startswith("sas/"):
                    values = state.sas.setdefault(name, {})
                    if post:
                        kind, count, digest = body.get("kind"), body.get("count"), body.get("sha256")
                        if (kind, count) not in {( "emoji", 7), ("numbers", 3)} or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                            raise ValueError("invalid SAS representation")
                        values[role] = {"kind": kind, "count": count, "sha256": digest}
                        state.save()
                    result = state.sas_match(values)
                    return {"ready": result is not None, "match": result}
                if path == "mail/config" and not post:
                    if role not in state.emails:
                        value = state.input(role, "email")
                        if value is None:
                            return {"ready": False}
                        email = value.get("payload", {}).get("email")
                        if not isinstance(email, str) or not 3 <= len(email) <= 254 or "@" not in email:
                            raise ValueError("invalid email input")
                        if any(existing.lower() == email.lower() for existing in state.emails.values()):
                            raise ValueError("fresh participants must have different email addresses")
                        state.emails[role] = email
                    return {"ready": True, "email": state.emails[role]}
                if path == "mail/begin" and post:
                    if role in state.mail_before or role not in state.emails:
                        raise ValueError("only one request per configured fresh participant")
                    state.mail_before[role] = time.time()
                    state.save()
                    return {"ok": True}
                if path == "mail/code" and not post:
                    if role in state.codes:
                        if time.time() >= state.code_expiry[role]:
                            raise ValueError("received code expired")
                        return {"ready": True, "code": state.codes[role]}
                    if role not in state.mail_before:
                        raise ValueError("email request not begun")
                    value = state.input(role, "code")
                    if value is None:
                        return {"ready": False}
                    if value["metadata"]["issued_at"] < state.mail_before[role] - 5:
                        raise ValueError("code predates this app request")
                    code = value.get("payload", {}).get("code")
                    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{8}", code):
                        raise ValueError("invalid received code")
                    state.codes[role] = code
                    state.code_expiry[role] = min(value["metadata"]["expires_at"], state.mail_before[role] + 600)
                    if time.time() >= state.code_expiry[role]:
                        raise ValueError("received code expired")
                    state.save()
                    return {"ready": True, "code": code}
                if path == "checkpoint" and post:
                    checkpoint, phase = body.get("name"), body.get("phase")
                    if not isinstance(checkpoint, str) or not NAME.fullmatch(checkpoint) or phase not in {"fresh", "restart"}:
                        raise ValueError("invalid checkpoint")
                    state.checkpoints.append({"role": role, "phase": phase, "name": checkpoint})
                    state.save()
                    ready = {item["role"] for item in state.checkpoints
                             if item["phase"] == "fresh" and item["name"] == "code-screen-shown"}
                    if ready == {"A", "B"} and not state.handoff.exists():
                        descriptor = json.loads((state.private_directory / "descriptor.json").read_text())
                        handoff = {key: descriptor[key] for key in
                                   ("schema", "suite", "repository", "run_id", "run_attempt", "head_sha", "session_id", "key_id")}
                        handoff.update({"code_screens_ready": ["A", "B"],
                                        "request_started_at": {r: int(state.mail_before[r]) for r in ("A", "B")},
                                        "conservative_code_deadline": int(min(state.mail_before.values())) + 600,
                                        "private_values_included": False})
                        temporary = state.handoff.with_suffix(".pending")
                        temporary.write_text(json.dumps(handoff, indent=2) + "\n")
                        temporary.chmod(0o600)
                        temporary.replace(state.handoff)
                    return {"ok": True}
                if path in {"finish", "failure"} and post:
                    phase = body.get("phase")
                    if phase not in {"fresh", "restart"}:
                        raise ValueError("invalid phase")
                    if path == "finish":
                        if phase not in state.completed[role]:
                            state.completed[role].append(phase)
                    else:
                        state.failed.append({"role": role, "phase": phase})
                    state.save()
                    return {"ok": True}
            raise ValueError("unknown action")

    return Handler



def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--private-directory", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--handoff", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8030)
    args = parser.parse_args()
    if args.port not in range(1, 65536):
        parser.error("provide a valid loopback port")
    key = args.key_file.read_text().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", key):
        parser.error("a private coordinator key is required")
    state = State(key, args.private_directory.resolve(strict=True), args.report, args.handoff)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), coordinator_handler(state))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    stopped.wait()
    server.shutdown()
    server.server_close()
    state.save()


if __name__ == "__main__":
    main()
