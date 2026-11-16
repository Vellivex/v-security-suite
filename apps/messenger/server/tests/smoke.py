# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise a running local Synapse and its isolated synthetic mailbox."""

import argparse
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from pathlib import Path
import json
import secrets
import time


def http(method, base, route, body=None, bearer=None):
    headers = {"Accept": "application/json"}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    if bearer is not None:
        headers["Authorization"] = "Bearer " + bearer
    try:
        with urlopen(Request(base + route, data=payload, headers=headers, method=method), timeout=5) as reply:
            return reply.status, json.load(reply)
    except HTTPError as error:
        return error.code, {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=8008, type=int)
    parser.add_argument("--mailbox-port", default=8025, type=int)
    parser.add_argument("--mailbox-key-file", required=True, type=Path)
    options = parser.parse_args()
    origin = f"http://127.0.0.1:{options.port}"
    mailbox = f"http://127.0.0.1:{options.mailbox_port}"
    secret = options.mailbox_key_file.read_text().strip()
    api = "/_synapse/client/vellivex/email/"
    matrix = "/_matrix/client/v3/"

    for _ in range(90):
        try:
            status, body = http("GET", origin, "/_matrix/client/versions")
            if status == 200 and "versions" in body:
                break
        except OSError:
            pass
        time.sleep(0.3)
    else:
        raise AssertionError("Loopback Synapse did not become ready")

    email = f"alice-{secrets.token_hex(5)}@example.test"
    status, challenge = http("POST", origin, api + "request", {"email": email})
    assert status == 200 and set(challenge) == {"challenge_id"}, status
    assert http("GET", mailbox, "/" + challenge["challenge_id"])[0] == 403
    status, delivery = http("GET", mailbox, "/" + challenge["challenge_id"], bearer=secret)
    assert status == 200, status
    code = delivery["code"]
    request = {**challenge, "code": "00000000" if code != "00000000" else "11111111"}
    assert http("POST", origin, api + "verify", request)[0] == 403
    request["code"] = code
    status, verified = http("POST", origin, api + "verify", request)
    assert status == 200 and verified["expires_in_ms"] == 60000, status
    assert http("POST", origin, api + "verify", request)[0] == 403

    login = {"type": "m.login.token", "token": verified["login_token"]}
    status, session = http("POST", origin, matrix + "login", login)
    assert status == 200 and session.get("device_id") and session["user_id"].startswith("@vx_"), status
    assert email not in session["user_id"]
    assert http("POST", origin, matrix + "login", login)[0] == 403
    status, identity = http("GET", origin, matrix + "account/whoami", bearer=session["access_token"])
    assert status == 200 and identity["user_id"] == session["user_id"], status
    assert http("POST", origin, matrix + "logout", {}, bearer=session["access_token"])[0] == 200
    print("PASS synthetic email delivery, wrong-code denial, one-use code, one-use Matrix login token and session logout")


if __name__ == "__main__":
    main()
