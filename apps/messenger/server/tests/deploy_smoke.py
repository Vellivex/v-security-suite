# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the private deployment and backup restore on disposable Docker projects."""

from contextlib import contextmanager
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

from manage import STABLE_FILES, Stack, atomic_write, backup, private_read, restore
from vellivex_email_state import EmailState

DOMAIN = "messenger.example.invalid"
SMTP_HOST = "smtp.example.invalid"
PORT = 8080
CLIENT_IP = "192.0.2.10"
VERSIONS = "/_matrix/client/versions"
EMAIL_API = "/_synapse/client/vellivex/email/"
UNINVITED = {"email": "uninvited@example.invalid"}
INVITED_FIXTURE = "backup-fixture@example.invalid"
CREDENTIAL_FILES = ("postgres-password", "postgres-app-password", "synapse/smtp-password", "synapse/otp-secret")


def request(path, *, body=None, client_ip=CLIENT_IP, forwarded_ip=None, bearer=None):
    headers = {"Host": DOMAIN, "Accept": "application/json"}
    if client_ip is not None:
        headers["CF-Connecting-IP"] = client_ip
    if forwarded_ip is not None:
        headers["X-Forwarded-For"] = forwarded_ip
    if bearer is not None:
        headers["Authorization"] = "Bearer " + bearer
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


def challenge_count(stack):
    return int(stack.compose(
        "exec", "-T", "synapse", "python", "-c",
        "import sqlite3; "
        "db = sqlite3.connect('file:/data/email.sqlite?mode=ro', uri=True); "
        "print(db.execute('SELECT count(*) FROM challenges').fetchone()[0])",
        stdout=subprocess.PIPE, text=True,
    ).stdout.strip())


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
    assert challenge_count(stack) == 0, "Uninvited requests reached the persistent email challenge store"
    assert sql(stack, "SELECT count(*) FROM users") == "0", "Smoke probes created an unexpected user"

    assert sql(stack, "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='messenger'") == "f", (
        "The application database role has administrative privileges"
    )
    sql(stack, "SET ROLE messenger; CREATE TABLE deployment_smoke (marker text NOT NULL); "
               "INSERT INTO deployment_smoke VALUES ('persisted')")
    data = stack.state / "synapse"
    stable_state = {name: (data / name).read_bytes() for name in STABLE_FILES}
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
    return stable_state


@contextmanager
def deployment(temporary, name):
    state = temporary / name
    credentials = temporary / f"{name}-unused-smtp-password"
    atomic_write(credentials, f"unused-{name}-smoke-credential\n")
    subprocess.run(
        [sys.executable, str(DEPLOY / "manage.py"), "--state-dir", str(state), "init",
         "--domain", DOMAIN, "--mode", "tunnel", "--smtp-host", SMTP_HOST,
         "--smtp-username", f"smoke-{name}", "--smtp-password-file", str(credentials)],
        check=True, timeout=20,
    )
    stack = Stack(state)
    network_override = temporary / f"{name}-smtp-loopback.yaml"
    # Keep accidental SMTP attempts inside the container, even if an invite check regresses.
    atomic_write(network_override, json.dumps({
        "services": {"synapse": {"extra_hosts": [f"{SMTP_HOST}:127.0.0.1"]}},
    }))
    stack.cmd.extend(["--file", str(network_override)])
    try:
        yield stack
    except Exception:
        subprocess.run([*stack.cmd, "logs", "--no-color", "--tail", "80"], env=stack.env, timeout=30, check=False)
        raise
    finally:
        stack.compose("down", "--volumes", "--remove-orphans", "--timeout", "15", timeout=120)


def email_state(stack):
    data = stack.state / "synapse"
    return EmailState(
        data / "email.sqlite",
        bytes.fromhex(private_read(data / "otp-secret")),
        bytes.fromhex(private_read(data / "identity-secret")),
    )


def seed_email_challenge(stack):
    broker = email_state(stack)
    challenge = broker.issue(INVITED_FIXTURE, "192.0.2.20")
    # Create a live fixture with the same durable state as an issued code without sending mail.
    broker.set_delivery(challenge.id, True)
    assert challenge_count(stack) == 1, "Backup needs an outstanding source challenge to test exclusion"
    return challenge


