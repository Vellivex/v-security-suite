# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the private deployment on an isolated Docker Compose project."""

from http.client import HTTPConnection
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
sys.path.insert(0, str(DEPLOY))

from manage import Stack, atomic_write

DOMAIN = "messenger.example.invalid"
SMTP_HOST = "smtp.example.invalid"
PORT = 8080
CLIENT_IP = "192.0.2.10"
VERSIONS = "/_matrix/client/versions"
EMAIL_API = "/_synapse/client/vellivex/email/"
UNINVITED = {"email": "uninvited@example.invalid"}


def request(path, *, body=None, client_ip=CLIENT_IP, forwarded_ip=None):
    headers = {"Host": DOMAIN, "Accept": "application/json"}
    if client_ip is not None:
        headers["CF-Connecting-IP"] = client_ip
    if forwarded_ip is not None:
        headers["X-Forwarded-For"] = forwarded_ip
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    connection = HTTPConnection("127.0.0.1", PORT, timeout=5)
    try:
        connection.request("GET" if body is None else "POST", path, payload, headers)
        response = connection.getresponse()
        data = response.read(128 * 1024)
        if response.getheader("Content-Type", "").startswith("application/json"):
            data = json.loads(data)
        return response.status, data, response.getheader("Cache-Control")
    finally:
        connection.close()


def wait_for_proxy():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            status, body, _ = request(VERSIONS)
            if status == 200 and isinstance(body, dict) and body.get("versions"):
                return
        except OSError:
            pass
        time.sleep(0.5)
    raise AssertionError("Tunnel proxy did not serve Synapse versions")


def sql(stack, statements):
    return stack.compose(
        "exec", "-T", "database", "psql", "-X", "-U", "postgres", "-d", "messenger",
        "-qAt", "--set=ON_ERROR_STOP=1", "-c", statements,
        stdout=subprocess.PIPE, text=True,
    ).stdout.strip()


def exercise(stack):
    stack.start()
    wait_for_proxy()
    assert request(VERSIONS, client_ip=None)[0] == 403, "Tunnel proxy accepted a request without the edge address"

    for route in (
        "/_matrix/federation/v1/version",
        "/_matrix/key/v2/server",
        "/_synapse/admin/v1/server_version",
        "/_synapse/client/other",
    ):
        assert request(route)[0] == 404, f"Proxy exposed {route}"

    status, response, _ = request(
        "/_matrix/client/v3/register",
        body={"username": "smoke", "password": "unused-smoke-password"},
    )
    assert status == 403 and response["errcode"] == "M_FORBIDDEN", "Public registration did not fail closed"
    status, response, _ = request("/_matrix/client/v3/login")
    assert status == 200 and "m.login.password" not in {flow["type"] for flow in response["flows"]}, (
        "Password sign-in was enabled"
    )

    for attempt in range(6):
        status, response, cache = request(
            EMAIL_API + "request", body=UNINVITED, forwarded_ip=f"198.51.100.{attempt + 1}",
        )
        assert status == 200 and cache == "no-store", "Unexpected response to an uninvited address"
        assert set(response) == {"challenge_id"} and re.fullmatch(r"[A-Za-z0-9_-]{43}", response["challenge_id"]), (
            "Uninvited response is not an opaque challenge"
        )
    challenge_id = response["challenge_id"]
    assert request(EMAIL_API + "request", body=UNINVITED, forwarded_ip="198.51.100.7")[0] == 429, (
        "A caller-supplied X-Forwarded-For evaded the proxied client limit"
    )
    assert request(EMAIL_API + "request", body=UNINVITED, client_ip="192.0.2.11")[0] == 200, (
        "A second edge address did not have its own client limit"
    )
    assert request(EMAIL_API + "verify", body={"challenge_id": challenge_id, "code": "00000000"})[0] == 403
    challenge_count = stack.compose(
        "exec", "-T", "synapse", "python", "-c",
        "import sqlite3; "
        "db = sqlite3.connect('file:/data/email.sqlite?mode=ro', uri=True); "
        "print(db.execute('SELECT count(*) FROM challenges').fetchone()[0])",
        stdout=subprocess.PIPE, text=True,
    ).stdout.strip()
    assert challenge_count == "0", "Uninvited requests reached the persistent email challenge store"
    assert sql(stack, "SELECT count(*) FROM users") == "0", "Smoke probes created an unexpected user"

    assert sql(stack, "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='messenger'") == "f", (
        "The application database role has administrative privileges"
    )
    sql(stack, "SET ROLE messenger; CREATE TABLE deployment_smoke (marker text NOT NULL); "
               "INSERT INTO deployment_smoke VALUES ('persisted')")
    data = stack.state / "synapse"
    stable_names = ("identity-secret", "macaroon-secret", "synapse-signing.key")
    stable_state = {name: (data / name).read_bytes() for name in stable_names}
    assert all(stable_state.values()), "Deployment did not generate stable identity and signing state"
    stack.stop()
    stack.start()
    wait_for_proxy()
    assert sql(stack, "SET ROLE messenger; SELECT marker FROM deployment_smoke") == "persisted", (
        "Database state disappeared after restart"
    )
    assert all((data / name).read_bytes() == old for name, old in stable_state.items()), (
        "Server identity or signing state was replaced on restart"
    )


def main():
    if os.geteuid() == 0 or shutil.which("docker") is None:
        raise SystemExit("Run this smoke test as a nonroot user with Docker Compose access.")
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", PORT))
    os.umask(0o077)
    with TemporaryDirectory(prefix="vellivex-deploy-smoke-") as directory:
        temporary = Path(directory)
        state = temporary / "state"
        credentials = temporary / "unused-smtp-password"
        atomic_write(credentials, "unused-smoke-credential\n")
        subprocess.run(
            [sys.executable, str(DEPLOY / "manage.py"), "--state-dir", str(state), "init",
             "--domain", DOMAIN, "--mode", "tunnel", "--smtp-host", SMTP_HOST,
             "--smtp-username", "smoke", "--smtp-password-file", str(credentials)],
            check=True, timeout=20,
        )
        stack = Stack(state)
        network_override = temporary / "smtp-loopback.yaml"
        # Keep accidental SMTP attempts inside the container, even if an invite check regresses.
        atomic_write(network_override, json.dumps({
            "services": {"synapse": {"extra_hosts": [f"{SMTP_HOST}:127.0.0.1"]}},
        }))
        stack.cmd.extend(["--file", str(network_override)])
        try:
            exercise(stack)
        except Exception:
            subprocess.run([*stack.cmd, "logs", "--no-color", "--tail", "80"], env=stack.env, timeout=30, check=False)
            raise
        finally:
            stack.compose("down", "--volumes", "--remove-orphans", "--timeout", "15", timeout=120)
    print("PASS private Docker deployment, invite gate, trusted proxy headers, restricted routes and restart persistence")


if __name__ == "__main__":
    main()
