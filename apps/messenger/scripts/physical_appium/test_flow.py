# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic, offline tests. No connection to a messaging service or phone."""
import re
import unittest
from unittest.mock import patch

import flow


class Node:
    def __init__(self, text="", click=None, field=None):
        self._text = text
        self._click = click
        self.field = field

    def text(self):
        return self.field.draft if self.field else self._text

    def click(self):
        self._click()

    def send(self, value):
        self.field.draft += value

    def clear(self):
        self.field.draft = ""

    def attribute(self, prop):
        if prop == "className":
            return flow.EDIT if self.field else "android.widget.TextView"
        return prop in {"enabled", "displayed"}


class Pair:
    def __init__(self):
        self.ready_roles = []
        self.request_events = []
        self.received = []
        self.rejected = False
        self.confirmed = []
        self.exchanges = []
        self.checkpoints = []
        self.devices = {r: Phone(self, r) for r in ("A", "B")}
        self.mismatch = False
        self.duplicate = False
        self.lose_history = False
        self.emails = {"A": "one@example.test", "B": "two@example.test"}
        self.codes = {"A": "00000000", "B": "23456789"}

    def email(self, role):
        return self.emails[role]

    def begin(self, role):
        self.request_events.append((role, "begin"))

    def ready(self, role):
        self.request_events.append((role, "ready"))
        self.ready_roles.append(role)

    def code(self, role):
        if set(self.ready_roles) != {"A", "B"}:
            raise AssertionError("A code was read before both challenges reached their screen")
        self.received.append(role)
        return self.codes[role]

    def stage(self, role, name):
        if role not in self.devices or name not in flow.STAGES:
            raise AssertionError("Unknown stage")
        self.checkpoints.append((role, name))


