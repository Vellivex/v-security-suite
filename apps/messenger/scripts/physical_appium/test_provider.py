"""Private-provider contract tests. No external connection or actual accounts."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock

from device import Device, DeviceError, Element
from provider import MODELS, PRIVACY, Provider, physical_release
from run import MailInput, source_digest


MASKED = (b"REQUEST POST /session/aaaaaaaa/element/bbbbbbbb/value {\"text\":\"REDACTED\"}\n"
          b"RESPONSE {\"value\":null}\nREQUEST GET /session/aaaaaaaa/element/bbbbbbbb/text\n"
          b"RESPONSE {\"value\":\"REDACTED\"}\n")


class ProviderTests(unittest.TestCase):
    def test_physical_release_choices_share_the_normal_package_and_signer(self):
        original = physical_release("alpha08-release")
        universal = physical_release("alpha09-release")
        self.assertEqual([original["version_code"], universal["version_code"]], [8, 9])
        self.assertEqual(original["application_id"], "com.vellivex.messenger.alpha")
        self.assertEqual(original["application_id"], universal["application_id"])
        self.assertEqual(original["signer_sha256"], universal["signer_sha256"])
        self.assertNotEqual(original["app_sha256"], universal["app_sha256"])
        with self.assertRaises(DeviceError):
            physical_release("alpha06-test")

    def test_upload_rechecks_the_selected_release_before_contacting_the_provider(self):
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / "fixture.apk"
            apk.write_bytes(b"fixture")
            provider = object.__new__(Provider)
            provider.release = {"app_bytes": apk.stat().st_size, "app_sha256": hashlib.sha256(b"fixture").hexdigest()}
            provider.request = MagicMock(return_value={"app_url": "bs://" + "a" * 40})
            self.assertEqual(provider.upload(apk), "bs://" + "a" * 40)
            provider.request.reset_mock()
            for changed in (b"changed", b"short"):
                apk.write_bytes(changed)
                with self.assertRaises(DeviceError):
                    provider.upload(apk)
                provider.request.assert_not_called()

    def test_input_exclusively_uses_masked_commands(self):
        transport = MagicMock()
        dev = Device(transport, "f" * 40)
        field = Element(dev, "a" * 32)
        field.send("SYNTHETIC")
        self.assertEqual(transport.hub.call_args.args[-1], {"text": "SYNTHETIC"})
        self.assertTrue(transport.hub.call_args.args[1].endswith("/value"))
        transport.hub.return_value = "SYNTHETIC"
        self.assertEqual("SYNTHETIC", field.text())
        self.assertTrue(transport.hub.call_args.args[1].endswith("/text"))
        for action in (dev.find_text, dev.find_desc, dev.has_text, dev.has_desc, dev.tap_text):
            with self.assertRaises(DeviceError):
                action("SYNTHETIC")
        with self.assertRaises(DeviceError):
            field.attribute("content-desc")
        self.assertNotIn("SYNTHETIC", str(transport.hub.call_args))

    def test_fixed_regex_has_single_dsl_escape(self):
        transport = MagicMock()
        transport.hub.return_value = []
        dev = Device(transport, "f" * 40)
        dev.find_pattern("recovery")
        selector = transport.hub.call_args.args[-1]["value"]
        self.assertIn(r"\s", selector)
        self.assertNotIn(r"\\s", selector)

    def test_all_sessions_require_identical_safe_capabilities(self):
        provider = object.__new__(Provider)
        provider.hub = MagicMock(return_value={"sessionId": "a" * 40})
        provider.start("A", "bs://" + "b" * 40, "test")
        caps = provider.hub.call_args.args[2]["capabilities"]["alwaysMatch"]
        self.assertFalse(caps["appium:printPageSourceOnFindFailure"])
        opts = caps["bstack:options"]
        for name in ("video", "debug", "appiumLogs", "deviceLogs", "networkLogs"):
            self.assertIs(opts[name], False)
        self.assertEqual(opts["appiumVersion"], "2.18.0")
        self.assertEqual(set(opts["maskCommands"].split(",")), {"setValues", "getValues", "screenshot"})

    def test_capacity_constrains_both_independent_stock_devices(self):
        provider = object.__new__(Provider)
        plan = {"parallel_sessions_running": 0, "parallel_sessions_max_allowed": 3,
                "team_parallel_sessions_max_allowed": 2, "queued_sessions": 0}
        stock = [{"os": "android", "realMobile": True, "device": name, "os_version": version} for name, version in MODELS.values()]
        provider.request = MagicMock(side_effect=[plan, stock])
        provider.capacity()
        provider.request = MagicMock(return_value=dict(plan, parallel_sessions_running=1))
        with self.assertRaises(DeviceError):
            provider.capacity()
        provider.request = MagicMock(side_effect=[plan, stock[:1]])
        with self.assertRaises(DeviceError):
            provider.capacity()

    def test_acceptance_requires_actual_server_settings_and_current_session_redaction(self):
        provider = object.__new__(Provider)
        device = MagicMock(session="a" * 40)
        device.reported_capabilities = {"bstack:options": PRIVACY}
        provider.effective_privacy(device)
        for invalid in ({}, {"bstack:options": dict(PRIVACY, video=True)},
                        {"bstack:options": dict(PRIVACY, maskCommands="getValues")}):
            device.reported_capabilities = invalid
            with self.assertRaises(DeviceError):
                provider.effective_privacy(device)
        provider.describe = MagicMock(return_value=({"status": "running"}, "b" * 40))
        provider.request = MagicMock(return_value=MASKED)
        report = provider.audit_canary(device, "A", "fake", "test", "private-canary-" + "d" * 32, live=True)
        self.assertTrue(report["checked_while_running"])

    def test_a_different_commands_redaction_cannot_substitute(self):
        changed = MASKED.replace(b'/text\nRESPONSE', b'/text\nREQUEST GET /session/aaaaaaaa/url\nRESPONSE')
        self.assertFalse(Provider.masked_round_trip(changed.decode()))
        changed = MASKED.replace(b'/bbbbbbbb/text', b'/eeeeeeee/text')
        self.assertFalse(Provider.masked_round_trip(changed.decode()))

    def test_canary_requires_redaction_and_no_capture(self):
        provider = object.__new__(Provider)
        dev = MagicMock(session="a" * 40)
        sentinel = "FAKE-SYNTHETIC-SENTINEL-ONLY"
        record = {"status": "done"}
        provider.describe = MagicMock(return_value=(record, "b" * 40))
        provider.request = MagicMock(return_value=MASKED)
        out = provider.audit_canary(dev, "A", "fake", "test", sentinel)
        self.assertNotIn(sentinel, json.dumps(out))
        record["video_url"] = "synthetic recording exists"
        with self.assertRaises(DeviceError):
            provider.audit_canary(dev, "A", "fake", "test", sentinel)
        del record["video_url"]
        provider.request = MagicMock(return_value=b"POST /value REDACTED GET /text " + sentinel.encode())
        with self.assertRaises(DeviceError):
            provider.audit_canary(dev, "A", "fake", "test", sentinel)

    def test_only_same_registered_session_can_supply_log_path(self):
        provider = object.__new__(Provider)
        dev = MagicMock(session="a" * 40)
        app = "bs://" + "d" * 40
        fact = {"hashed_id": dev.session, "device": MODELS["A"][0], "os": "android", "os_version": "13.0",
                "app_details": {"app_url": app}, "build_name": "test",
                "logs": "https://app-automate.browserstack.com/builds/" + "b" * 40 + "/sessions/" + dev.session + "/logs"}
        provider.request = MagicMock(return_value={"automation_session": fact})
        self.assertEqual(provider.describe(dev, "A", app, "test")[1], "b" * 40)
        fact["logs"] = fact["logs"].replace("app-automate.browserstack.com", "other.example")
        with self.assertRaises(DeviceError):
            provider.describe(dev, "A", app, "test")

    def test_paired_code_waits_for_both_real_screens(self):
        import threading
        mail = object.__new__(MailInput)
        mail.lock = threading.RLock()
        mail.screens = {"A"}
        mail.requested = {"A": 1, "B": 2}
        mail.received = {"email": {}}
        mail.sealed = MagicMock()
        with self.assertRaises(DeviceError):
            mail.code("A")
        mail.ready("B")
        mail.sealed.publish_ready.assert_called_once_with(mail.requested)
        with self.assertRaises(DeviceError):
            mail.ready("B")
        self.assertRegex(source_digest(), "^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
