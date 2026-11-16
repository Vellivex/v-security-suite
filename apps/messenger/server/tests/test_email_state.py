# SPDX-License-Identifier: GPL-3.0-or-later
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellivex_email_state import (
    CODE_TTL, AddressBudget, EmailState, InvalidEmail, RateLimited, normalize_email,
)


class EmailStateTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name) / "test.sqlite"
        self.now = 1_000_000
        self.state = EmailState(self.db, b"s" * 32, b"i" * 32, ip_hour_limit=2, now=lambda: self.now)
        self.email = "alice@example.test"

    def challenge(self, email=None, address="192.0.2.1"):
        result = self.state.issue(email or self.email, address)
        self.state.set_delivery(result.id, True)
        return result

    def test_delivered_only_and_consumed_exactly_once_in_parallel(self):
        challenge = self.state.issue(self.email, "192.0.2.1")
        self.assertIsNone(self.state.consume(challenge.id, challenge.code))
        self.state.set_delivery(challenge.id, True)
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(self.state.consume, challenge.id, challenge.code) for _ in range(8)]
        accepted = [result for result in (f.result() for f in futures) if result is not None]
        self.assertEqual(len(accepted), 1)
        self.assertRegex(accepted[0], r"^vx_[0-9a-f]{32}$")
        self.now += 61
        next_code = self.challenge()
        self.assertEqual(self.state.consume(next_code.id, next_code.code), accepted[0])

    def test_parallel_challenges_remain_valid_even_when_another_delivery_fails(self):
        first = self.challenge()
        self.now += 61
        second = self.challenge(address="192.0.2.2")
        self.now += 61
        failed = self.state.issue(self.email, "192.0.2.3")
        self.state.set_delivery(failed.id, False)
        identity = self.state.consume(first.id, first.code)
        self.assertIsNotNone(identity)
        self.assertEqual(self.state.consume(second.id, second.code), identity)
        self.assertIsNone(self.state.consume(failed.id, failed.code))
        contents = self.db.read_bytes()
        self.assertNotIn(self.email.encode(), contents)
        self.assertNotIn(b"192.0.2.1", contents)
        self.assertNotIn(first.code.encode(), contents)

    def test_otp_key_rotation_does_not_change_identity(self):
        first = self.challenge()
        old_identity = self.state.consume(first.id, first.code)
        self.now += 61
        self.state = EmailState(self.db, b"r" * 32, b"i" * 32, now=lambda: self.now)
        second = self.challenge()
        self.assertEqual(self.state.consume(second.id, second.code), old_identity)

    def test_refuses_public_directory_and_link_or_public_file(self):
        self.db.chmod(0o644)
        with self.assertRaises(PermissionError):
            EmailState(self.db, b"s" * 32, b"i" * 32)
        self.db.chmod(0o600)
        linked = self.db.with_name("link.sqlite")
        linked.symlink_to(self.db)
        with self.assertRaises(OSError):
            EmailState(linked, b"s" * 32, b"i" * 32)
        self.db.parent.chmod(0o755)
        with self.assertRaises(PermissionError):
            EmailState(self.db, b"s" * 32, b"i" * 32)

    def test_verification_admission_bounds_address_and_global_keys(self):
        budget = AddressBudget(per_address=1, total=2, now=lambda: self.now)
        budget.admit("192.0.2.1")
        with self.assertRaises(RateLimited):
            budget.admit("192.0.2.1")
        budget.admit("192.0.2.2")
        with self.assertRaises(RateLimited):
            budget.admit("192.0.2.3")
        self.assertEqual(len(budget.address_counts), 2)
        self.now += 60
        budget.admit("192.0.2.3")

    def test_expiry_failed_delivery_and_wrong_attempt_limit(self):
        expired = self.challenge()
        self.now += CODE_TTL
        self.assertIsNone(self.state.consume(expired.id, expired.code))
        failed = self.state.issue(self.email, "192.0.2.2")
        self.state.set_delivery(failed.id, False)
        self.assertIsNone(self.state.consume(failed.id, failed.code))
        self.now += 61
        limited = self.challenge()
        wrong = "00000000" if limited.code != "00000000" else "11111111"
        for _ in range(5):
            self.assertIsNone(self.state.consume(limited.id, wrong))
        self.assertIsNone(self.state.consume(limited.id, limited.code))

    def test_resend_client_and_email_budgets(self):
        self.challenge()
        with self.assertRaises(RateLimited):
            self.challenge()
        self.challenge("bob@example.test")
        with self.assertRaises(RateLimited):
            self.challenge("carol@example.test")
        for address in ("192.0.2.2", "192.0.2.3"):
            self.now += 61
            self.challenge(address=address)
        self.now += 61
        with self.assertRaises(RateLimited):
            self.challenge(address="192.0.2.4")

    def test_address_normalization(self):
        self.assertEqual(normalize_email(" Alice+Hello@EXAMPLE.test  "), "alice+hello@example.test")
        for address in ("\r\nalice@mail\n.example.test", "alice@example", ".alice@example.test", 1):
            with self.subTest(address=address), self.assertRaises(InvalidEmail):
                normalize_email(address)


if __name__ == "__main__":
    unittest.main()