def exercise_public_signup(stack):
    stack.signup("public", day_limit=2, month_limit=3)
    wait_for_proxy()
    # The fixture's SMTP name resolves inside Synapse, so delivery fails without leaving the container.
    assert request(EMAIL_API + "request", body=UNINVITED)[0] == 503
    assert challenge_count(stack) == 1, "Public signup failed to reserve the attempted message"
    assert sql(stack, "SELECT count(*) FROM users") == "0", "Requesting a code created a user"
    assert request("/_matrix/client/v3/register", body={"username": "unverified"})[0] == 403

    broker = email_state(stack)
    challenge = broker.issue("verified-public@example.invalid", "192.0.2.20")
    broker.set_delivery(challenge.id, True)
    payload = {"challenge_id": challenge.id, "code": "11111111" if challenge.code == "00000000" else "00000000"}
    assert request(EMAIL_API + "verify", body=payload)[0] == 403
    payload["code"] = challenge.code
    status, verified, _ = request(EMAIL_API + "verify", body=payload)
    assert status == 200 and verified["expires_in_ms"] == 60_000
    assert request(EMAIL_API + "verify", body=payload)[0] == 403
    login = {"type": "m.login.token", "token": verified["login_token"]}
    status, session, _ = request("/_matrix/client/v3/login", body=login)
    assert status == 200 and session["user_id"].startswith("@vx_")
    assert sql(stack, "SELECT count(*) FROM users") == "1", "Email proof did not create exactly one account"
    assert request("/_matrix/client/v3/login", body=login)[0] == 403
    status, full, cache = request(EMAIL_API + "request", body={"email": "another@example.invalid"})
    assert status == 429 and full["vellivex_capacity_exhausted"] is True and cache == "no-store"
    assert full["retry_after_ms"] > 0
    stack.signup("invite")
    wait_for_proxy()
    assert request(EMAIL_API + "request", body=UNINVITED)[0] == 200
    assert challenge_count(stack) == 2, "Closing public signup reset the mail attempt ledger"
    assert request("/_matrix/client/v3/logout", body={}, bearer=session["access_token"])[0] == 200


def exercise_restore(temporary):
    age_identity = temporary / "backup-identity.txt"
    subprocess.run(["age-keygen", "-o", str(age_identity)], capture_output=True, check=True, timeout=15)
    recipient = subprocess.run(
        ["age-keygen", "-y", str(age_identity)], capture_output=True, text=True, check=True, timeout=15,
    ).stdout.strip()
    archive = temporary / "deployment.age"
    with deployment(temporary, "source") as source:
        source.invite([INVITED_FIXTURE])
        stable_state = exercise(source)
        source_credentials = {name: (source.state / name).read_bytes() for name in CREDENTIAL_FILES}
        challenge = seed_email_challenge(source)
        media_marker = source.state / "synapse/media/deployment-smoke-marker"
        atomic_write(media_marker, "fixture media\n")
        backup(source, archive, recipient)
        wait_for_proxy()
        with archive.open("rb") as encrypted:
            assert encrypted.readline(64) == b"age-encryption.org/v1\n", "Backup is not an age-encrypted archive"

    with deployment(temporary, "destination") as destination:
        data = destination.state / "synapse"
        destination_credentials = {name: (destination.state / name).read_bytes() for name in CREDENTIAL_FILES}
        assert all(destination_credentials[name] != source_credentials[name] for name in CREDENTIAL_FILES), (
            "Restore test must start with separate source and destination credentials"
        )
        expected_config = json.loads(private_read(data / "homeserver.yaml"))
        expected_config["macaroon_secret_key"] = stable_state["macaroon-secret"].decode().strip()

        restore(destination, archive, age_identity)
        assert not (destination.state / "restore-in-progress").exists(), "Restore did not complete"
        assert all((data / name).read_bytes() == contents for name, contents in stable_state.items()), (
            "Backup did not restore the signing key, identity key, macaroon secret or invite list"
        )
        assert (data / "media/deployment-smoke-marker").read_bytes() == b"fixture media\n"
        assert all((destination.state / name).read_bytes() == value for name, value in destination_credentials.items()), (
            "Backup overwrote credentials belonging to the destination"
        )
        assert json.loads(private_read(data / "homeserver.yaml")) == expected_config, (
            "Restore changed destination configuration beyond restoring the macaroon secret"
        )
        assert not list(data.glob("email.sqlite*")), "Restore copied the source OTP database or one of its sidecars"

        destination.start()
        wait_for_proxy()
        assert sql(destination, "SET ROLE messenger; SELECT marker FROM deployment_smoke") == "persisted", (
            "Destination did not recover the source database data"
        )
        assert challenge_count(destination) == 0, "Destination OTP store is not fresh"
        assert request(EMAIL_API + "verify", body={"challenge_id": challenge.id, "code": challenge.code})[0] == 403, (
            "Destination accepted a code outstanding in the source deployment"
        )
        assert sql(destination, "SELECT count(*) FROM users") == "0", "A restored OTP challenge created a user"
        exercise_public_signup(destination)


def main():
    if os.geteuid() == 0 or any(shutil.which(tool) is None for tool in ("docker", "age", "age-keygen")):
        raise SystemExit("Run this smoke test as a nonroot user with Docker Compose and age installed.")
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", PORT))
    os.umask(0o077)
    with TemporaryDirectory(prefix="vellivex-deploy-smoke-") as directory:
        exercise_restore(Path(directory))
    print("PASS invite-default deployment, restricted routes, encrypted backup and restore, and public signup proof")


if __name__ == "__main__":
    main()
