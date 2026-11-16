# SPDX-License-Identifier: GPL-3.0-or-later
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from synapse.api.errors import SynapseError
from vellivex_email_auth import RequestCode, VerifyCode
from vellivex_email_state import AddressBudget


class VerifyEndpointTests(unittest.IsolatedAsyncioTestCase):
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
