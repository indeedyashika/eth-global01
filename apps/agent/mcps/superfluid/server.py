"""Superfluid CFA Yield Streaming MCP Server for the Hermes Agent.

Hermes uses this MCP to open, update, monitor, and freeze per-second
Continuous Flow Agreement (CFA) streams into real estate fractional token holders.
Targets Base Sepolia (fUSDCx).
"""

from __future__ import annotations

import os
import re
import time
from typing import Any

import httpx

try:
    from web3 import Web3, HTTPProvider
    from eth_account import Account
except ImportError:
    Web3 = None  # type: ignore
    Account = None  # type: ignore

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
BASE_SEPOLIA_RPC = os.environ.get("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org")

# Base Sepolia Superfluid CFAv1 Forwarder canonical address
CFA_FORWARDER_ADDRESS = os.environ.get(
    "SUPERFLUID_CFA_FORWARDER_ADDRESS", "0xcfA132E353cB4E398080B9700609bb008eceB125"
)
# Test fUSDCx on Base Sepolia
DEFAULT_FUSDCX_ADDRESS = os.environ.get(
    "SUPERFLUID_SUPER_TOKEN_ADDRESS", "0x42bb40bF79730451B11f6De1CbA222F17b87Afd7"
)
BASE_SEPOLIA_CHAIN_ID = 84532
HEX_ADDRESS_REGEX = re.compile(r"^0x[a-fA-F0-9]{40}$")
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
MAX_INT96 = (2 ** 95) - 1

# Minimal canonical ABI for Superfluid ICFAv1Forwarder
CFA_FORWARDER_ABI = [
    {
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "sender", "type": "address"},
            {"name": "receiver", "type": "address"},
            {"name": "flowRate", "type": "int96"},
            {"name": "userData", "type": "bytes"},
        ],
        "name": "createFlow",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "sender", "type": "address"},
            {"name": "receiver", "type": "address"},
            {"name": "flowRate", "type": "int96"},
            {"name": "userData", "type": "bytes"},
        ],
        "name": "updateFlow",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "sender", "type": "address"},
            {"name": "receiver", "type": "address"},
            {"name": "userData", "type": "bytes"},
        ],
        "name": "deleteFlow",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "sender", "type": "address"},
            {"name": "receiver", "type": "address"},
        ],
        "name": "getFlowrate",
        "outputs": [{"name": "flowRate", "type": "int96"}],
        "stateMutability": "view",
        "type": "function",
    },
]

mcp = FastMCP("superfluid")


class SuperfluidError(RuntimeError):
    """Base error for Superfluid operations."""


class SuperfluidValidationError(SuperfluidError):
    """Raised when input parameters fail strict validation."""


class SuperfluidAuthorizationError(SuperfluidError):
    """Raised when an unauthorized action or stream modification is attempted."""


# In-memory stream registry for fast lookup & simulation
_active_streams: dict[str, dict[str, Any]] = {}


def validate_address(addr: str, param_name: str) -> str:
    """Validate that an address is a valid non-zero 20-byte EVM address."""
    if not addr or not isinstance(addr, str):
        raise SuperfluidValidationError(f"Invalid {param_name}: address must be a non-empty string.")
    cleaned = addr.strip()
    if not HEX_ADDRESS_REGEX.match(cleaned):
        raise SuperfluidValidationError(f"Invalid {param_name}: '{addr}' is not a valid 20-byte EVM address.")
    if cleaned.lower() == ZERO_ADDRESS:
        raise SuperfluidValidationError(f"Invalid {param_name}: zero address is not allowed.")
    return cleaned


def validate_flow_rate(rate: Any) -> int:
    """Validate that flow rate is a strictly positive integer within int96 bounds."""
    if isinstance(rate, bool) or rate is None:
        raise SuperfluidValidationError(f"Invalid flow rate: {rate}. Flow rate must be a positive integer.")
    try:
        val = int(rate)
    except (ValueError, TypeError):
        raise SuperfluidValidationError(f"Invalid flow rate: {rate}. Flow rate must be an integer.")
    if val <= 0:
        raise SuperfluidValidationError(f"Invalid flow rate: {val}. Flow rate must be strictly positive (> 0).")
    if val > MAX_INT96:
        raise SuperfluidValidationError(f"Invalid flow rate: {val}. Flow rate exceeds maximum int96 value ({MAX_INT96}).")
    return val


