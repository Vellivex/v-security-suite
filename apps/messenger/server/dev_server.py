# SPDX-License-Identifier: GPL-3.0-or-later
"""Run an isolated loopback homeserver and optional synthetic test mailbox."""

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time

from vellivex_email_state import CHALLENGE_PATTERN


def private_file(path: Path) -> str:
    if not path.exists():
        with path.open("x", encoding="utf-8") as output:
            output.write(secrets.token_hex(32) + "\n")
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise SystemExit(f"Expected a private local file at {path}")
    return path.read_text(encoding="utf-8").strip()


def configure(state: Path, port: int) -> Path:
    private_file(state / "otp-secret")
    private_file(state / "identity-secret")
    config = {
        "server_name": "vellivex-dev.local",
        "public_baseurl": f"http://127.0.0.1:{port}/",
        "report_stats": False,
        "signing_key_path": str(state / "homeserver.signing.key"),
        "macaroon_secret_key": private_file(state / "synapse-macaroon-secret"),
        "media_store_path": str(state / "media"),
        "max_upload_size": "2M",
        "database": {"name": "sqlite3", "args": {"database": str(state / "homeserver.sqlite")}},
        "listeners": [{
            "port": port,
            "type": "http",
            "tls": False,
            "bind_addresses": ["127.0.0.1"],
            "x_forwarded": False,
            "resources": [{"names": ["client"]}],
        }],
        "enable_registration": False,
        "allow_guest_access": False,
        "password_config": {"enabled": False},
        "trusted_key_servers": [],
        "federation_domain_whitelist": [],
        "modules": [{
            "module": "vellivex_email_auth.EmailCodeModule",
            "config": {
                "mode": "dev",
                "database": str(state / "email.sqlite"),
                "otp_secret_file": str(state / "otp-secret"),
                "identity_secret_file": str(state / "identity-secret"),
                "mailbox": str(state / "mail"),
                "ip_hour_limit": 200,
                "day_limit": 200,
            },
        }],
    }
    path = state / "homeserver.yaml"
    with path.open("w", encoding="utf-8") as output:
        json.dump(config, output, indent=2)
        output.write("\n")
    return path


def mailbox_handler(directory: Path, key: str):
    expected = ("Bearer " + key).encode("ascii")

    class MailboxHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.connection.settimeout(3)
            supplied = self.headers.get("Authorization", "").encode("utf-8")
            if not hmac.compare_digest(supplied, expected):
                self.send_error(403)
                return
            challenge = self.path.removeprefix("/")
            if not CHALLENGE_PATTERN.fullmatch(challenge):
                self.send_error(404)
                return
            try:
                data = (directory / (challenge + ".json")).read_bytes()
                if json.loads(data)["expires_at"] <= time.time():
                    self.send_error(404)
                    return
            except (OSError, ValueError, KeyError):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return MailboxHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--mailbox-port", type=int)
    args = parser.parse_args()
    os.umask(0o077)
    state = args.state_dir.resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state.stat().st_mode & 0o077:
        raise SystemExit("The local state directory must have mode 0700")
    config_path = configure(state, args.port)
    print(f"Vellivex test homeserver: http://127.0.0.1:{args.port}", flush=True)
    server = None
    if args.mailbox_port is not None:
        key = private_file(state / "mailbox-key")
        server = ThreadingHTTPServer(
            ("127.0.0.1", args.mailbox_port), mailbox_handler(state / "mail", key)
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"Synthetic mailbox token stored at {state / 'mailbox-key'}", flush=True)

    command = [sys.executable, "-m", "synapse.app.homeserver", "--config-path", str(config_path)]
    search_path = str(Path(__file__).resolve().parent)
    env = dict(os.environ, PYTHONPATH=search_path)
    process = subprocess.Popen(command, cwd=state, env=env)
    signal.signal(signal.SIGTERM, lambda *_: process.terminate())
    try:
        return process.wait()
    except KeyboardInterrupt:
        process.terminate()
        process.wait(timeout=15)
        return 130
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
