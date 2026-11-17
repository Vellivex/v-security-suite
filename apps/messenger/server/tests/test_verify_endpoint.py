# SPDX-License-Identifier: GPL-3.0-or-later
from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from synapse.api.errors import SynapseError
from synapse.module_api.errors import ConfigError
from vellivex_email_auth import EmailCodeModule, RequestCode, VerifyCode
from vellivex_email_state import DAY_SECONDS, AddressBudget, EmailState, RateLimited


class VerifyEndpointTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def request(values, address="192.0.2.1"):
        return SimpleNamespace(
            args={}, content=BytesIO(json.dumps(values).encode()),
            getHeader=lambda _name: "application/json",
            getClientAddress=lambda: SimpleNamespace(host=address),
            setHeader=Mock(),
        )

    async def test_public_email_creates_account_only_after_proof(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        state = EmailState(Path(directory.name) / "email.sqlite", b"s" * 32, b"i" * 32, day_limit=2)
        deliveries = {}

        async def dispatch(function, *args):
            return function(*args)

        api = SimpleNamespace(
            defer_to_thread=dispatch, check_user_exists=AsyncMock(return_value=None),
            register_user=AsyncMock(), create_login_token=AsyncMock(return_value="synthetic-login-token"),
            get_qualified_user_id=lambda localpart: f"@{localpart}:messenger.example.test",
        )
        mailer = SimpleNamespace(send=lambda email, challenge: deliveries.update({email: challenge}))
        module = SimpleNamespace(
            dev=False, invited_emails=None, invited_localparts=None, requests=AddressBudget(),
            verifications=AddressBudget(), state=state, api=api, mailer=mailer,
            mail_slots=SimpleNamespace(acquire=AsyncMock(), release=Mock()),
        )
        status, body = await RequestCode(module)._async_render_POST(self.request({"email": " New@EXAMPLE.test "}))
        challenge = deliveries["new@example.test"]
        self.assertEqual((status, body), (200, {"challenge_id": challenge.id}))
        api.check_user_exists.assert_not_awaited()
        api.register_user.assert_not_awaited()
        wrong = "11111111" if challenge.code == "00000000" else "00000000"
        verify = VerifyCode(module)
        with self.assertRaises(SynapseError) as denied:
            await verify._async_render_POST(self.request({"challenge_id": challenge.id, "code": wrong}))
        self.assertEqual(denied.exception.code, 403)
        api.register_user.assert_not_awaited()
        status, result = await verify._async_render_POST(self.request({"challenge_id": challenge.id, "code": challenge.code}))
        self.assertEqual((status, result), (200, {"login_token": "synthetic-login-token", "expires_in_ms": 60_000}))
        api.register_user.assert_awaited_once_with(state.localpart_for("new@example.test"))
        with self.assertRaises(SynapseError):
            await verify._async_render_POST(self.request({"challenge_id": challenge.id, "code": challenge.code}))
        api.create_login_token.assert_awaited_once()

    async def test_public_global_capacity_response_is_uniform_and_address_wait_stays_generic(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        state = EmailState(Path(directory.name) / "email.sqlite", b"s" * 32, b"i" * 32,
                           day_limit=1, now=lambda: 1_000_000)
        state.issue("first@example.test", "192.0.2.1")
        async def dispatch(function, *args):
            return function(*args)
        mailer = SimpleNamespace(send=Mock())
        module = SimpleNamespace(dev=False, invited_emails=None, requests=AddressBudget(), state=state,
                                 api=SimpleNamespace(defer_to_thread=dispatch), mailer=mailer)
        expected = (429, {"errcode": "M_LIMIT_EXCEEDED",
                          "error": "Messenger has reached its sign-in code limit. Try again later.",
                          "retry_after_ms": DAY_SECONDS * 1000, "vellivex_capacity_exhausted": True})
        for email in ("first@example.test", "other@example.test"):
            request = self.request({"email": email})
            self.assertEqual(await RequestCode(module)._async_render_POST(request), expected)
            request.setHeader.assert_any_call(b"Retry-After", b"86400")
            request.setHeader.assert_any_call(b"Cache-Control", b"no-store")
        mailer.send.assert_not_called()
        limited = SimpleNamespace(issue=Mock(side_effect=RateLimited))
        module.state = limited
        with self.assertRaises(SynapseError) as denied:
            await RequestCode(module)._async_render_POST(self.request({"email": "other@example.test"}))
        self.assertEqual(denied.exception.code, 429)
        self.assertEqual(denied.exception.msg, "Try again later.")

    def test_configuration_defaults_to_invites_and_public_signup_is_explicit(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for name, value in (("otp", "01" * 32), ("identity", "02" * 32), ("invites", "owner@example.test")):
            path = root / name
            path.write_text(value)
            path.chmod(0o600)
        config = {
            "mode": "smtp", "otp_secret_file": str(root / "otp"), "identity_secret_file": str(root / "identity"),
            "invited_emails_file": str(root / "invites"), "database": str(root / "email.sqlite"),
            "smtp_host": "smtp.example.test", "smtp_sender": "sender@example.test",
        }
        legacy = EmailCodeModule.parse_config(config)
        self.assertEqual(legacy["invited_emails"], {"owner@example.test"})
        public = EmailCodeModule.parse_config({**config, "signup_mode": "public", "day_limit": 80, "month_limit": 2400})
        self.assertIsNone(public["invited_emails"])
        self.assertEqual((public["state"].day_limit, public["state"].month_limit), (80, 2400))
        for changes in ({"mode": "dev"}, {"day_limit": 81}, {"month_limit": 2401}):
            with self.subTest(changes=changes), self.assertRaises(ConfigError):
                EmailCodeModule.parse_config({**config, "signup_mode": "public", **changes})

    async def test_uninvited_email_has_no_database_or_mailing_side_effect(self):
        request = SimpleNamespace(
            args={},
            content=BytesIO(b'{"email":"uninvited@example.test"}'),
            getHeader=lambda _name: "application/json",
            getClientAddress=lambda: SimpleNamespace(host="192.0.2.1"),
            setHeader=Mock(),
        )
        dispatch = AsyncMock()
        module = SimpleNamespace(dev=False, invited_emails={"v@vellivex.com"}, requests=AddressBudget(),
                                 api=SimpleNamespace(defer_to_thread=dispatch))
        status, body = await RequestCode(module)._async_render_POST(request)
        self.assertEqual(status, 200)
        self.assertRegex(body["challenge_id"], r"^[A-Za-z0-9_-]{43}$")
        dispatch.assert_not_awaited()

    async def test_removed_invite_cannot_exchange_its_pending_code(self):
        request = SimpleNamespace(
            args={},
            content=BytesIO(b'{"challenge_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","code":"12345678"}'),
            getHeader=lambda _name: "application/json",
            getClientAddress=lambda: SimpleNamespace(host="192.0.2.1"),
            setHeader=Mock(),
        )
        api = SimpleNamespace(defer_to_thread=AsyncMock(return_value="vx_removed"), create_login_token=AsyncMock())
        module = SimpleNamespace(verifications=AddressBudget(), invited_localparts={"vx_owner"},
                                 state=SimpleNamespace(consume=Mock()), api=api)
        with self.assertRaises(SynapseError) as denied:
            await VerifyCode(module)._async_render_POST(request)
        self.assertEqual(denied.exception.code, 403)
        api.create_login_token.assert_not_awaited()

    async def test_rate_limit_precedes_database_dispatch(self):
        def request():
            return SimpleNamespace(
                args={},
                content=BytesIO(b'{"challenge_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","code":"12345678"}'),
                getHeader=lambda _name: "application/json",
                getClientAddress=lambda: SimpleNamespace(host="192.0.2.1"),
                setHeader=Mock(),
            )

        dispatch = AsyncMock(return_value=None)
        consume = Mock()
        endpoint = VerifyCode(SimpleNamespace(
            verifications=AddressBudget(per_address=1),
            invited_localparts=None,
            state=SimpleNamespace(consume=consume),
            api=SimpleNamespace(defer_to_thread=dispatch),
        ))
        with self.assertRaises(SynapseError) as first:
            await endpoint._async_render_POST(request())
        self.assertEqual(first.exception.code, 403)
        with self.assertRaises(SynapseError) as second:
            await endpoint._async_render_POST(request())
        self.assertEqual(second.exception.code, 429)
        dispatch.assert_awaited_once_with(consume, "a" * 43, "12345678")
