"""Unit tests for the USPS Chainlink MCP tools with truthful x402 payment client."""

import unittest
from unittest.mock import patch, MagicMock
import sys
from server import (
    validate_property_address,
    get_verification_status,
    store_verified_hash,
    _settle_x402_micropayment,
    UspsOracleError,
    mcp,
)


class TestUspsChainlinkMcp(unittest.TestCase):
    def test_imports(self):
        """Verify the MCP server module and tools can be imported."""
        self.assertEqual(mcp.name, "usps_chainlink")
        self.assertTrue(callable(validate_property_address))
        self.assertTrue(callable(get_verification_status))
        self.assertTrue(callable(store_verified_hash))

    @patch("httpx.request")
    def test_settle_simulation_never_generates_fake_tx_id(self, mock_request):
        """Verify simulation mode strictly returns txId: None and never generates fake IDs."""
        mock_settle_res = MagicMock()
        mock_settle_res.status_code = 200
        mock_settle_res.is_error = False
        mock_settle_res.json.return_value = {
            "success": True,
            "txId": None,
            "hashscanUrl": None,
            "provenance": "SIMULATED",
            "status": "SIMULATED",
            "invoiceId": "inv_sim_999",
            "amountTinybars": "50000000",
            "simulationNotice": "Simulation mode requested.",
        }
        mock_request.return_value = mock_settle_res

        challenge = {
            "invoiceId": "inv_sim_999",
            "payee": "0.0.4491823",
            "amount": "50000000",
        }

        result = _settle_x402_micropayment(challenge, simulation=True)
        self.assertIsNone(result.get("txId"), "txId must strictly be None in simulation")
        self.assertEqual(result.get("provenance"), "SIMULATED")
        self.assertEqual(result.get("status"), "SIMULATED")
        self.assertEqual(result.get("invoiceId"), "inv_sim_999")

    def test_settle_live_success_with_python_sdk(self):
        """Verify that when Hedera SDK and credentials are present, real CryptoTransfer is executed."""
        mock_sdk = MagicMock()
        mock_client = MagicMock()
        mock_sdk.Client.for_testnet.return_value = mock_client
        mock_sdk.AccountId.from_string.side_effect = lambda s: f"account_{s}"
        mock_sdk.PrivateKey.from_string.side_effect = lambda s: f"key_{s}"
        mock_sdk.Hbar.from_tinybars.side_effect = lambda t: f"hbar_{t}"

        mock_tx = MagicMock()
        mock_sdk.TransferTransaction.return_value = mock_tx
        mock_tx.add_hbar_transfer.return_value = mock_tx
        mock_tx.set_transaction_memo.return_value = mock_tx

        mock_response = MagicMock()
        mock_response.transaction_id = "0.0.12345@1741234567.890000000"
        mock_receipt = MagicMock()
        mock_receipt.status = "SUCCESS"
        mock_response.get_receipt.return_value = mock_receipt
        mock_tx.execute.return_value = mock_response

        with patch.dict(sys.modules, {"hiero_sdk_python": mock_sdk}), \
             patch.dict("os.environ", {
                 "HEDERA_OPERATOR_KEY": "302e020100300506032b657004220420" + "00" * 16,
                 "HEDERA_OPERATOR_ID": "0.0.12345",
             }):
            challenge = {
                "invoiceId": "inv_live_123",
                "payee": "0.0.4491823",
                "amount": "50000000",
            }
            result = _settle_x402_micropayment(challenge, simulation=False)
            self.assertEqual(result["txId"], "0.0.12345@1741234567.890000000")
            self.assertEqual(result["provenance"], "LIVE_ONCHAIN")
            self.assertEqual(result["status"], "CONFIRMED")
            self.assertEqual(result["invoiceId"], "inv_live_123")

    @patch("httpx.request")
    def test_unconfirmed_live_result_cannot_be_returned_as_live(self, mock_request):
        """A settlement response without a confirmed transaction cannot become live proof."""
        mock_settle_res = MagicMock()
        mock_settle_res.status_code = 200
        mock_settle_res.is_error = False
        mock_settle_res.json.return_value = {
            "success": True,
            "txId": None,
            "provenance": "LIVE_ONCHAIN",
            "status": "CONFIRMED",
        }
        mock_request.return_value = mock_settle_res

        with patch.dict("os.environ", {"HEDERA_OPERATOR_ID": "", "HEDERA_OPERATOR_KEY": ""}):
            with self.assertRaises(UspsOracleError) as ctx:
                _settle_x402_micropayment(
                    {"invoiceId": "inv_no_receipt", "payee": "0.0.4491823", "amount": "50000000"}
                )
        self.assertIn("invalid or unconfirmed", str(ctx.exception))

    @patch("httpx.request")
    def test_validate_address_x402_flow_with_simulated_settlement(self, mock_request):
        """Verify autonomous interception of HTTP 402, settlement, and truthful oracle retry."""
        # 1. First request returns 402 Payment Required
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
                "auditTopicId": "0.0.4491823",
            },
        }

        # 2. Settlement request to /api/x402/settle returns simulated confirmation
        mock_settle = MagicMock()
        mock_settle.status_code = 200
        mock_settle.is_error = False
        mock_settle.json.return_value = {
            "success": True,
            "txId": None,
            "hashscanUrl": None,
            "provenance": "SIMULATED",
            "status": "SIMULATED",
            "invoiceId": "inv_test_12345",
            "amountTinybars": "50000000",
        }

        # 3. Third request with payment returns 200 OK
        mock_200 = MagicMock()
        mock_200.status_code = 200
        mock_200.is_error = False
        mock_200.json.return_value = {
            "isValid": True,
            "dpvConfirmation": "Y",
            "verificationMode": "SIMULATED_USPS",
            "provenance": "SIMULATED",
            "paymentProvenance": "SIMULATED",
            "paymentTxId": None,
            "addressHash": "0x4ded2feea1...",
            "standardizedAddress": {
                "street": "456 OAK AVE",
                "city": "MIAMI",
                "state": "FL",
                "zip": "33101",
            },
            "hcsAudit": {
                "event": "X402_PAYMENT_VERIFIED",
                "topicId": "0.0.4491823",
                "sequenceNumber": 42,
                "txId": None,
                "provenance": "SIMULATED",
            },
        }

        mock_request.side_effect = [mock_402, mock_settle, mock_200]

        result = validate_property_address("456 Oak Avenue", "Miami", "FL", "33101", mode="SIMULATED_USPS")
        self.assertTrue(result.get("isValid"))
        self.assertEqual(result.get("dpvConfirmation"), "Y")
        self.assertEqual(result.get("provenance"), "SIMULATED")
        self.assertIsNone(result.get("paymentTxId"))
        self.assertEqual(mock_request.call_count, 3)

        # Verify call 2 was to /api/x402/settle
        call2_args, call2_kwargs = mock_request.call_args_list[1]
        self.assertIn("/api/x402/settle", call2_args[1])
        self.assertEqual(call2_kwargs["json"]["invoiceId"], "inv_test_12345")

        # Verify call 3 sent invoice proof without fake txId
        call3_args, call3_kwargs = mock_request.call_args_list[2]
        self.assertIn("/api/x402/property-oracle", call3_args[1])
        self.assertEqual(call3_kwargs["headers"]["X-Payment-Invoice"], "inv_test_12345")
        self.assertEqual(call3_kwargs["headers"]["X-Payment-Provenance"], "SIMULATED")
        self.assertNotIn("X-Payment-Tx", call3_kwargs["headers"])

    @patch("httpx.request")
    def test_unpaid_request_settlement_failure(self, mock_request):
        """Verify that when settlement fails, an error is raised and unpaid request does not proceed."""
        mock_402 = MagicMock()
        mock_402.status_code = 402
        mock_402.is_error = False
        mock_402.json.return_value = {
            "status": 402,
            "error": "Payment Required",
            "x402": {
                "invoiceId": "inv_fail_123",
                "amount": "50000000",
                "payee": "0.0.4491823",
            },
        }

        mock_settle_fail = MagicMock()
        mock_settle_fail.status_code = 400
        mock_settle_fail.is_error = True
        mock_settle_fail.json.return_value = {
            "success": False,
            "error": "Insufficient operator balance",
            "code": "INSUFFICIENT_BALANCE",
        }

        mock_request.side_effect = [mock_402, mock_settle_fail]

        with self.assertRaises(UspsOracleError) as ctx:
            validate_property_address("456 Oak Avenue", "Miami", "FL", "33101")
        self.assertIn("Settlement failed", str(ctx.exception))

    @patch("httpx.request")
    def test_validate_address_mode_propagation(self, mock_request):
        """Verify verification mode is properly propagated to the oracle service."""
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
        import httpx

        mock_request.side_effect = httpx.ConnectError("Connection refused")
        res = get_verification_status("prop_test_123")
        self.assertEqual(res["status"], "UNAVAILABLE")
        self.assertFalse(res["uspsVerified"])
        self.assertEqual(res["provenance"], "SIMULATED")

    @patch("httpx.request")
    def test_store_verified_hash_offline_never_fakes_anchored(self, mock_request):
        """Verify store_verified_hash never falsely claims anchored=True when offline."""
        import httpx

        mock_request.side_effect = httpx.ConnectError("Connection refused")
        res = store_verified_hash("prop_test_123", "0x1234567890abcdef")
        self.assertFalse(res["success"])
        self.assertFalse(res["anchored"])


if __name__ == "__main__":
    unittest.main()
