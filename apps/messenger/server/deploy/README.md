# Vellivex Messenger private beta deployment

This bundle runs pinned Synapse 1.165.0 with PostgreSQL 17.12 and Caddy 2.11.9 on an owner-controlled Linux host. All three images pin official registry digests for Linux AMD64 and ARM64. The database and homeserver listen on container networks. Only the web proxy has host-facing ports.

Use an always-on host with free disk space, Docker Engine and Compose v2, Python 3.12, and a dedicated Matrix hostname. Real email codes need an authenticated implicit-TLS SMTP identity for a verified sender. Confirm the sender's account plan, shared usage and overage settings before activating it. The existing website has its own mail budget and the Messenger broker cannot enforce that account-wide limit. No hosting or sending service is provisioned by these files.

## Install the private instance

Work from a permanent checkout of the reviewed release. Run the commands as an unprivileged host account with Docker access. Keep state outside the checkout. Put the SMTP password in a separate private file owned by that account, with mode 0600.

    messenger_state=/srv/vellivex-messenger
    messenger_tool=apps/messenger/server/deploy/manage.py
    python3 "$messenger_tool" --state-dir "$messenger_state" init \
      --mode tunnel --domain messenger.vellivex.com \
      --smtp-host smtp.resend.com --smtp-username resend \
      --smtp-sender v@vellivex.com \
      --smtp-password-file /path/to/private/smtp-password
    python3 "$messenger_tool" --state-dir "$messenger_state" check
    python3 "$messenger_tool" --state-dir "$messenger_state" start

The operator must be able to create the state directory or have it prepared with mode 0700 and owned by them. Initialization creates separate identity, OTP, session and database secrets, and invites only v@vellivex.com. Choose a dedicated Matrix name and retain it for the life of the account namespace. State survives container replacement.

Choose the HTTPS ingress that matches your host.

- **Named tunnel**. At Cloudflare, route messenger.vellivex.com to http://127.0.0.1:8080 using the host's cloudflared connector. Set the origin HTTP Host Header to messenger.vellivex.com. The host port stays on loopback. The HTTPS edge supplies CF-Connecting-IP, and Caddy rebuilds the forwarding header from that trusted field. Run the connector on a host you control.
- **Direct HTTPS**. Initialize with --mode direct. Point the hostname to the host in DNS-only mode and allow inbound TCP 80 and 443 to Caddy. It obtains and renews the certificate automatically. Caddy rebuilds the forwarding header from the network peer address.

Start-up waits for PostgreSQL and Synapse. Check https://messenger.vellivex.com/_matrix/client/versions. Requests to /_synapse/admin and the federation endpoints should receive 404. Public registration and password login are disabled.

## Test both phones

Use the same HTTPS homeserver in both Android builds. Register two independently controlled invited addresses for a two-person chat. One owner email alone cannot establish a second conversation participant. Add the exact approved second address through the deployment CLI.

    python3 "$messenger_tool" --state-dir "$messenger_state" invite second-tester@example.test

The example is fictional. Use the tester's real authorised address for physical testing. Adding an invitation reloads Synapse if running. Removing an address from the private roster and restarting blocks new verifications and pending codes for that address. Already-issued Matrix sessions need separate revocation.

Install the same verified APK on both phones, sign in to each account, exchange the displayed Matrix IDs, and complete the matching device verification on both screens. Test a fictional message in each direction, then reopen on the recipient and verify the transcript after backgrounding, an offline interval, and network reconnection. Record the Android versions and where the flow stopped, if applicable.

## Boot and recovery

Generate a systemd unit from the installed checkout and deployment state. Install it on the approved host.

    python3 "$messenger_tool" --state-dir "$messenger_state" systemd-unit > vellivex-messenger.service
    sudo install -m 0644 vellivex-messenger.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now vellivex-messenger.service

The unit starts after Docker and the network. For named tunnels, start cloudflared via its own service.

Install age on the host to encrypt backups. Keep the age identity separately. A backup pauses Synapse while it captures PostgreSQL and media, then resumes it. It includes Matrix identity and signing state, encrypted room and media data, and the invite list. SMTP credentials, OTP challenges, the OTP secret and clear client encryption keys are outside the archive.

    python3 "$messenger_tool" --state-dir "$messenger_state" backup /path/to/new-backup.age \
      --recipient <age-public-recipient>

To restore, initialize a fresh state directory on an unpublished host with the same Matrix name and its current SMTP credentials. Run restore before start. The command checks the archive, server name, empty target database and fresh OTP state. The SQL import is transactional.

    python3 "$messenger_tool" --state-dir "$messenger_state" restore /path/to/backup.age \
      --identity /path/to/private-age-identity
    python3 "$messenger_tool" --state-dir "$messenger_state" check

Use trusted backups made by this deployment. A snapshot may predate Matrix session revocations. Verify session state and restore results before reopening the public endpoint. The server backup does not recover client encryption keys. This beta does not offer client key recovery. Run backups on the owner's chosen schedule.

Official software and provider requirements. [Synapse](https://element-hq.github.io/synapse/latest/setup/installation.html) · [PostgreSQL](https://www.postgresql.org/docs/release/17.12/) · [Caddy](https://github.com/caddyserver/caddy/releases/tag/v2.11.9) · [Cloudflare named tunnels](https://developers.cloudflare.com/tunnel/get-started/) · [Resend SMTPS](https://resend.com/docs/send-with-smtp)