def get_live_execution_context() -> tuple[dict[str, Any] | None, str | None]:
    """Inspect environment configuration, wallet, and network to determine if live execution is possible.

    Returns:
        (ctx_dict, None) if live execution prerequisites are fully satisfied.
        (None, reason) if prerequisites are incomplete, requiring structured simulation.
    """
    if Web3 is None or Account is None:
        return None, "Web3 or eth_account library not installed in Python runtime."

    private_key = (
        os.environ.get("SUPERFLUID_OPERATOR_KEY", "").strip()
        or os.environ.get("EVM_OPERATOR_PRIVATE_KEY", "").strip()
    )
    if not private_key:
        return None, "No SUPERFLUID_OPERATOR_KEY or EVM_OPERATOR_PRIVATE_KEY configured in environment."

    rpc_url = (
        os.environ.get("BASE_SEPOLIA_RPC_URL", "").strip()
        or os.environ.get("SEPOLIA_RPC_URL", "").strip()
        or "https://sepolia.base.org"
    )

    try:
        w3 = Web3(HTTPProvider(rpc_url, request_kwargs={"timeout": 15}))
        if not w3.is_connected():
            return None, f"Cannot connect to Base Sepolia RPC endpoint at {rpc_url}."
    except Exception as exc:
        return None, f"RPC connection error at {rpc_url}: {exc}"

    try:
        account = Account.from_key(private_key)
    except Exception as exc:
        return None, f"Invalid operator private key: {exc}"

    try:
        balance_wei = w3.eth.get_balance(account.address)
        if balance_wei == 0:
            return None, f"Operator account {account.address} has zero native ETH for gas on Base Sepolia."
    except Exception as exc:
        return None, f"Could not verify operator gas balance on Base Sepolia: {exc}"

    return {
        "w3": w3,
        "account": account,
        "rpc_url": rpc_url,
        "forwarder_address": CFA_FORWARDER_ADDRESS,
    }, None


def _execute_live_forwarder(
    live_ctx: dict[str, Any],
    action: str,
    token: str,
    sender: str,
    receiver: str,
    flow_rate: int = 0,
) -> dict[str, Any]:
    """Execute a real on-chain transaction against the Superfluid CFAv1Forwarder contract."""
    w3: Web3 = live_ctx["w3"]
    account = live_ctx["account"]
    forwarder_addr = Web3.to_checksum_address(live_ctx["forwarder_address"])
    forwarder_contract = w3.eth.contract(address=forwarder_addr, abi=CFA_FORWARDER_ABI)

    chk_token = Web3.to_checksum_address(token)
    chk_sender = Web3.to_checksum_address(sender or account.address)
    chk_receiver = Web3.to_checksum_address(receiver)

    if action == "create":
        fn = forwarder_contract.functions.createFlow(chk_token, chk_sender, chk_receiver, flow_rate, b"")
    elif action == "update":
        fn = forwarder_contract.functions.updateFlow(chk_token, chk_sender, chk_receiver, flow_rate, b"")
    elif action == "delete":
        fn = forwarder_contract.functions.deleteFlow(chk_token, chk_sender, chk_receiver, b"")
    else:
        raise ValueError(f"Unknown forwarder action: {action}")

    try:
        nonce = w3.eth.get_transaction_count(account.address, "pending")
        tx_data = fn.build_transaction({
            "chainId": BASE_SEPOLIA_CHAIN_ID,
            "from": account.address,
            "nonce": nonce,
        })
        signed = account.sign_transaction(tx_data)
        tx_hash_bytes = w3.eth.send_raw_transaction(signed.rawTransaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash_bytes, timeout=60)
    except Exception as exc:
        return {
            "success": False,
            "status": "FAILED",
            "provenance": "LIVE_ONCHAIN",
            "txHash": None,
            "basescanUrl": None,
            "error": f"Live CFAv1Forwarder execution failed: {exc}",
            "network": "Base Sepolia (84532)",
        }

    raw_hash = receipt.transactionHash.hex() if hasattr(receipt.transactionHash, "hex") else str(receipt.transactionHash)
    tx_hash = raw_hash if raw_hash.startswith("0x") else f"0x{raw_hash}"

    if getattr(receipt, "status", None) == 1:
        return {
            "success": True,
            "status": "EXECUTED",
            "provenance": "LIVE_ONCHAIN",
            "txHash": tx_hash,
            "basescanUrl": f"https://sepolia.basescan.org/tx/{tx_hash}",
            "network": "Base Sepolia (84532)",
            "blockNumber": getattr(receipt, "blockNumber", None),
        }
    else:
        return {
            "success": False,
            "status": "FAILED",
            "provenance": "LIVE_ONCHAIN",
            "txHash": tx_hash,
            "basescanUrl": f"https://sepolia.basescan.org/tx/{tx_hash}",
            "error": "CFAv1Forwarder transaction reverted on Base Sepolia",
            "network": "Base Sepolia (84532)",
            "blockNumber": getattr(receipt, "blockNumber", None),
        }


