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

    @patch("httpx.request")
    def test_validate_address_mode_propagation(self, mock_request):
        """Verify verification mode is properly propagated to the oracle service."""
        from server import validate_property_address

        mock_res = MagicMock()
        mock_res.status_code = 200
        mock_res.is_error = False
        mock_res.json.return_value = {
            "isValid": False,
            "dpvConfirmation": "N",
            "verificationMode": "SIMULATED_USPS",
            "provenance": "SIMULATED",
            "error": "Address not in simulated demo fixture catalog.",
        }
        mock_request.return_value = mock_res

        result = validate_property_address("123 Main St", "Springfield", "IL", "62701", mode="SIMULATED_USPS")
        self.assertFalse(result.get("isValid"))
        self.assertEqual(result.get("dpvConfirmation"), "N")
        self.assertEqual(result.get("verificationMode"), "SIMULATED_USPS")

        # Check that mode was sent in payload and headers
        call_kwargs = mock_request.call_args[1]
        self.assertEqual(call_kwargs["json"]["mode"], "SIMULATED_USPS")
        self.assertEqual(call_kwargs["headers"]["X-Verification-Mode"], "SIMULATED_USPS")

    @patch("httpx.request")
    def test_get_verification_status_offline_never_fakes_true(self, mock_request):
        """Verify get_verification_status never falsely claims uspsVerified=True when offline."""
        from server import get_verification_status
        import httpx

        mock_request.side_effect = httpx.ConnectError("Connection refused")
        res = get_verification_status("prop_test_123")
        self.assertEqual(res["status"], "UNAVAILABLE")
        self.assertFalse(res["uspsVerified"])
        self.assertEqual(res["provenance"], "SIMULATED")

    @patch("httpx.request")
    def test_store_verified_hash_offline_never_fakes_anchored(self, mock_request):
        """Verify store_verified_hash never falsely claims anchored=True when offline."""
        from server import store_verified_hash
        import httpx

        mock_request.side_effect = httpx.ConnectError("Connection refused")
        res = store_verified_hash("prop_test_123", "0x1234567890abcdef")
        self.assertFalse(res["success"])
        self.assertFalse(res["anchored"])


if __name__ == "__main__":
    unittest.main()
