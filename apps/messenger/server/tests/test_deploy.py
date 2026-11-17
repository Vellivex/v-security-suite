# SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))

from manage import (
    FORMAT, OWNER_EMAIL, STABLE_FILES, Stack, backup, fsync_path, initialize, pack,
    private_read, proxy_config, restore, unpack,
)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def initialize_state(self):
        password = self.root / "smtp"
        password.write_text("synthetic-deploy-token\n")
        password.chmod(0o600)
        state = self.root / "state"
        options = argparse.Namespace(
            domain="chat.example.test", mode="tunnel", smtp_host="smtp.example.test",
            smtp_port=465, smtp_sender=OWNER_EMAIL, smtp_username="synthetic", smtp_password_file=password,
        )
        initialize(state, options)
        return state, options

    def test_initialization_stays_private_and_invites_the_owner_only(self):
        state, options = self.initialize_state()
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
        self.assertEqual(config["modules"][0]["config"]["signup_mode"], "invite")
        self.assertNotEqual(private_read(state / "synapse" / "identity-secret"),
                            private_read(state / "synapse" / "otp-secret"))
        unit = Stack(state).unit()
        self.assertIn("Requires=docker.service", unit)
        self.assertIn(" start\n", unit)
        self.assertNotIn("synthetic-deploy-token", unit)
        with self.assertRaisesRegex(ValueError, "empty state"):
            initialize(state, options)

    def test_signup_mode_changes_only_email_settings_and_preserves_existing_state(self):
        state, _ = self.initialize_state()
        config_path = state / "synapse" / "homeserver.yaml"
        before = json.loads(private_read(config_path))
        roster = private_read(state / "synapse" / "invited-emails")
        stack = Stack(state)
        with patch.object(stack, "service_states", return_value={"running"}), patch.object(stack, "reload_synapse") as reload:
            with self.assertRaisesRegex(ValueError, "day_limit"):
                stack.signup("public", day_limit=81)
            self.assertEqual(json.loads(private_read(config_path)), before)
            reload.assert_not_called()
            stack.signup("public", day_limit=80, month_limit=2400, ip_hour_limit=5)
            after = json.loads(private_read(config_path))
            expected = json.loads(json.dumps(before))
            expected["modules"][0]["config"].update(signup_mode="public", day_limit=80, month_limit=2400,
                                                     ip_hour_limit=5, email_hour_limit=2)
            self.assertEqual(after, expected)
            reload.assert_called_once()
            stack.signup("public")
            reload.assert_called_once()
            stack.signup("invite")
            restored = json.loads(private_read(config_path))
        expected["modules"][0]["config"]["signup_mode"] = "invite"
        self.assertEqual(restored, expected)
        self.assertEqual(private_read(state / "synapse" / "invited-emails"), roster)

    def test_signup_restores_configuration_if_reload_fails(self):
        state, _ = self.initialize_state()
        config_path = state / "synapse" / "homeserver.yaml"
        before = config_path.read_bytes()
        stack = Stack(state)
        with patch.object(stack, "service_states", return_value={"running"}), patch.object(
            stack, "reload_synapse", side_effect=[subprocess.CalledProcessError(1, "docker compose"), None],
        ) as reload:
            with self.assertRaises(subprocess.CalledProcessError):
                stack.signup("public")
        self.assertEqual(config_path.read_bytes(), before)
        self.assertEqual(reload.call_count, 2)

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

    def test_restarting_synapse_must_be_quiescent_before_dump(self):
        state, _ = self.initialize_state()
        stack = Stack(state)
        output = self.root / "backup.age"
        check_state = ("ps", "--all", "--format", "{{.State}}")

        def compose(*args, **_):
            if args == (*check_state, "database"):
                return SimpleNamespace(stdout="running\n")
            if args == (*check_state, "synapse"):
                return SimpleNamespace(stdout="restarting\n")
            self.assertIn(args, (("stop", "-t", "30", "synapse"), ("up", "-d", "--wait", "synapse")))
            return SimpleNamespace()

        with patch.object(stack, "compose", side_effect=compose) as command:
            with self.assertRaisesRegex(ValueError, "Could not confirm that Synapse stopped"):
                backup(stack, output, "age1synthetic")
        self.assertIn(call("stop", "-t", "30", "synapse"), command.call_args_list)
        self.assertIn(call("up", "-d", "--wait", "synapse"), command.call_args_list)
        self.assertFalse(output.exists())

    def test_restore_refuses_active_or_transitional_services(self):
        state, _ = self.initialize_state()
        stack = Stack(state)
        for service in ("proxy", "synapse"):
            for status in ("running", "restarting", "paused", "removing"):
                with self.subTest(service=service, status=status):
                    def compose(*args, **_):
                        self.assertEqual(args[:4], ("ps", "--all", "--format", "{{.State}}"))
                        return SimpleNamespace(stdout=f"{status}\n" if args[-1] == service else "exited\n")

                    with patch.object(stack, "compose", side_effect=compose):
                        with self.assertRaisesRegex(ValueError, "unpublished deployment"):
                            restore(stack, self.root / "unread-backup", self.root / "unused-identity")
        self.assertFalse((state / "restore-in-progress").exists())

    def restore_fixture(self):
        state, options = self.initialize_state()
        stack = Stack(state)
        source = self.root / "source"
        synapse = source / "synapse"
        (synapse / "media").mkdir(parents=True)
        (source / "metadata.json").write_text(json.dumps({"format": FORMAT, "domain": options.domain}))
        (source / "messenger.dump").write_bytes(b"synthetic-db")
        for name in STABLE_FILES:
            (synapse / name).write_text("restored " + name + "\n")
        (synapse / "media" / "fixture").write_text("encrypted media fixture")
        archive = self.root / "fixture.tar"
        pack(source, archive)

        def compose(*args, **kwargs):
            if args[:4] == ("ps", "--all", "--format", "{{.State}}"):
                return SimpleNamespace(stdout="")
            if "psql" in args:
                return SimpleNamespace(stdout=b"0\n")
            self.assertIn("pg_restore", args)
            self.assertTrue((state / "restore-in-progress").is_file())
            self.assertEqual(kwargs["stdin"].read(), b"synthetic-db")
            return SimpleNamespace()

        def decrypt(command, *, check):
            self.assertEqual(command[:2], ["age", "-d"])
            self.assertTrue(check)
            shutil.copyfile(archive, command[command.index("-o") + 1])

        self.enterContext(patch.object(stack, "database"))
        command = self.enterContext(patch.object(stack, "compose", side_effect=compose))
        self.enterContext(patch("manage.subprocess.run", side_effect=decrypt))
        return stack, archive, command

    def test_failed_install_and_rollback_keep_previous_identity_and_block_start(self):
        stack, archive, command = self.restore_fixture()
        data = stack.state / "synapse"
        identity = private_read(data / "identity-secret")
        rename = os.rename

        def fail_install(source, target):
            if Path(source).name in {"replacement", "synapse-before-restore"}:
                raise OSError("injected directory installation failure")
            rename(source, target)

        with patch("manage.os.rename", side_effect=fail_install):
            with self.assertRaisesRegex(OSError, "directory installation failure"):
                restore(stack, archive, self.root / "unused-identity")
        self.assertTrue(any("pg_restore" in invocation.args for invocation in command.call_args_list))
        self.assertEqual(private_read(stack.state / "synapse-before-restore/identity-secret"), identity)
        self.assertTrue((stack.state / "restore-in-progress").is_file())
        with self.assertRaisesRegex(ValueError, "interrupted restore"):
            stack.start()
        stack.database.assert_called_once()

    def test_marker_fsync_failure_prevents_postgres_import(self):
        stack, archive, command = self.restore_fixture()
        marker = stack.state / "restore-in-progress"

        def fail_marker_sync(path, flags=0):
            if path == stack.state and marker.exists():
                raise OSError("injected restore marker fsync failure")
            fsync_path(path, flags)

        with patch("manage.fsync_path", side_effect=fail_marker_sync):
            with self.assertRaisesRegex(OSError, "marker fsync failure"):
                restore(stack, archive, self.root / "unused-identity")
        self.assertFalse(any("pg_restore" in invocation.args for invocation in command.call_args_list))
        self.assertTrue((stack.state / "synapse/identity-secret").is_file())
