"""Unit tests for the USPS Chainlink MCP tools with autonomous x402 payment client."""

import unittest
from unittest.mock import patch, MagicMock

class TestUspsChainlinkMcp(unittest.TestCase):
    def test_imports(self):
        """Verify the MCP server module and tools can be imported."""
        from server import validate_property_address, get_verification_status, store_verified_hash, mcp
        self.assertEqual(mcp.name, "usps_chainlink")
        self.assertTrue(callable(validate_property_address))
        self.assertTrue(callable(get_verification_status))
        self.assertTrue(callable(store_verified_hash))

    @patch("httpx.request")
    def test_validate_address_x402_flow(self, mock_request):
        """Verify autonomous interception of HTTP 402 and payment settlement."""
        from server import validate_property_address

        # Mock 1: First request returns 402 Payment Required
        mock_402 = MagicMock()
        mock_402.status_code = 402
        mock_402.is_error = False
        mock_402.json.return_value = {
            "status": 402,
            "error": "Payment Required",
            "x402": {
                "facilitator": "blocky402",
                "network": "hedera-testnet",
                "payee": "0.0.4491823",
                "amount": "50000000",
                "invoiceId": "inv_test_12345",
                "auditTopicId": "0.0.4491823"
            }
        }

        # Mock 2: Second request with payment returns 200 OK
        mock_200 = MagicMock()
        mock_200.status_code = 200
        mock_200.is_error = False
        mock_200.json.return_value = {
            "isValid": True,
            "dpvConfirmation": "Y",
            "addressHash": "0x4ded2feea1...",
            "standardizedAddress": {
                "street": "456 OAK AVE",
                "city": "MIAMI",
                "state": "FL",
                "zip": "33101"
            },
            "hcsAudit": {
                "event": "X402_PAYMENT_VERIFIED",
                "topicId": "0.0.4491823",
                "sequenceNumber": 42,
                "txId": "0.0.12345@1741234567.890000000"
            }
        }

        mock_request.side_effect = [mock_402, mock_200]

        result = validate_property_address("456 Oak Avenue", "Miami", "FL", "33101")
        self.assertTrue(result.get("isValid"))
        self.assertEqual(result.get("dpvConfirmation"), "Y")
        self.assertIn("addressHash", result)
        self.assertIn("hcsAudit", result)
        self.assertEqual(mock_request.call_count, 2)

if __name__ == "__main__":
    unittest.main()
