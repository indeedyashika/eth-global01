"""USPS + Chainlink Property Verification MCP server with autonomous x402 payment client.

Hermes uses this MCP to verify physical real estate addresses against USPS records
and DPV (Delivery Point Validation) viability before minting or distributing real-estate tokens.
Settled autonomously via Hedera testnet x402 micropayments (Blocky402 facilitator).
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

import importlib

FastMCP: Any = None
try:
    FastMCP = importlib.import_module("mcp.server.fastmcp").FastMCP
except Exception:
    try:
        FastMCP = importlib.import_module("mcp.server.mcpserver").MCPServer
    except Exception:
        class FastMCP:  # type: ignore
            def __init__(self, name: str):
                self.name = name
            def tool(self):
                def decorator(fn):
                    return fn
                return decorator
            def run(self):
                pass

BASE_URL = os.environ.get("TOKENIZATION_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
AGENT_SECRET = os.environ.get("TOKENIZATION_AGENT_SECRET", "")
HEDERA_OPERATOR_ID = os.environ.get("HEDERA_OPERATOR_ID", "0.0.4491823")

mcp = FastMCP("usps_chainlink")


class UspsOracleError(RuntimeError):
    """Expose safe error messages to Hermes without breaking agent context."""


def _settle_x402_micropayment(challenge: dict[str, Any], simulation: bool = False) -> dict[str, Any]:
    """Autonomously signs and settles a 0.5 HBAR micropayment on Hedera Testnet.

    Returns structured dict with:
        txId: Optional[str] - The real transaction ID if confirmed live on-chain, or None if simulated.
        provenance: str - "LIVE_ONCHAIN" or "SIMULATED"
        status: str - "CONFIRMED", "SIMULATED", or "FAILED"
        invoiceId: str - The invoice ID being settled
    """
    invoice_id = challenge.get("invoiceId", "inv_unknown")
    payee = challenge.get("payee", HEDERA_OPERATOR_ID)
    amount = challenge.get("amount", "50000000")

    # Step 1: Check if direct Python Hedera SDK is available and operator key configured
    operator_key = os.environ.get("HEDERA_OPERATOR_KEY", "")
    operator_id = os.environ.get("HEDERA_OPERATOR_ID", "")

    hiero_sdk = None
    try:
        import hiero_sdk_python as hiero_sdk  # type: ignore
    except ImportError:
        try:
            import hedera as hiero_sdk  # type: ignore
        except ImportError:
            hiero_sdk = None

    if not simulation and hiero_sdk is not None and operator_key and operator_id:
        try:
            # Construct actual CryptoTransferTransaction in Python
            client = hiero_sdk.Client.for_testnet()
            client.set_operator(
                hiero_sdk.AccountId.from_string(operator_id),
                hiero_sdk.PrivateKey.from_string(operator_key),
            )
            transfer_tx = (
                hiero_sdk.TransferTransaction()
                .add_hbar_transfer(
                    hiero_sdk.AccountId.from_string(operator_id),
                    hiero_sdk.Hbar.from_tinybars(-int(amount)),
                )
                .add_hbar_transfer(
                    hiero_sdk.AccountId.from_string(payee),
                    hiero_sdk.Hbar.from_tinybars(int(amount)),
                )
                .set_transaction_memo(f"x402:{invoice_id}")
            )
            response = transfer_tx.execute(client)
            receipt = response.get_receipt(client)
            if str(receipt.status) == "SUCCESS":
                tx_id = str(response.transaction_id)
                return {
                    "txId": tx_id,
                    "provenance": "LIVE_ONCHAIN",
                    "status": "CONFIRMED",
                    "invoiceId": invoice_id,
                }
        except Exception as exc:
            raise UspsOracleError(f"Direct Hedera CryptoTransferTransaction failed: {exc}") from exc

    # Step 2: Use tokenization platform settlement endpoint (/api/x402/settle)
    settle_url = f"{BASE_URL}/api/x402/settle"
    headers = {"Content-Type": "application/json"}
    if AGENT_SECRET:
        headers["X-Tokenization-Agent-Secret"] = AGENT_SECRET

    settle_payload = {
        "invoiceId": invoice_id,
        "payee": payee,
        "amount": str(amount),
        "simulation": simulation,
    }

    try:
        settle_res = httpx.request("POST", settle_url, json=settle_payload, headers=headers, timeout=25.0)
        if settle_res.status_code == 200:
            settle_data = settle_res.json()
            return {
                "txId": settle_data.get("txId"),  # will be None in simulation!
                "provenance": settle_data.get("provenance", "SIMULATED"),
                "status": settle_data.get("status", "SIMULATED"),
                "invoiceId": invoice_id,
            }
        elif settle_res.is_error:
            try:
                err_detail = settle_res.json().get("error", f"HTTP {settle_res.status_code}")
            except Exception:
                err_detail = f"HTTP {settle_res.status_code}"
            raise UspsOracleError(f"Settlement failed ({err_detail})")
    except httpx.HTTPError as exc:
        raise UspsOracleError(f"Settlement service unreachable at {settle_url}: {exc}") from exc

    # If actual settlement cannot be performed: return SIMULATED, txId must be None
    return {
        "txId": None,
        "provenance": "SIMULATED",
        "status": "SIMULATED",
        "invoiceId": invoice_id,
    }


@mcp.tool()
def validate_property_address(
    street: str, city: str, state: str, zip: str, mode: str = "AUTO"
) -> dict[str, Any]:
    """Validate a physical real estate property address against USPS records before tokenization.

    Intercepts HTTP 402 Payment Required challenges, settles the micro-fee autonomously
    via Hedera testnet, and returns standardized USPS address, DPV deliverability status,
    and the cryptographic address hash for on-chain registration.

    Args:
        street: Street address (e.g., "456 Oak Avenue")
        city: City name (e.g., "Miami")
        state: Two-letter US state code (e.g., "FL")
        zip: 5-digit US ZIP code (e.g., "33101")
        mode: Verification mode ("AUTO", "LIVE_USPS", or "SIMULATED_USPS")
    """
    url = f"{BASE_URL}/api/x402/property-oracle"
    headers = {
        "Content-Type": "application/json",
        "X-Verification-Mode": mode,
    }
    if AGENT_SECRET:
        headers["X-Tokenization-Agent-Secret"] = AGENT_SECRET

    payload = {
        "street": street,
        "city": city,
        "state": state,
        "zip": zip,
        "mode": mode,
    }

    try:
        response = httpx.request("POST", url, json=payload, headers=headers, timeout=25.0)
    except httpx.HTTPError as exc:
        raise UspsOracleError(f"Failed to contact property oracle endpoint at {url}: {exc}") from exc

    # If 402 Payment Required received -> Intercept & settle via Hedera
    if response.status_code == 402:
        try:
            body = response.json()
        except ValueError:
            body = {}

        x402_data = body.get("x402", {})
        invoice_id = x402_data.get("invoiceId", "")

        # Autonomously settle micropayment with real CryptoTransfer or explicit simulation
        is_simulation = mode == "SIMULATED_USPS"
        settlement = _settle_x402_micropayment(x402_data, simulation=is_simulation)

        # Retry with payment authorization proof
        paid_headers = dict(headers)
        if settlement.get("txId"):
            paid_headers["X-Payment-Tx"] = settlement["txId"]
        paid_headers["X-Payment-Invoice"] = invoice_id
        paid_headers["X-Payment-Provenance"] = settlement.get("provenance", "SIMULATED")

        # Also supply in payload for robust cross-environment delivery
        paid_payload = dict(payload)
        paid_payload["invoiceId"] = invoice_id
        paid_payload["paymentTx"] = settlement.get("txId")
        paid_payload["provenance"] = settlement.get("provenance", "SIMULATED")

        try:
            paid_response = httpx.request(
                "POST", url, json=paid_payload, headers=paid_headers, timeout=25.0
            )
        except httpx.HTTPError as exc:
            raise UspsOracleError(f"Payment verification request failed: {exc}") from exc

        if paid_response.is_error:
            try:
                err_body = paid_response.json()
                err_detail = err_body.get("error", f"HTTP {paid_response.status_code}")
            except Exception:
                err_detail = f"HTTP {paid_response.status_code}"
            raise UspsOracleError(f"Oracle returned error after payment: {err_detail}")

        try:
            return paid_response.json()
        except ValueError:
            return {
                "isValid": False,
                "error": "Invalid JSON response from oracle",
                "txId": settlement.get("txId"),
            }

    if response.is_error:
        try:
            err_body = response.json()
            err_detail = err_body.get("error", f"HTTP {response.status_code}")
        except Exception:
            err_detail = f"HTTP {response.status_code}"
        raise UspsOracleError(f"Oracle verification failed: {err_detail}")

    try:
        return response.json()
    except ValueError:
        return {"status": "ok"}


@mcp.tool()
def get_verification_status(property_id: str) -> dict[str, Any]:
    """Retrieve the on-chain verification status of a real-estate property.

    Args:
        property_id: Unique identifier or address hash of the property.
    """
    url = f"{BASE_URL}/api/properties/{property_id}/verification"
    headers = {"X-Tokenization-Agent-Secret": AGENT_SECRET} if AGENT_SECRET else {}

    try:
        response = httpx.request("GET", url, headers=headers, timeout=15.0)
        if response.status_code == 404:
            return {
                "propertyId": property_id,
                "status": "UNREGISTERED",
                "uspsVerified": False,
                "provenance": "SIMULATED",
            }
        if response.is_error:
            return {
                "propertyId": property_id,
                "status": "UNAVAILABLE",
                "uspsVerified": False,
                "provenance": "SIMULATED",
                "error": f"HTTP {response.status_code}",
            }
        return response.json()
    except Exception as exc:
        return {
            "propertyId": property_id,
            "status": "UNAVAILABLE",
            "uspsVerified": False,
            "provenance": "SIMULATED",
            "error": f"Verification status service unavailable: {exc}",
        }


@mcp.tool()
def store_verified_hash(property_id: str, address_hash: str) -> dict[str, Any]:
    """Anchor a verified USPS address hash into the on-chain PropertyRegistry contract.

    Args:
        property_id: Unique identifier of the property.
        address_hash: Keccak-256/SHA-256 hash of the standardized USPS address.
    """
    url = f"{BASE_URL}/api/properties/{property_id}/anchor-hash"
    headers = {
        "Content-Type": "application/json",
        "X-Tokenization-Agent-Secret": AGENT_SECRET,
    }
    payload = {"addressHash": address_hash}

    try:
        response = httpx.request("POST", url, json=payload, headers=headers, timeout=20.0)
        if not response.is_error:
            try:
                return response.json()
            except ValueError:
                return {"success": True, "storedHash": address_hash, "anchored": True}
        return {
            "success": False,
            "propertyId": property_id,
            "storedHash": address_hash,
            "anchored": False,
            "error": f"Registry service error: HTTP {response.status_code}",
        }
    except Exception as exc:
        return {
            "success": False,
            "propertyId": property_id,
            "storedHash": address_hash,
            "anchored": False,
            "error": f"Failed to contact property registry service: {exc}",
        }


if __name__ == "__main__":
    mcp.run()