def _sync_stream_to_platform(stream_data: dict[str, Any]) -> None:
    """Synchronize stream state to the Next.js platform API if reachable."""
    try:
        url = f"{BASE_URL}/api/yield/streams"
        headers = {"Content-Type": "application/json"}
        if AGENT_SECRET:
            headers["X-Tokenization-Agent-Secret"] = AGENT_SECRET
        httpx.post(url, json=stream_data, headers=headers, timeout=0.5)
    except Exception:
        pass


@mcp.tool()
def create_yield_stream(
    token_address: str,
    receiver: str,
    flow_rate: int,
    property_id: str,
    sender: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Open a Superfluid Constant Flow Agreement (CFA) yield stream to an investor.

    Continuous per-second rent cashflow will be streamed from the vault reserve
    directly to the investor's wallet address on Base Sepolia.

    Args:
        token_address: Super Token address on Base Sepolia (e.g., fUSDCx).
        receiver: Investor's EVM wallet address.
        flow_rate: Inflow rate in wei per second (strictly positive integer).
        property_id: Unique property identifier.
        sender: Optional stream sender address. Defaults to operator wallet.
        session_id: Optional ERC-7579 session authorization identifier.
    """
    token = validate_address(token_address or DEFAULT_FUSDCX_ADDRESS, "token_address")
    valid_receiver = validate_address(receiver, "receiver")
    valid_flow_rate = validate_flow_rate(flow_rate)
    property_id = str(property_id).strip()
    if not property_id:
        raise SuperfluidValidationError("property_id cannot be empty.")

    sender_clean = validate_address(sender, "sender") if sender else None
    if sender_clean and sender_clean.lower() == valid_receiver.lower():
        raise SuperfluidValidationError("Stream receiver cannot be the same address as sender.")

    stream_key = f"{property_id}:{valid_receiver.lower()}"

    # Idempotency check: if an active stream with identical parameters already exists
    if stream_key in _active_streams:
        existing = _active_streams[stream_key]
        if (
            existing.get("status") == "ACTIVE"
            and existing.get("flowRate") == valid_flow_rate
            and existing.get("token", "").lower() == token.lower()
        ):
            return {
                "success": True,
                "status": existing.get("status", "SIMULATED"),
                "action": "STREAM_OPENED",
                "provenance": existing.get("provenance", "SIMULATED"),
                "propertyId": property_id,
                "receiver": valid_receiver,
                "flowRate": valid_flow_rate,
                "token": token,
                "txHash": existing.get("txHash"),
                "basescanUrl": existing.get("basescanUrl"),
                "network": existing.get("network", "Base Sepolia"),
                "idempotent": True,
                "detail": "Stream already active with identical flow rate and token.",
            }

    live_ctx, live_reason = get_live_execution_context()

    if live_ctx is not None:
        exec_sender = sender_clean or live_ctx["account"].address
        live_result = _execute_live_forwarder(
            live_ctx,
            action="create",
            token=token,
            sender=exec_sender,
            receiver=valid_receiver,
            flow_rate=valid_flow_rate,
        )
        if not live_result.get("success"):
            return {
                **live_result,
                "propertyId": property_id,
                "receiver": valid_receiver,
                "flowRate": valid_flow_rate,
                "token": token,
                "idempotent": False,
            }

        stream_data = {
            "propertyId": property_id,
            "token": token,
            "sender": exec_sender,
            "receiver": valid_receiver,
            "flowRate": valid_flow_rate,
            "monthlyRentEquivUsd": (
                round(valid_flow_rate * 2592000 / 1e18, 2)
                if valid_flow_rate > 1e12
                else round(valid_flow_rate * 2592000 / 1e6, 2)
            ),
            "startedAt": int(time.time()),
            "status": "ACTIVE",
            "provenance": "LIVE_ONCHAIN",
            "txHash": live_result["txHash"],
            "basescanUrl": live_result["basescanUrl"],
            "network": live_result["network"],
            "sessionId": session_id,
        }
        _active_streams[stream_key] = stream_data
        _sync_stream_to_platform(stream_data)

        return {
            "success": True,
            "status": "EXECUTED",
            "action": "STREAM_OPENED",
            "provenance": "LIVE_ONCHAIN",
            "propertyId": property_id,
            "receiver": valid_receiver,
            "flowRate": valid_flow_rate,
            "token": token,
            "txHash": live_result["txHash"],
            "basescanUrl": live_result["basescanUrl"],
            "network": live_result["network"],
            "idempotent": False,
        }

    # Truthful SIMULATED path: live execution unavailable, no fake receipts generated
    sim_sender = sender_clean or CFA_FORWARDER_ADDRESS
    stream_data = {
        "propertyId": property_id,
        "token": token,
        "sender": sim_sender,
        "receiver": valid_receiver,
        "flowRate": valid_flow_rate,
        "monthlyRentEquivUsd": (
            round(valid_flow_rate * 2592000 / 1e18, 2)
            if valid_flow_rate > 1e12
            else round(valid_flow_rate * 2592000 / 1e6, 2)
        ),
        "startedAt": int(time.time()),
        "status": "ACTIVE",
        "provenance": "SIMULATED",
        "txHash": None,
        "basescanUrl": None,
        "network": "Base Sepolia (Simulated)",
        "sessionId": session_id,
    }
    _active_streams[stream_key] = stream_data
    _sync_stream_to_platform(stream_data)

    return {
        "success": True,
        "status": "SIMULATED",
        "action": "STREAM_OPENED",
        "provenance": "SIMULATED",
        "propertyId": property_id,
        "receiver": valid_receiver,
        "flowRate": valid_flow_rate,
        "token": token,
        "txHash": None,
        "basescanUrl": None,
        "network": "Base Sepolia (Simulated)",
        "simulationReason": live_reason or "Live execution credentials not provided.",
        "idempotent": False,
    }


@mcp.tool()
def update_flow_rate(
    token_address: str,
    receiver: str,
    flow_rate: int,
    property_id: str,
    sender: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Update the per-second flow rate of an active Superfluid CFA yield stream.

    Args:
        token_address: Super Token address on Base Sepolia.
        receiver: Investor's EVM wallet address.
        flow_rate: New flow rate in wei per second (strictly positive integer).
        property_id: Unique property identifier.
        sender: Optional stream sender address.
        session_id: Optional ERC-7579 session authorization identifier.
    """
    token = validate_address(token_address or DEFAULT_FUSDCX_ADDRESS, "token_address")
    valid_receiver = validate_address(receiver, "receiver")
    valid_flow_rate = validate_flow_rate(flow_rate)
    property_id = str(property_id).strip()
    if not property_id:
        raise SuperfluidValidationError("property_id cannot be empty.")

    stream_key = f"{property_id}:{valid_receiver.lower()}"

    # Authorization Check: Stream must exist to be modified
    if stream_key not in _active_streams:
        raise SuperfluidAuthorizationError(
            f"Unauthorized: No active stream found for property '{property_id}' and receiver '{valid_receiver}'."
        )

    stream = _active_streams[stream_key]
    if stream.get("status") != "ACTIVE":
        raise SuperfluidAuthorizationError(
            f"Unauthorized: Cannot update stream with status '{stream.get('status')}'."
        )

    # Prevent session from modifying an unauthorized stream belonging to another session
    if session_id and stream.get("sessionId") and stream["sessionId"] != session_id:
        raise SuperfluidAuthorizationError(
            f"Unauthorized: Session '{session_id}' is not authorized to modify stream created under session '{stream['sessionId']}'."
        )

    # Idempotency check: if flow rate is already set to target value
    if stream.get("flowRate") == valid_flow_rate:
        return {
            "success": True,
            "status": stream.get("provenance", "SIMULATED"),
            "action": "STREAM_UPDATED",
            "provenance": stream.get("provenance", "SIMULATED"),
            "propertyId": property_id,
            "receiver": valid_receiver,
            "flowRate": valid_flow_rate,
            "token": token,
            "txHash": stream.get("txHash"),
            "basescanUrl": stream.get("basescanUrl"),
            "network": stream.get("network", "Base Sepolia"),
            "idempotent": True,
            "detail": "Flow rate already set to requested value.",
        }

    live_ctx, live_reason = get_live_execution_context()

    if live_ctx is not None:
        exec_sender = sender or stream.get("sender") or live_ctx["account"].address
        live_result = _execute_live_forwarder(
            live_ctx,
            action="update",
            token=token,
            sender=exec_sender,
            receiver=valid_receiver,
            flow_rate=valid_flow_rate,
        )
        if not live_result.get("success"):
            return {
                **live_result,
                "propertyId": property_id,
                "receiver": valid_receiver,
                "flowRate": valid_flow_rate,
                "token": token,
                "idempotent": False,
            }

        stream["flowRate"] = valid_flow_rate
        stream["updatedAt"] = int(time.time())
        stream["txHash"] = live_result["txHash"]
        stream["basescanUrl"] = live_result["basescanUrl"]
        stream["provenance"] = "LIVE_ONCHAIN"
        stream["network"] = live_result["network"]
        _sync_stream_to_platform(stream)

        return {
            "success": True,
            "status": "EXECUTED",
            "action": "STREAM_UPDATED",
            "provenance": "LIVE_ONCHAIN",
            "propertyId": property_id,
            "receiver": valid_receiver,
            "flowRate": valid_flow_rate,
            "token": token,
            "txHash": live_result["txHash"],
            "basescanUrl": live_result["basescanUrl"],
            "network": live_result["network"],
            "idempotent": False,
        }

    # Truthful SIMULATED path: update local registry, no fake receipts
    stream["flowRate"] = valid_flow_rate
    stream["updatedAt"] = int(time.time())
    stream["txHash"] = None
    stream["basescanUrl"] = None
    stream["provenance"] = "SIMULATED"
    stream["network"] = "Base Sepolia (Simulated)"
    _sync_stream_to_platform(stream)

    return {
        "success": True,
        "status": "SIMULATED",
        "action": "STREAM_UPDATED",
        "provenance": "SIMULATED",
        "propertyId": property_id,
        "receiver": valid_receiver,
        "flowRate": valid_flow_rate,
        "token": token,
        "txHash": None,
        "basescanUrl": None,
        "network": "Base Sepolia (Simulated)",
        "simulationReason": live_reason or "Live execution credentials not provided.",
        "idempotent": False,
    }


@mcp.tool()
def delete_stream(
    token_address: str,
    receiver: str,
    property_id: str,
    sender: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Halt and delete an ongoing Superfluid CFA yield stream for an investor.

    Args:
        token_address: Super Token address.
        receiver: Investor's EVM wallet address.
        property_id: Unique property identifier.
        sender: Optional stream sender address.
        session_id: Optional ERC-7579 session authorization identifier.
    """
    token = validate_address(token_address or DEFAULT_FUSDCX_ADDRESS, "token_address")
    valid_receiver = validate_address(receiver, "receiver")
    property_id = str(property_id).strip()
    if not property_id:
        raise SuperfluidValidationError("property_id cannot be empty.")

    stream_key = f"{property_id}:{valid_receiver.lower()}"

    # Authorization Check: Stream must exist to be deleted
    if stream_key not in _active_streams:
        raise SuperfluidAuthorizationError(
            f"Unauthorized: No stream found for property '{property_id}' and receiver '{valid_receiver}'."
        )

    stream = _active_streams[stream_key]

    # Prevent session from modifying an unauthorized stream belonging to another session
    if session_id and stream.get("sessionId") and stream["sessionId"] != session_id:
        raise SuperfluidAuthorizationError(
            f"Unauthorized: Session '{session_id}' is not authorized to delete stream created under session '{stream['sessionId']}'."
        )

    # Idempotency check: if stream is already closed
    if stream.get("status") == "CLOSED":
        return {
            "success": True,
            "status": "STREAM_ALREADY_CLOSED",
            "action": "STREAM_DELETED",
            "provenance": stream.get("provenance", "SIMULATED"),
            "propertyId": property_id,
            "receiver": valid_receiver,
            "txHash": None,
            "basescanUrl": None,
            "network": stream.get("network", "Base Sepolia"),
            "idempotent": True,
            "detail": "Stream is already closed.",
        }

    live_ctx, live_reason = get_live_execution_context()

    if live_ctx is not None:
        exec_sender = sender or stream.get("sender") or live_ctx["account"].address
        live_result = _execute_live_forwarder(
            live_ctx,
            action="delete",
            token=token,
            sender=exec_sender,
            receiver=valid_receiver,
            flow_rate=0,
        )
        if not live_result.get("success"):
            return {
                **live_result,
                "propertyId": property_id,
                "receiver": valid_receiver,
                "idempotent": False,
            }

        stream["status"] = "CLOSED"
        stream["flowRate"] = 0
        stream["closedAt"] = int(time.time())
        stream["txHash"] = live_result["txHash"]
        stream["basescanUrl"] = live_result["basescanUrl"]
        stream["provenance"] = "LIVE_ONCHAIN"
        stream["network"] = live_result["network"]
        _sync_stream_to_platform(stream)

        return {
            "success": True,
            "status": "EXECUTED",
            "action": "STREAM_DELETED",
            "provenance": "LIVE_ONCHAIN",
            "propertyId": property_id,
            "receiver": valid_receiver,
            "txHash": live_result["txHash"],
            "basescanUrl": live_result["basescanUrl"],
            "network": live_result["network"],
            "idempotent": False,
        }

    # Truthful SIMULATED path
    stream["status"] = "CLOSED"
    stream["flowRate"] = 0
    stream["closedAt"] = int(time.time())
    stream["txHash"] = None
    stream["basescanUrl"] = None
    stream["provenance"] = "SIMULATED"
    stream["network"] = "Base Sepolia (Simulated)"
    _sync_stream_to_platform(stream)

    return {
        "success": True,
        "status": "SIMULATED",
        "action": "STREAM_DELETED",
        "provenance": "SIMULATED",
        "propertyId": property_id,
        "receiver": valid_receiver,
        "txHash": None,
        "basescanUrl": None,
        "network": "Base Sepolia (Simulated)",
        "simulationReason": live_reason or "Live execution credentials not provided.",
        "idempotent": False,
    }


@mcp.tool()
def get_active_streams(property_id: str) -> dict[str, Any]:
    """List all currently active Superfluid yield streams for a property.

    Args:
        property_id: Unique property identifier.
    """
    prop_id = str(property_id).strip()
    matches = [
        s for s in _active_streams.values()
        if s.get("propertyId") == prop_id and s.get("status") == "ACTIVE"
    ]
    total_outflow = sum(s.get("flowRate", 0) for s in matches)

    return {
        "success": True,
        "propertyId": prop_id,
        "activeCount": len(matches),
        "totalFlowRate": total_outflow,
        "streams": matches,
    }


@mcp.tool()
def get_stream_balance(token_address: str, receiver: str) -> dict[str, Any]:
    """Query the real-time continuous streaming balance and active flow rate for an investor.

    Args:
        token_address: Super Token address on Base Sepolia.
        receiver: Investor's wallet address.
    """
    valid_receiver = validate_address(receiver, "receiver")
    receiver_clean = valid_receiver.lower()
    token = validate_address(token_address or DEFAULT_FUSDCX_ADDRESS, "token_address")

    now = int(time.time())

    # Find matching streams for this receiver
    active_flows = [
        s for s in _active_streams.values()
        if s.get("receiver", "").lower() == receiver_clean and s.get("status") == "ACTIVE"
    ]

    total_flow_rate = sum(f.get("flowRate", 0) for f in active_flows)

    accumulated = 0.0
    for f in active_flows:
        elapsed = now - f.get("startedAt", now)
        accumulated += (f.get("flowRate", 0) * max(0, elapsed)) / 1e18

    return {
        "success": True,
        "receiver": valid_receiver,
        "token": token,
        "flowRate": total_flow_rate,
        "activeStreamCount": len(active_flows),
        "currentBalance": round(accumulated, 6),
        "timestamp": now,
    }


if __name__ == "__main__":
    mcp.run()