class Phone:
    recover_key = "abcd bcde cdef defg efgh fghj ghjk hjkm jkmn kmnp"
    sas_numbers = "1234  2345  3456"
    sas_emoji = "🐶  🐱  🦁  🐎  🦄  🐷  🐘"

    def __init__(self, pair, role):
        self.pair = pair
        self.role = role
        self.screen = "email"
        self.draft = ""
        self.notice = ""
        self.contact = "@test" + role.lower() + ":example.test"
        self.restarted = False
        self.messages = []

    @property
    def other(self):
        return self.pair.devices["B" if self.role == "A" else "A"]

    def labels(self):
        by_screen = {
            "email": ("Continue with email",),
            "code": ("Eight-digit email code", "Open Vellivex"),
            "recovery": ("Secure your account", "Create recovery key"),
            "key": ("I've saved my recovery key",),
            "inbox": ("Messages", "New conversation", "Your people. Your space."),
            "profile": ("Your Vellivex ID", "Done", "Sign out"),
            "new": ("Start a conversation", "Contact ID or link", "Cancel", "Continue"),
            "sent": ("Verify your contact to start chatting",),
            "invited": ("Conversation invitation",),
            "invitation": ("Accept invitation",),
            "locked": ("Compare a short code with your contact before your first message.",),
            "other-sas": ("Compare codes",),
            "comparing": ("They match", "They don't match"),
            "rejected": ("Verification did not complete. Try again with your contact.", "Done"),
            "verified": ("Contact verified. You can now send private messages.", "Done"),
            "chat": ("Contact verified", "Write a message"),
            "listed": ("Messages", "Verified conversation"),
            "signout": ("Sign out of this phone?", "Sign out"),
        }
        return by_screen.get(self.screen, ()) + ((self.notice,) if self.notice else ())

    def has_text(self, label, timeout=0):
        return label in self.labels()

    def find_text(self, label, timeout=30):
        if not self.has_text(label):
            raise AssertionError("Expected a fixed visible label")
        if self.notice == label:
            # One snackbar observation per input, like a real auto-dismissed notification.
            self.notice = ""
        return Node(label)

    def has_desc(self, label, timeout=0):
        return label in {"chat": ("Back to messages", "Send message"),
                         "locked": ("Verify contact",),
                         "inbox": ("Your profile",), "listed": ("Your profile",)}.get(self.screen, ())

    def find_desc(self, label, timeout=30):
        if not self.has_desc(label):
            raise AssertionError("Expected a fixed visible description")
        def click():
            if label == "Your profile":
                self.previous = self.screen
                self.screen = "profile"
            elif label == "Back to messages":
                self.screen = "listed"
            elif label == "Verify contact":
                if self.other.screen != "locked":
                    raise AssertionError("Other participant did not enter the unverified room")
                self.screen, self.other.screen = "waiting", "other-sas"
            elif label == "Send message":
                if not re.fullmatch(r"VVXQA-[0-9a-f]{12}-[AB]-(fresh|restart)", self.draft):
                    raise AssertionError("Expected synthetic message input")
                if self.draft.endswith("-restart") and not (self.restarted and self.other.restarted):
                    raise AssertionError("Message was sent before both apps restarted")
                self.pair.exchanges.append(self.role)
                self.messages.append(self.draft)
                self.other.messages.append(self.draft)
                if self.pair.duplicate:
                    self.other.messages.append(self.draft)
                self.draft = ""
        return Node(click=click)

    def find_all(self, class_name):
        if class_name != flow.EDIT:
            raise AssertionError("Unbounded class lookup")
        return [Node(field=self)] if self.screen in {"email", "code", "key", "new", "chat"} else []

    def find_pattern(self, kind):
        if kind == "recovery" and self.screen == "key":
            return [Node(self.recover_key)]
        if kind == "contact" and self.screen == "profile":
            return [Node(self.contact)]
        if kind == "sas" and self.screen == "comparing":
            numbers = self.sas_numbers
            if self.pair.mismatch and self.role == "B" and self.pair.rejected:
                numbers = "1234  2345  3457"
            return [Node(self.sas_emoji), Node(numbers)]
        if kind == "witness" and self.screen == "chat":
            return [Node(body) for body in self.messages]
        return []

    def tap_text(self, label, timeout=30):
        self.find_text(label)
        if label == "Continue with email":
            if self.draft == self.pair.email(self.role):
                self.pair.request_events.append((self.role, "submit"))
                self.screen, self.draft = "code", ""
            else:
                self.notice = "Enter a valid email address."
        elif label == "Open Vellivex":
            if self.draft == self.pair.codes[self.role]:
                self.screen = "recovery"
            else:
                self.notice = "That code could not be verified. Check it or request a new one."
            self.draft = ""
        elif label == "Create recovery key":
            self.screen = "key"
        elif label == "I've saved my recovery key":
            if self.draft == self.recover_key[-4:]:
                self.screen = "inbox"
            else:
                self.notice = "Enter the last four characters of your recovery key exactly as shown."
        elif label == "New conversation":
            self.screen, self.draft = "new", ""
        elif label == "Continue":
            if self.draft == self.other.contact:
                self.screen, self.other.screen = "sent", "invited"
            else:
                self.screen, self.notice = "inbox", "Enter another account ID on this messaging service."
        elif label == "Conversation invitation":
            self.screen = "invitation"
        elif label in {"Accept invitation", "Verify your contact to start chatting"}:
            self.screen = "locked"
        elif label == "Compare codes":
            self.screen = self.other.screen = "comparing"
        elif label == "They don't match":
            self.pair.rejected = True
            self.screen = self.other.screen = "rejected"
        elif label == "They match":
            self.pair.confirmed.append(self.role)
            if len(self.pair.confirmed) == 2:
                self.screen = self.other.screen = "verified"
        elif label == "Verified conversation":
            self.screen = "chat"
        elif label == "Done":
            self.screen = {"rejected": "locked", "verified": "chat", "profile": self.previous}[self.screen]
        elif label == "Sign out":
            self.screen = "signout" if self.screen == "profile" else "email"

    def restart(self):
        if self.screen != "listed":
            raise AssertionError("Restart did not begin on the inbox")
        self.restarted = True
        if self.pair.lose_history:
            self.messages.clear()


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.pair = Pair()
        timeout = patch.object(flow, "WAIT_SECONDS", 0)
        timeout.start()
        self.addCleanup(timeout.stop)

    def run_flow(self):
        flow.run_pair(self.pair.devices, self.pair, self.pair.stage)

    def test_two_receipts_two_full_comparisons_and_four_observed_messages(self):
        self.run_flow()
        self.assertEqual(self.pair.received, ["A", "B"])
        self.assertEqual(self.pair.request_events, [(role, event) for role in flow.ROLES
                                                   for event in ("begin", "submit", "ready")])
        self.assertEqual(self.pair.confirmed, ["A", "B"])
        self.assertTrue(self.pair.rejected)
        self.assertEqual(self.pair.exchanges, ["A", "B", "B", "A"])
        self.assertEqual({s for _, s in self.pair.checkpoints}, flow.STAGES)
        for role in flow.ROLES:
            self.assertTrue(self.pair.devices[role].restarted)
            self.assertEqual(self.pair.devices[role].screen, "email")
            stages = [s for r, s in self.pair.checkpoints if r == role]
            self.assertLess(stages.index("wrong-code-rejected"), stages.index("recovery-confirmed"))
            self.assertLess(stages.index("rejected-verification-blocked"), stages.index("second-sas-matched"))
            self.assertLess(stages.index("cold-restart-restored"), stages.index("new-messages-exchanged"))
            self.assertEqual(stages[-1], "signed-out")

    def test_one_sas_difference_blocks_both_confirmations(self):
        self.pair.mismatch = True
        with self.assertRaises(flow.FlowFailure):
            self.run_flow()
        self.assertEqual(self.pair.confirmed, [])
        self.assertEqual(self.pair.exchanges, [])

    def test_duplicates_fail_even_if_the_sender_draft_clears(self):
        self.pair.duplicate = True
        with self.assertRaises(flow.FlowFailure):
            self.run_flow()
        self.assertEqual(self.pair.exchanges, ["A"])

    def test_lost_history_stops_new_messages_after_restart(self):
        self.pair.lose_history = True
        with self.assertRaises(flow.FlowFailure):
            self.run_flow()
        self.assertEqual(self.pair.exchanges, ["A", "B"])
        self.assertTrue(all(d.restarted for d in self.pair.devices.values()))

    def test_shared_mailbox_rejected_before_requests(self):
        self.pair.emails["B"] = self.pair.emails["A"].upper()
        with self.assertRaises(flow.FlowFailure):
            self.run_flow()
        self.assertFalse(self.pair.ready_roles)

    def test_provider_exception_is_fully_sanitized(self):
        with patch.object(self.pair, "code", side_effect=RuntimeError("synthetic-sensitive-marker")):
            with self.assertRaises(flow.FlowFailure) as err:
                self.run_flow()
        self.assertNotIn("synthetic-sensitive", str(err.exception))
        self.assertIsNone(err.exception.__context__)

    def test_incomplete_sas_display_is_not_confirmable(self):
        phone = self.pair.devices["A"]
        for invalid in ("1234  5678", "🐱  🐶  🐷", "1234  2345  345x"):
            with self.subTest(invalid=invalid), patch.object(phone, "find_pattern", return_value=[Node(invalid)]):
                self.assertIsNone(flow._verification_values(phone))

    def test_duplicate_credentials_never_become_selectors(self):
        # A source guard makes future edits opt in explicitly to any new selector.
        import ast
        from pathlib import Path
        tree = ast.parse(Path(flow.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {
                "find_text", "find_desc", "has_text", "has_desc", "tap_text", "find_pattern"
            }:
                self.assertIsInstance(node.args[0], ast.Constant)


if __name__ == "__main__":
    unittest.main()
