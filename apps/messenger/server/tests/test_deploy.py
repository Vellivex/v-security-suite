# SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import io
import json
from pathlib import Path
import stat
import sys
import tarfile
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))

from manage import OWNER_EMAIL, STABLE_FILES, Stack, initialize, pack, private_read, proxy_config, unpack


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def test_initialization_stays_private_and_invites_the_owner_only(self):
        password = self.root / "smtp"
        password.write_text("synthetic-deploy-token\n")
        password.chmod(0o600)
        state = self.root / "state"
        options = argparse.Namespace(
            domain="chat.example.test", mode="tunnel", smtp_host="smtp.example.test",
            smtp_port=465, smtp_sender=OWNER_EMAIL, smtp_username="synthetic", smtp_password_file=password,
        )
        initialize(state, options)
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
        private_names = ("smtp-password", "identity-secret", "otp-secret", "invited-emails", "homeserver.yaml")
        for name in private_names:
            self.assertEqual(stat.S_IMODE((state / "synapse" / name).stat().st_mode), 0o600)
        config = json.loads(private_read(state / "synapse" / "homeserver.yaml"))
        self.assertEqual(config["server_name"], "chat.example.test")
        self.assertEqual(config["database"]["name"], "psycopg2")
        self.assertFalse(config["enable_registration"])
        self.assertEqual(config["federation_domain_whitelist"], [])
        self.assertEqual(config["listeners"][0]["resources"][0]["names"], ["client"])
        self.assertEqual(private_read(state / "synapse" / "invited-emails"), OWNER_EMAIL)
        self.assertNotIn("synthetic-deploy-token", json.dumps(config))
        self.assertEqual(config["modules"][0]["config"]["smtp_password_file"], "/data/smtp-password")
        self.assertNotEqual(private_read(state / "synapse" / "identity-secret"),
                            private_read(state / "synapse" / "otp-secret"))
        unit = Stack(state).unit()
        self.assertIn("Requires=docker.service", unit)
        self.assertIn(" start\n", unit)
        self.assertNotIn("synthetic-deploy-token", unit)
        with self.assertRaisesRegex(ValueError, "empty state"):
            initialize(state, options)

    def test_proxy_replaces_forwarded_for_and_tunnel_checks_edge_ip_header(self):
        direct = proxy_config("chat.example.test", "direct")
        tunnel = proxy_config("chat.example.test", "tunnel")
        self.assertIn("X-Forwarded-For {http.request.remote.host}", direct)
        self.assertIn("X-Forwarded-For {http.request.header.CF-Connecting-IP}", tunnel)
        self.assertIn("not header CF-Connecting-IP *", tunnel)
        self.assertIn("http://chat.example.test", tunnel)
        self.assertIn("/_matrix/client/*", direct)
        self.assertNotIn("/_synapse/admin", direct)
        self.assertNotIn("/_matrix/federation", direct)

    def test_backup_entries_exclude_otp_and_mail_credentials_and_restore_into_new_path(self):
        synapse = self.root / "synapse"
        (synapse / "media").mkdir(parents=True)
        (self.root / "metadata.json").write_text('{"format":1,"domain":"chat.example.test"}')
        (self.root / "messenger.dump").write_bytes(b"synthetic-db")
        for name in STABLE_FILES + ("smtp-password", "otp-secret", "email.sqlite"):
            (synapse / name).write_text(name)
        (synapse / "media" / "file").write_text("synthetic ciphertext")
        archive = self.root / "backup.tar"
        pack(self.root, archive)
        restored = self.root / "restored"
        unpack(archive, restored)
        for name in STABLE_FILES:
            self.assertEqual((restored / "synapse" / name).read_text(), name)
        self.assertEqual((restored / "synapse" / "media" / "file").read_text(), "synthetic ciphertext")
        for name in ("smtp-password", "otp-secret", "email.sqlite"):
            self.assertFalse((restored / "synapse" / name).exists())

    def test_restore_rejects_path_traversal_and_symlinks_before_extraction(self):
        for filename, kind in (("synapse/media/../../escape", tarfile.REGTYPE),
                               ("synapse/media/bad-link", tarfile.SYMTYPE)):
            with self.subTest(filename=filename):
                archive = self.root / "untrusted.tar"
                with tarfile.open(archive, "w") as output:
                    item = tarfile.TarInfo(filename)
                    item.type = kind
                    item.linkname = "/etc/passwd"
                    if kind == tarfile.REGTYPE:
                        item.size = 1
                    output.addfile(item, io.BytesIO(b"x") if item.size else None)
                with self.assertRaisesRegex(ValueError, "invalid path"):
                    unpack(archive, self.root / "target")
                self.assertFalse((self.root / "target").exists())
