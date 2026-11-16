# SPDX-License-Identifier: GPL-3.0-or-later
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from synapse.api.errors import SynapseError
from vellivex_email_auth import VerifyCode
from vellivex_email_state import AddressBudget


class VerifyEndpointTests(unittest.IsolatedAsyncioTestCase):
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
