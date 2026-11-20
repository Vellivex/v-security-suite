# Vellivex Messenger development server

This isolated Synapse server is for synthetic beta testing. It creates Matrix accounts after verifying an email code. The Matrix client owns its encryption and device keys. This server is independent of the Vellivex website sign-in.

## Run on loopback

From the repository root, use Python 3.12 and install the pinned Synapse package in a virtual environment.

    python3 -m venv /tmp/vellivex-messenger-venv
    /tmp/vellivex-messenger-venv/bin/python -m pip install -r apps/messenger/server/requirements.txt
    messenger_state=$(mktemp -d)
    printf '%s\n' "$messenger_state"
    /tmp/vellivex-messenger-venv/bin/python apps/messenger/server/dev_server.py \
      --state-dir "$messenger_state" --port 8008 --mailbox-port 8025

On a connected test device or emulator, reverse TCP port 8008 with ADB and enter http://127.0.0.1:8008 in a debug build. Use different synthetic addresses ending in example.test. If running instrumentation, reverse port 8025 as well and provide the generated mailbox key as a test argument. The mailbox listener is optional and loopback only. Read the code directly from the private state directory under mail if the listener is disabled. A new state directory starts a fresh server. To reuse accounts, retain both the state directory and its identity key.

## Native sign-in contract

- POST /_synapse/client/vellivex/email/request with {"email":"alice@example.test"} returns {"challenge_id":"…"}.
- POST /_synapse/client/vellivex/email/verify with {"challenge_id":"…","code":"12345678"} returns a Matrix login token and expires_in_ms (60000). Send the original eight-character string including any leading zeros.
- POST /_matrix/client/v3/login with {"type":"m.login.token","token":"…"} exchanges the single-use token for a standard Matrix device session. Preserve the exact server, user and device identity returned by Synapse.
- Network errors and rejections use ordinary HTTP status codes. Application errors use the Matrix errcode and error fields. The alpha HTTP routes accept JSON only.
- A public deployment at its global mail capacity returns HTTP 429 with `errcode: "M_LIMIT_EXCEEDED"`, `vellivex_capacity_exhausted: true`, `retry_after_ms`, and a seconds-valued Retry-After header. For other public code-request limits, the generic 429 suggests a full minute for a recent resend from the same network or for minute-level request admission. Otherwise it suggests a full hour. The response omits counts and exact expiry times. If another network is also requesting codes, a later attempt can still be limited.

The code expires after ten minutes. Five incorrect attempts exhaust a challenge. Each challenge can succeed once. Separate devices can use separate valid challenges for the same account. Requests are limited per address and email, with a daily send cap. Request and verification routes each have a separate in-process budget before accessing SQLite. Mail dispatch runs at most twice concurrently. The dev mailbox's GET /<challenge_id> route accepts the Bearer value in the private mailbox-key file. It returns only the synthetic code and expiry.

## Verification

    /tmp/vellivex-messenger-venv/bin/python -m unittest discover -s apps/messenger/server/tests
    /tmp/vellivex-messenger-venv/bin/python apps/messenger/server/tests/smoke.py \
      --mailbox-key-file "$messenger_state/mailbox-key"

The smoke test verifies synthetic mail delivery, wrong-code denial, one-use code and login-token handling, session identity and logout. Run it and the server in the same network namespace. Physical-device E2EE and recovery tests are separate.

## Staged SMTP and identity

A server-only SMTP configuration can select mode smtp with a private invited_emails_file containing exact addresses. The module needs a dedicated, user-owned SMTP server with TLS (port 465 by default), smtp_host, smtp_sender and optional paired smtp_username and smtp_password_file. Never turn on the synthetic mailbox on a staged or public server. Use HTTPS and a single trusted TLS reverse proxy that sets Forwarded request addresses from the real connection. If enabling Synapse x_forwarded, overwrite inbound X-Forwarded-For at that proxy and firewall Synapse so only the proxy can connect. Otherwise per-address limits see the proxy address. Use one Synapse process for this alpha module. Its in-memory verification limit is per process.

SMTP mode defaults to invitation-only signup. An operator can opt in to public email-code signup with the [deployment command](deploy/README.md#enable-email-signup). The mailbox must receive the code before Synapse creates an account. The broker keeps a rolling 31-day aggregate table of attempt timestamps. Challenge entries and their email and IP digests expire on a 24-hour schedule, with cleanup running once per minute and at startup.

Keep the email challenge database in its own mode 0700 directory and the database and key files private and owned by the service. otp_secret_file and identity_secret_file contain distinct 32-byte values in hex. Back up identity_secret_file alongside the Synapse sign-in database. Changing this key changes email-to-Matrix-account mapping. Rotating otp_secret_file invalidates pending challenges without changing account identity. Synapse's database holds Matrix identity and login tokens. The module's SQLite database holds short-lived lookup digests and opaque Matrix localparts. Raw email, plaintext codes and sender credentials belong outside that database. Production capacity, SMTP sender permissions, audit, key recovery and device security require separate review before exposing an endpoint. See the [private beta deployment bundle](deploy/README.md) for PostgreSQL, HTTPS ingress, and backup and restore.

See the Synapse installation and extension guides for deployment details. [Installation](https://element-hq.github.io/synapse/latest/setup/installation.html) · [Module resources](https://element-hq.github.io/synapse/latest/modules/writing_a_module.html) · [Module API](https://github.com/element-hq/synapse/blob/v1.165.0/synapse/module_api/__init__.py#L988) · [Matrix client-server API](https://spec.matrix.org/latest/client-server-api/)
