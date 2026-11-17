# SPDX-License-Identifier: GPL-3.0-or-later
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellivex_email_state import (
    CODE_TTL, DAY_SECONDS, MONTH_SECONDS, AddressBudget, CapacityExhausted, EmailState,
    InvalidEmail, RateLimited, client_bucket, normalize_email, signup_limits,
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

    def test_public_defaults_and_provider_budget_ceiling(self):
        self.assertEqual(signup_limits({})[0], "invite")
        self.assertEqual(signup_limits({"signup_mode": "public"})[1], {
            "day_limit": 5, "month_limit": 2400, "ip_hour_limit": 4, "email_hour_limit": 2,
        })
        for limits in ({"day_limit": 81}, {"day_limit": True}, {"month_limit": 2401},
                       {"ip_hour_limit": 7}, {"email_hour_limit": 4}):
            with self.subTest(limits=limits), self.assertRaises(ValueError):
                signup_limits({"signup_mode": "public", **limits})
        with self.assertRaises(ValueError):
            signup_limits({"signup_mode": "public"}, development=True)

    def test_address_budget_groups_ipv6_prefixes_and_mapped_ipv4(self):
        self.assertEqual(client_bucket("2001:db8:100:200::a"), client_bucket("2001:DB8:100:200:123::b"))
        self.assertNotEqual(client_bucket("2001:db8:100:200::a"), client_bucket("2001:db8:100:201::a"))
        self.assertEqual(client_bucket("::ffff:192.0.2.1"), client_bucket("192.0.2.1"))
        self.assertEqual(client_bucket("192.0.2.1, 192.0.2.2"), client_bucket(None))

    def test_daily_capacity_is_atomic_and_survives_restart(self):
        def state():
            return EmailState(self.db, b"s" * 32, b"i" * 32, day_limit=3, now=lambda: self.now)
        self.state = state()
        def attempt(index):
            try:
                self.state.issue(f"member{index}@example.test", f"192.0.2.{index + 1}")
                return True
            except CapacityExhausted:
                return False
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(attempt, range(12))), 3)
        restarted = state()
        with self.assertRaises(CapacityExhausted) as full:
            restarted.issue(self.email, "198.51.100.1")
        self.assertEqual(full.exception.retry_after, DAY_SECONDS)
        self.now += DAY_SECONDS
        self.assertIsNotNone(restarted.issue(self.email, "198.51.100.1"))

    def test_monthly_capacity_includes_failed_delivery_without_retaining_challenges(self):
        self.state = EmailState(self.db, b"s" * 32, b"i" * 32, day_limit=2, month_limit=2, now=lambda: self.now)
        first = self.state.issue(self.email, "192.0.2.1")
        self.state.set_delivery(first.id, False)
        self.now += 17
        self.challenge("bob@example.test")
        self.now += DAY_SECONDS
        with self.assertRaises(CapacityExhausted) as full:
            self.state.issue("charlie@example.test", "198.51.100.1")
        self.assertEqual(full.exception.retry_after, MONTH_SECONDS - DAY_SECONDS - 17)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM challenges").fetchone()[0], 0)
            self.assertEqual([column[1] for column in db.execute("PRAGMA table_info(mail_attempts)")], ["created_at"])
            self.assertEqual(db.execute("SELECT count(*) FROM mail_attempts").fetchone()[0], 2)
        self.now += full.exception.retry_after
        self.assertIsNotNone(self.state.issue("charlie@example.test", "198.51.100.1"))
        self.now += MONTH_SECONDS
        self.state.prune()
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM mail_attempts").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM challenges").fetchone()[0], 0)

    def test_legacy_attempt_backfill_runs_once(self):
        self.challenge()
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("DROP TABLE mail_attempts")
        for _ in range(2):
            migrated = EmailState(self.db, b"s" * 32, b"i" * 32, day_limit=1, now=lambda: self.now)
            with self.assertRaises(CapacityExhausted):
                migrated.issue("bob@example.test", "198.51.100.1")
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM mail_attempts").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
