"""Exercise actual Git hooks against local temporary repositories only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]
SAMPLE_IDENTITY = "UnrelatedSampleProject"


class PublicIdentityHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "checkout"
        self.root.mkdir()
        for relative in ("scripts/public_identity_check.py", "scripts/public_identity_hook.py",
                         "scripts/install-public-identity-hooks.py", "scripts/git-hooks/pre-commit",
                         "scripts/git-hooks/pre-push"):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PROJECT / relative, target)
        policy = self.root / "scripts/public_identity_check.py"
        normalized = SAMPLE_IDENTITY.casefold()
        digest = hashlib.sha256(normalized.encode()).hexdigest()
        policy.write_text(policy.read_text().replace(
            'EXPECTED_NAME = "Vellivex"',
            f'RULES = (*RULES, ("other-project", {len(normalized)}, "{digest}"))\nEXPECTED_NAME = "Vellivex"', 1))
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Vellivex")
        self.git("config", "user.email", "v@vellivex.com")
        (self.root / "README.md").write_text("Clean fictional fixture")
        self.git("add", ".")
        self.git("commit", "--no-verify", "-qm", "Initial project")
        self.remote = Path(self.temp.name) / "remote.git"
        self.command(["git", "init", "--bare", "-q", str(self.remote)])

    def tearDown(self):
        self.temp.cleanup()

    def command(self, command, *, env=None, require=True, input=None):
        result = subprocess.run(command, cwd=self.root, env=env,
                                input=input, capture_output=True, text=True)
        if require:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def git(self, *args, **kwargs):
        return self.command(["git", *args], **kwargs)

    def install(self, require=True):
        return self.command(["python3", "scripts/install-public-identity-hooks.py"], require=require)

    def stage(self, content):
        (self.root / "README.md").write_text(content)
        self.git("add", "README.md")

    def assert_remote_empty(self):
        self.assertEqual(self.git("--git-dir=" + str(self.remote), "for-each-ref", "--format=%(refname)").stdout, "")

    def test_installer_is_local_and_idempotent(self):
        self.install()
        self.install()
        self.assertEqual(self.git("config", "--local", "--get", "user.name").stdout.strip(), "Vellivex")
        self.assertEqual(self.git("config", "--local", "--get", "user.email").stdout.strip(), "v@vellivex.com")
        self.assertEqual(self.git("config", "--local", "--get", "core.hooksPath").stdout.strip(), "scripts/git-hooks")
        for hook in ("pre-commit", "pre-push"):
            self.assertTrue(os.access(self.root / "scripts/git-hooks" / hook, os.X_OK))

    def test_installer_refuses_existing_hooks_path(self):
        self.git("config", "--local", "core.hooksPath", "custom-hooks")
        self.assertNotEqual(self.install(require=False).returncode, 0)
        self.assertEqual(self.git("config", "--local", "--get", "core.hooksPath").stdout.strip(), "custom-hooks")

    def test_installer_refuses_existing_active_hook(self):
        hook = self.root / ".git/hooks/pre-push"
        hook.write_text("#!/bin/sh\nexit 0\n")
        hook.chmod(0o755)
        self.assertNotEqual(self.install(require=False).returncode, 0)

    def test_precommit_allows_neutral_project_commit(self):
        self.install()
        self.stage("A clean project update")
        self.git("commit", "-qm", "Update project")

    def test_precommit_blocks_environment_author_override(self):
        self.install()
        self.stage("A clean project update")
        before = self.git("rev-parse", "HEAD").stdout
        environment = dict(os.environ, GIT_AUTHOR_NAME=SAMPLE_IDENTITY,
                           GIT_AUTHOR_EMAIL="sample@example.invalid")
        result = self.git("commit", "-qm", "Update project", env=environment, require=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"source": "proposed-author"', result.stdout + result.stderr)
        self.assertNotIn(SAMPLE_IDENTITY, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, before)

    def test_precommit_checks_staged_bytes_even_when_worktree_is_clean(self):
        self.install()
        self.stage(SAMPLE_IDENTITY)
        (self.root / "README.md").write_text("Clean unstaged version")
        result = self.git("commit", "-qm", "Update project", require=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"source": "staged-content"', result.stdout + result.stderr)

    def test_prepush_allows_neutral_project_push(self):
        self.install()
        self.git("push", str(self.remote), "main")
        self.assertEqual(self.git("--git-dir=" + str(self.remote), "rev-parse", "refs/heads/main").stdout,
                         self.git("rev-parse", "HEAD").stdout)

    def test_prepush_blocks_actual_bad_author_before_remote_ref_changes(self):
        self.install()
        self.stage("Clean current content")
        environment = dict(os.environ, GIT_AUTHOR_NAME=SAMPLE_IDENTITY,
                           GIT_AUTHOR_EMAIL="sample@example.invalid")
        self.git("commit", "--no-verify", "-qm", "Update project", env=environment)
        result = self.git("push", str(self.remote), "main", require=False)
        self.assertNotEqual(result.returncode, 0)
        self.assert_remote_empty()

    def test_prepush_checks_unreferenced_source_commit(self):
        self.install()
        tree = self.git("rev-parse", "HEAD^{tree}").stdout.strip()
        environment = dict(os.environ, GIT_AUTHOR_NAME=SAMPLE_IDENTITY,
                           GIT_AUTHOR_EMAIL="sample@example.invalid")
        oid = self.git("commit-tree", tree, "-p", "HEAD", "-m", "Detached project update", env=environment).stdout.strip()
        result = self.git("push", str(self.remote), oid + ":refs/heads/new", require=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"source": "push-author"', result.stdout)
        self.assert_remote_empty()

    def test_prepush_checks_historical_blob_after_current_cleanup(self):
        self.install()
        self.stage(SAMPLE_IDENTITY)
        self.git("commit", "--no-verify", "-qm", "Historical fixture")
        self.stage("Clean current content")
        self.git("commit", "--no-verify", "-qm", "Clean fixture")
        result = self.git("push", str(self.remote), "main", require=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"source": "push-content"', result.stdout)
        self.assert_remote_empty()

    def test_prepush_refuses_malformed_update_record(self):
        result = self.command(["python3", "scripts/public_identity_hook.py", "pre-push"],
                              input="malformed input\n", require=False)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(json.loads(result.stdout)["passed"])


if __name__ == "__main__":
    unittest.main()
