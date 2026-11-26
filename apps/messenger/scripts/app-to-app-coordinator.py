#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Private loopback coordination for two installed, unmodified Android apps.

This service is not a Matrix client. It supplies synthetic mailbox codes, compares
UI-read SAS digests, and controls two independently interruptible network proxies.
Only an allowlisted summary is written to the evidence directory. OTPs, public
contact IDs, SAS values/digests, HTTP headers and Matrix traffic are never logged.
"""

from __future__ import annotations

import argparse
import hmac
import http.client
import json
from pathlib import Path
import re
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener


NAME = re.compile(r"[a-z0-9-]{1,80}\Z")
MAX_BODY = 8 * 1024 * 1024


class State:
    def __init__(self, key: str, mailbox_key: str, mailbox_port: int, report: Path):
        self.key = key
        self.mailbox_key = mailbox_key
        self.mailbox_port = mailbox_port
        self.report = report
        self.lock = threading.RLock()
        self.barriers: dict[str, set[str]] = {}
        self.values: dict[tuple[str, str], str] = {}
        self.sas: dict[str, dict[str, dict]] = {}
        self.mail_before: dict[str, set[str]] = {}
        self.codes: dict[str, str] = {}
        self.online = {"A": True, "B": True}
        self.blocked = {"A": 0, "B": 0}
        self.encrypted_send_successes = {"A": 0, "B": 0}
        self.plaintext_send_attempts = {"A": 0, "B": 0}
        self.network_transitions: list[dict] = []
        self.checkpoints: list[dict] = []
        self.completed: dict[str, list[str]] = {"A": [], "B": []}
        self.failed: list[dict] = []
        self.started = time.monotonic()
        self.opener = build_opener(ProxyHandler({}))
        self.save()

    def summary(self) -> dict:
        with self.lock:
            return {
                "schema": 1,
                "scope": "two separately installed Android apps; synthetic loopback service; installer recorded in apk-identity.json",
                "participants": ["A", "B"],
                "completed_phases": self.completed.copy(),
                "checkpoints": list(self.checkpoints),
                "sas_comparisons": {
                    name: {"participants": sorted(values), "matched": self.sas_match(values)}
                    for name, values in self.sas.items()
                },
                "network_transitions": list(self.network_transitions),
                "blocked_matrix_requests": self.blocked.copy(),
                "encrypted_send_successes": self.encrypted_send_successes.copy(),
                "plaintext_send_attempts": self.plaintext_send_attempts.copy(),
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

    def mailbox(self, path: str) -> dict:
        request = Request(f"http://127.0.0.1:{self.mailbox_port}{path}", headers={
            "Authorization": "Bearer " + self.mailbox_key,
            "Accept": "application/json",
        })
        with self.opener.open(request, timeout=5) as response:
            return json.load(response)

    def challenge_ids(self) -> set[str]:
        result = self.mailbox("/")["challenge_ids"]
        if not isinstance(result, list) or not all(isinstance(item, str) for item in result):
            raise ValueError("invalid mailbox response")
        return set(result)


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
                    if not isinstance(value, str) or not re.fullmatch(r"@[A-Za-z0-9_.=+/\-]+:vellivex-dev\.local", value):
                        raise ValueError("unexpected synthetic contact")
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
                if path == "mail/begin" and post:
                    if role in state.mail_before:
                        raise ValueError("only one real code request per fresh participant")
                    state.mail_before[role] = state.challenge_ids()
                    return {"ok": True}
                if path == "mail/code" and not post:
                    if role in state.codes:
                        return {"ready": True, "code": state.codes[role]}
                    if role not in state.mail_before:
                        raise ValueError("mailbox request not begun")
                    added = state.challenge_ids() - state.mail_before[role]
                    if not added:
                        return {"ready": False}
                    if len(added) != 1:
                        raise ValueError("ambiguous synthetic email delivery")
                    record = state.mailbox("/" + quote(next(iter(added)), safe=""))
                    code = record.get("code")
                    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{8}", code):
                        raise ValueError("invalid synthetic code")
                    state.codes[role] = code
                    return {"ready": True, "code": code}
                if path == "network" and post:
                    online = body.get("online")
                    if not isinstance(online, bool):
                        raise ValueError("invalid network state")
                    state.online[role] = online
                    state.network_transitions.append({"role": role, "online": online})
                    state.save()
                    return {"online": online}
                if path == "network" and not post:
                    return {"online": state.online[role], "blocked": state.blocked[role]}
                if path == "checkpoint" and post:
                    checkpoint, phase = body.get("name"), body.get("phase")
                    if not isinstance(checkpoint, str) or not NAME.fullmatch(checkpoint) or phase not in {"fresh", "restart"}:
                        raise ValueError("invalid checkpoint")
                    state.checkpoints.append({"role": role, "phase": phase, "name": checkpoint})
                    state.save()
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


def proxy_handler(state: State, role: str, synapse_port: int):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def unavailable(self) -> None:
            data = b'{"errcode":"M_UNKNOWN","error":"Synthetic device network unavailable"}'
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def blocked(self) -> bool:
            with state.lock:
                if state.online[role]:
                    return False
                state.blocked[role] += 1
                state.save()
                return True

        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def do_PUT(self):
            self.forward()

        def do_DELETE(self):
            self.forward()

        def do_OPTIONS(self):
            self.forward()

        def forward(self) -> None:
            connection = None
            try:
                parsed = urlsplit(self.path)
                if parsed.scheme or parsed.netloc or not parsed.path.startswith(("/_matrix/", "/_synapse/client/vellivex/")):
                    self.send_error(404)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > MAX_BODY:
                    self.send_error(413)
                    return
                payload = self.rfile.read(length) if length else None
                send_path = re.fullmatch(r"/_matrix/client/(?:v3|r0)/rooms/[^/]+/send/([^/]+)/[^/]+", parsed.path)
                event_type = unquote(send_path.group(1)) if self.command == "PUT" and send_path else None
                if event_type == "m.room.message":
                    with state.lock:
                        state.plaintext_send_attempts[role] += 1
                        state.save()
                if self.blocked():
                    self.unavailable()
                    return
                connection = http.client.HTTPConnection("127.0.0.1", synapse_port, timeout=90)
                headers = {name: self.headers[name] for name in ("Authorization", "Content-Type", "Accept", "User-Agent") if name in self.headers}
                connection.request(self.command, self.path, body=payload, headers=headers)
                response = connection.getresponse()
                data = response.read(MAX_BODY + 1)
                if len(data) > MAX_BODY:
                    raise ValueError("oversized synthetic response")
                # A long-poll started before a cut must not carry a new message across the cut.
                if self.blocked():
                    self.unavailable()
                    return
                if event_type == "m.room.encrypted" and 200 <= response.status < 300:
                    with state.lock:
                        state.encrypted_send_successes[role] += 1
                        state.save()
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
                self.close_connection = True
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                try:
                    self.unavailable()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            finally:
                if connection is not None:
                    connection.close()

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--mailbox-key-file", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8030)
    parser.add_argument("--synapse-port", type=int, default=8008)
    parser.add_argument("--mailbox-port", type=int, default=8025)
    parser.add_argument("--proxy-a-port", type=int, default=18081)
    parser.add_argument("--proxy-b-port", type=int, default=18082)
    args = parser.parse_args()
    ports = (args.port, args.synapse_port, args.mailbox_port, args.proxy_a_port, args.proxy_b_port)
    if len(set(ports)) != len(ports) or any(port not in range(1, 65536) for port in ports):
        parser.error("provide five distinct valid loopback ports")
    key = args.key_file.read_text().strip()
    mailbox_key = args.mailbox_key_file.read_text().strip()
    if not key or not mailbox_key:
        parser.error("private coordinator and mailbox keys are required")
    state = State(key, mailbox_key, args.mailbox_port, args.report)
    servers = [
        ThreadingHTTPServer(("127.0.0.1", args.port), coordinator_handler(state)),
        ThreadingHTTPServer(("127.0.0.1", args.proxy_a_port), proxy_handler(state, "A", args.synapse_port)),
        ThreadingHTTPServer(("127.0.0.1", args.proxy_b_port), proxy_handler(state, "B", args.synapse_port)),
    ]
    for server in servers:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    stopped.wait()
    for server in servers:
        server.shutdown()
        server.server_close()
    state.save()


if __name__ == "__main__":
    main()
