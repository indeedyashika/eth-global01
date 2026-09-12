"""Comprehensive unit tests for the Superfluid CFA MCP server."""

import os
import unittest
from unittest.mock import MagicMock, patch

from server import (
    SuperfluidAuthorizationError,
    SuperfluidError,
    SuperfluidValidationError,
    create_yield_stream,
    delete_stream,
    get_active_streams,
    get_live_execution_context,
    get_stream_balance,
    mcp,
    update_flow_rate,
    validate_address,
    validate_flow_rate,
    _active_streams,
)


class TestSuperfluidMcp(unittest.TestCase):
    def setUp(self):
        """Clear the in-memory stream registry before each test."""
        _active_streams.clear()

    def test_imports_and_tool_registration(self):
        """Verify the MCP server module, tools, and error classes are properly configured."""
        self.assertEqual(mcp.name, "superfluid")
        self.assertTrue(callable(create_yield_stream))
        self.assertTrue(callable(update_flow_rate))
        self.assertTrue(callable(delete_stream))
        self.assertTrue(callable(get_active_streams))
        self.assertTrue(callable(get_stream_balance))

    def test_validation_helpers(self):
        """Verify strict address and flow rate validation."""
        valid_addr = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        self.assertEqual(validate_address(valid_addr, "test"), valid_addr)

        # Invalid addresses
        with self.assertRaises(SuperfluidValidationError):
            validate_address("0x123", "test")
        with self.assertRaises(SuperfluidValidationError):
            validate_address("0x0000000000000000000000000000000000000000", "test")
        with self.assertRaises(SuperfluidValidationError):
            validate_address("not_an_address", "test")

        # Valid flow rates
        self.assertEqual(validate_flow_rate(100), 100)
        self.assertEqual(validate_flow_rate("500"), 500)

        # Invalid flow rates: zero, negative, non-numeric, overflow
        with self.assertRaises(SuperfluidValidationError):
            validate_flow_rate(0)
        with self.assertRaises(SuperfluidValidationError):
            validate_flow_rate(-10)
        with self.assertRaises(SuperfluidValidationError):
            validate_flow_rate("invalid")
        with self.assertRaises(SuperfluidValidationError):
            validate_flow_rate(2**96)

    def _mock_live(self):
        ctx = {
            "w3": MagicMock(),
            "account": MagicMock(address="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
            "forwarder_address": "0xcfA132E353cB4E398080B9700609bb008eceB125",
        }
        res = {
            "success": True,
            "status": "EXECUTED",
            "provenance": "LIVE_ONCHAIN",
            "txHash": "0x89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
            "basescanUrl": "https://sepolia.basescan.org/tx/0x89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
            "network": "Base Sepolia (84532)",
            "blockNumber": 1234567,
        }
        return patch("server.get_live_execution_context", return_value=(ctx, None)), patch("server._execute_live_forwarder", return_value=res)

    def test_create_yield_stream_unconfigured_fails_closed(self):
        """Verify that when live credentials are absent, operation fails closed with SuperfluidError."""
        with self.assertRaises(SuperfluidError) as ctx:
            create_yield_stream(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                flow_rate=1620370370370,
                property_id="prop_456_oak_ave",
            )
        self.assertIn("LIVE_EXECUTION_UNAVAILABLE", str(ctx.exception))

    def test_create_yield_stream_rejects_invalid_inputs(self):
        """Verify that create_yield_stream rejects invalid flow rates and identical sender/receiver."""
        receiver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

        # Zero flow rate
        with self.assertRaises(SuperfluidValidationError):
            create_yield_stream(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver=receiver,
                flow_rate=0,
                property_id="prop_test",
            )

        # Negative flow rate
        with self.assertRaises(SuperfluidValidationError):
            create_yield_stream(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver=receiver,
                flow_rate=-500,
                property_id="prop_test",
            )

        # Sender equals receiver
        with self.assertRaises(SuperfluidValidationError):
            create_yield_stream(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver=receiver,
                flow_rate=1000,
                property_id="prop_test",
                sender=receiver,
            )

    def test_unauthorized_stream_modifications(self):
        """Verify that updating or deleting non-existent or unauthorized streams is blocked."""
        receiver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

        # Updating non-existent stream
        with self.assertRaises(SuperfluidAuthorizationError):
            update_flow_rate(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver=receiver,
                flow_rate=2000,
                property_id="prop_nonexistent",
            )

        # Deleting non-existent stream
        with self.assertRaises(SuperfluidAuthorizationError):
            delete_stream(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver=receiver,
                property_id="prop_nonexistent",
            )

        p1, p2 = self._mock_live()
        with p1, p2:
            # Create stream under session_A
            create_yield_stream(
                token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                receiver=receiver,
                flow_rate=1000,
                property_id="prop_auth_test",
                session_id="session_A",
            )

            # Attempt to modify under unauthorized session_B
            with self.assertRaises(SuperfluidAuthorizationError):
                update_flow_rate(
                    token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                    receiver=receiver,
                    flow_rate=2000,
                    property_id="prop_auth_test",
                    session_id="session_B",
                )

            # Attempt to delete under unauthorized session_B
            with self.assertRaises(SuperfluidAuthorizationError):
                delete_stream(
                    token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
                    receiver=receiver,
                    property_id="prop_auth_test",
                    session_id="session_B",
                )

    def test_idempotent_operations(self):
        """Verify that repeat operations with identical parameters return idempotent confirmations."""
        token = "0x42bb40bF79730451B11f6De1CbA222F17b87Afd7"
        receiver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        prop = "prop_idempotent"

        p1, p2 = self._mock_live()
        with p1, p2:
            # 1. Create stream
            res1 = create_yield_stream(token, receiver, 1500, prop)
            self.assertFalse(res1.get("idempotent"))

            # 2. Re-create stream with identical parameters -> idempotent
            res2 = create_yield_stream(token, receiver, 1500, prop)
            self.assertTrue(res2.get("idempotent"))
            self.assertEqual(res2.get("flowRate"), 1500)

            # 3. Update stream to new flow rate
            res3 = update_flow_rate(token, receiver, 2500, prop)
            self.assertFalse(res3.get("idempotent"))
            self.assertEqual(res3.get("flowRate"), 2500)

            # 4. Re-update stream with identical flow rate -> idempotent
            res4 = update_flow_rate(token, receiver, 2500, prop)
            self.assertTrue(res4.get("idempotent"))

            # 5. Delete stream
            res5 = delete_stream(token, receiver, prop)
            self.assertFalse(res5.get("idempotent"))

            # 6. Re-delete stream -> idempotent
            res6 = delete_stream(token, receiver, prop)
            self.assertTrue(res6.get("idempotent"))
            self.assertEqual(res6.get("status"), "STREAM_ALREADY_CLOSED")

    @patch("server.get_live_execution_context")
    @patch("server._execute_live_forwarder")
    def test_live_execution_success(self, mock_forwarder, mock_ctx):
        """Verify that when live credentials and gas exist, operations execute on-chain with real receipt."""
        real_hash = "0x89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"
        mock_ctx.return_value = (
            {
                "w3": MagicMock(),
                "account": MagicMock(address="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
                "forwarder_address": "0xcfA132E353cB4E398080B9700609bb008eceB125",
            },
            None,
        )
        mock_forwarder.return_value = {
            "success": True,
            "status": "EXECUTED",
            "provenance": "LIVE_ONCHAIN",
            "txHash": real_hash,
            "basescanUrl": f"https://sepolia.basescan.org/tx/{real_hash}",
            "network": "Base Sepolia (84532)",
            "blockNumber": 1234567,
        }

        result = create_yield_stream(
            token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
            receiver="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            flow_rate=1620370370370,
            property_id="prop_live_test",
        )

        self.assertTrue(result.get("success"))
        self.assertEqual(result.get("status"), "EXECUTED")
        self.assertEqual(result.get("provenance"), "LIVE_ONCHAIN")
        self.assertEqual(result.get("txHash"), real_hash)
        self.assertEqual(result.get("basescanUrl"), f"https://sepolia.basescan.org/tx/{real_hash}")
        self.assertEqual(result.get("network"), "Base Sepolia (84532)")

    @patch("server.get_live_execution_context")
    @patch("server._execute_live_forwarder")
    def test_live_execution_revert_failure(self, mock_forwarder, mock_ctx):
        """Verify that reverted live transactions return status FAILED and success False."""
        real_hash = "0xdeadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567"
        mock_ctx.return_value = (
            {
                "w3": MagicMock(),
                "account": MagicMock(address="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
                "forwarder_address": "0xcfA132E353cB4E398080B9700609bb008eceB125",
            },
            None,
        )
        mock_forwarder.return_value = {
            "success": False,
            "status": "FAILED",
            "provenance": "LIVE_ONCHAIN",
            "txHash": real_hash,
            "basescanUrl": f"https://sepolia.basescan.org/tx/{real_hash}",
            "error": "CFAv1Forwarder transaction reverted on Base Sepolia",
            "network": "Base Sepolia (84532)",
        }

        result = create_yield_stream(
            token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
            receiver="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            flow_rate=1620370370370,
            property_id="prop_revert_test",
        )

        self.assertFalse(result.get("success"))
        self.assertEqual(result.get("status"), "FAILED")
        self.assertEqual(result.get("provenance"), "LIVE_ONCHAIN")
        self.assertIn("reverted", result.get("error"))

    def test_get_stream_balance_and_active_streams(self):
        """Verify querying real-time stream balance and active streams filter correctly."""
        token = "0x42bb40bF79730451B11f6De1CbA222F17b87Afd7"
        receiver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

        p1, p2 = self._mock_live()
        with p1, p2:
            create_yield_stream(token, receiver, 1000000000000, "prop_1")
            create_yield_stream(token, receiver, 2000000000000, "prop_2")

        balance_info = get_stream_balance(token, receiver)
        self.assertTrue(balance_info.get("success"))
        self.assertEqual(balance_info.get("activeStreamCount"), 2)
        self.assertEqual(balance_info.get("flowRate"), 3000000000000)

        active_prop_1 = get_active_streams("prop_1")
        self.assertEqual(active_prop_1.get("activeCount"), 1)
        self.assertEqual(active_prop_1.get("totalFlowRate"), 1000000000000)


if __name__ == "__main__":
    unittest.main()
