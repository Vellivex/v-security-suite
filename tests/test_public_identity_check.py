import importlib.util
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

CHECKER = Path(__file__).resolve().parents[1] / "scripts" / "public_identity_check.py"
spec = importlib.util.spec_from_file_location("identity_check", CHECKER)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


# Fictional fixtures exercise the matching mechanics without reconstructing any
# real blocked identity in the public test source or test output.
OTHER = "UnrelatedSampleProject"
FULL_NAME = "Sample Person Identity"


class IdentityGuardTests(unittest.TestCase):
    def setUp(self):
        self.original_rules = copy.deepcopy(checker.RULE_INDEX)
        for category, value in (("other-project", OTHER), ("personal-name", FULL_NAME)):
            compact = checker.normalize(value)
            checker.RULE_INDEX.setdefault(len(compact), {})[hashlib.sha256(compact.encode()).hexdigest()] = category
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", checker.EXPECTED_NAME)
        self.git("config", "user.email", checker.EXPECTED_EMAIL)

    def tearDown(self):
        checker.RULE_INDEX.clear()
        checker.RULE_INDEX.update(self.original_rules)
        self.temp.cleanup()

    def git(self, *args, env=None):
        return subprocess.check_output(["git", "-C", str(self.root), *args], env=env)

    def commit(self, content="Clean project text", filename="README.md", env=None):
        (self.root / filename).write_text(content)
        self.git("add", filename)
        self.git("commit", "-qm", "Update public project", env=env)

    def test_clean_project_passes_expected_metadata(self):
        self.commit()
        self.assertTrue(checker.inspect(self.root, require_head_identity=True, check_local_identity=True)["passed"])

    def test_compound_domain_and_case_are_caught(self):
        self.commit("https://notify." + OTHER.upper() + "cateringandevents.co.uk")
        self.assertFalse(checker.inspect(self.root)["passed"])

    def test_single_given_name_is_caught_with_case_and_separators(self):
        fictional_name = "Samplegivenname"
        compact = checker.normalize(fictional_name)
        checker.RULE_INDEX.setdefault(len(compact), {})[hashlib.sha256(compact.encode()).hexdigest()] = "personal-name"
        text = "I am " + "-".join(fictional_name.upper())
        self.assertIn("personal-name", checker.matched_categories(text))

    def test_html_and_unicode_escape_are_caught(self):
        escaped = "".join("&#" + str(ord(c)) + ";" for c in OTHER)
        self.assertIn("other-project", checker.matched_categories(escaped))
        escaped = "".join("\\u" + format(ord(c), "04x") for c in OTHER)
        self.assertIn("other-project", checker.matched_categories(escaped))

    def test_multiline_full_name_is_caught_without_echo(self):
        self.commit(FULL_NAME.replace(" ", "\n"))
        result = checker.inspect(self.root)
        self.assertFalse(result["passed"])
        self.assertNotIn(FULL_NAME, json.dumps(result))
        self.assertTrue(any(f["category"] == "personal-name" for f in result["findings"]))

    def test_path_leak_is_caught_and_redacted(self):
        self.commit(filename=OTHER + ".md")
        result = checker.inspect(self.root)
        self.assertTrue(any(f["source"] == "tracked-path" for f in result["findings"]))
        self.assertNotIn(OTHER, json.dumps(result))

    def test_untracked_and_ignored_files_are_not_in_scope(self):
        self.commit()
        (self.root / ".gitignore").write_text("private-local.txt\n")
        (self.root / "private-local.txt").write_text(OTHER)
        self.assertTrue(checker.inspect(self.root)["passed"])

    def test_history_still_fails_after_current_file_cleaned(self):
        self.commit(OTHER)
        env = dict(os.environ, GIT_AUTHOR_NAME=OTHER, GIT_AUTHOR_EMAIL="x@example.org")
        self.commit("Clean now", env=env)
        self.commit("Still clean")
        result = checker.inspect(self.root)
        self.assertTrue(any(f["source"] == "git-author-name" for f in result["findings"]))
        self.assertTrue(checker.inspect(self.root, history="head")["passed"])

    def test_commit_message_leak_is_caught(self):
        self.commit()
        self.git("commit", "--allow-empty", "-qm", "Remove " + OTHER)
        self.assertTrue(any(f["source"] == "git-message" for f in checker.inspect(self.root)["findings"]))

    def test_historical_content_is_caught_after_neutral_current_cleanup(self):
        self.commit(OTHER)
        self.commit("Clean current public text")
        self.assertTrue(checker.inspect(self.root)["passed"])
        result = checker.inspect(self.root, history_content=True)
        self.assertFalse(result["passed"])
        self.assertTrue(any(f["source"] == "historical-content" for f in result["findings"]))
        self.assertEqual(result["historical_commits_checked"], 2)

    def test_explicit_exclusion_is_reported(self):
        self.commit(OTHER, filename="generated.txt")
        result = checker.inspect(self.root, excludes=("generated.*",))
        self.assertTrue(result["passed"])
        self.assertEqual(result["skipped"][0]["reason"], "explicit-exclusion")

    def test_binary_needs_separate_review_is_reported(self):
        self.commit()
        (self.root / "image.bin").write_bytes(b"\0\x01\x02")
        self.git("add", "image.bin")
        result = checker.inspect(self.root)
        self.assertEqual(result["skipped"][0]["reason"], "binary-needs-artifact-review")

    def test_symlink_target_is_scanned_without_following(self):
        self.commit()
        (self.root / "outside").symlink_to("/unavailable/" + OTHER)
        self.git("add", "outside")
        self.assertFalse(checker.inspect(self.root)["passed"])

    def test_missing_tracked_file_fails_closed(self):
        self.commit()
        (self.root / "README.md").unlink()
        self.assertFalse(checker.inspect(self.root)["passed"])

    def test_wrong_head_identity_fails_without_reprinting_it(self):
        self.commit()
        self.git("config", "user.name", "Unapproved contributor")
        self.git("commit", "--allow-empty", "-qm", "Update")
        result = checker.inspect(self.root, require_head_identity=True)
        self.assertFalse(result["passed"])
        self.assertNotIn("Unapproved contributor", json.dumps(result))

    def test_cli_uses_nonzero_exit_for_findings(self):
        self.commit(OTHER)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = checker.main(["--root", str(self.root)])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.getvalue())["passed"])


if __name__ == "__main__":
    unittest.main()
