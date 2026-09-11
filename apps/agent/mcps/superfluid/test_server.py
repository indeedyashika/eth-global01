"""Unit tests for the Superfluid CFA MCP server."""

import unittest
from unittest.mock import patch, MagicMock

class TestSuperfluidMcp(unittest.TestCase):
    def test_imports(self):
        """Verify the MCP server module and tools can be imported."""
        from server import (
            create_yield_stream,
            update_flow_rate,
            delete_stream,
            get_active_streams,
            get_stream_balance,
            mcp,
        )
        self.assertEqual(mcp.name, "superfluid")
        self.assertTrue(callable(create_yield_stream))
        self.assertTrue(callable(update_flow_rate))
        self.assertTrue(callable(delete_stream))
        self.assertTrue(callable(get_active_streams))
        self.assertTrue(callable(get_stream_balance))

    def test_create_yield_stream_mock(self):
        """Verify opening a CFA yield stream returns expected metadata."""
        from server import create_yield_stream

        result = create_yield_stream(
            token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
            receiver="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            flow_rate=1620370370370,
            property_id="prop_456_oak_ave"
        )
        self.assertTrue(result.get("success"))
        self.assertEqual(result.get("status"), "STREAM_OPENED")
        self.assertEqual(result.get("receiver"), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
        self.assertEqual(result.get("flowRate"), 1620370370370)
        self.assertIn("txHash", result)

    def test_get_stream_balance(self):
        """Verify querying real-time stream balance returns valid structure."""
        from server import get_stream_balance

        result = get_stream_balance(
            token_address="0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
            receiver="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        )
        self.assertTrue(result.get("success"))
        self.assertIn("currentBalance", result)
        self.assertIn("flowRate", result)

if __name__ == "__main__":
    unittest.main()
