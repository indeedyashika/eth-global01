"""World ID verification MCP server for the Hermes agent.

This is a deliberately thin stdio adapter over the tokenization platform's
agent-authenticated REST API. The raw IDKit proof and World configuration stay
inside the Next.js process. Hermes receives only a verification id and a
sanitized provider result, so proof bytes and secrets never enter LLM context.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlencode

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.environ.get("TOKENIZATION_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
AGENT_SECRET = os.environ.get("TOKENIZATION_AGENT_SECRET", "")

mcp = FastMCP("worldid")


class WorldIdApiError(RuntimeError):
    """Expose the platform's safe error text to Hermes without leaking proofs."""


def _call(method: str, path: str) -> dict[str, Any]:
    url = f"{BASE_URL}{path}"
    headers = {"X-Tokenization-Agent-Secret": AGENT_SECRET} if AGENT_SECRET else {}
    try:
        response = httpx.request(method, url, headers=headers, timeout=35.0)
    except httpx.HTTPError as exc:
        raise WorldIdApiError(
            f"Could not reach the tokenization API at {url}: {exc}."
        ) from exc

    try:
        body = response.json()
    except ValueError:
        body = {}

    if response.is_error:
        message = body.get("error") if isinstance(body, dict) else None
        raise WorldIdApiError(
            message or f"{method} {path} failed with HTTP {response.status_code}"
        )
    return body


@mcp.tool()
def list_pending_verifications() -> dict[str, Any]:
    """List queued World ID proofs waiting for an agent decision. Returned
    records contain metadata only; raw proof bytes are never exposed."""
    return _call("GET", "/api/worldid/verifications?status=PENDING")


@mcp.tool()
def get_holder_verifications(token_id: str, account_id: str) -> dict[str, Any]:
    """Inspect sanitized World ID attempts for one holder before deciding a
    token request. Use the newest record for each required check.

    Args:
        token_id: Hedera token id referenced by the stored token request.
        account_id: Hedera holder account id referenced by the request.
    """
    query = urlencode({"tokenId": token_id, "accountId": account_id})
    body = _call("GET", f"/api/worldid/verifications?{query}")
    latest: dict[str, Any] = {}
    for verification in body.get("verifications", []):
        check = verification.get("check")
        if check in {"selfie", "identity"}:
            latest[check] = verification
    return {**body, "latest": latest}


@mcp.tool()
def get_verification(verification_id: int) -> dict[str, Any]:
    """Read one sanitized World ID verification record by id. This never
    returns the submitted IDKit proof.

    Args:
        verification_id: Queue id returned by get_holder_verifications.
    """
    return _call("GET", f"/api/worldid/verifications/{verification_id}")


@mcp.tool()
def verify_pending_proof(verification_id: int) -> dict[str, Any]:
    """Ask the trusted platform backend to exchange one queued proof with
    World's verification API. The call is idempotent after success and records
    the provider result, nullifier hash, credential, and verification time.

    A definitive World rejection is not retryable; a transient provider or
    network failure remains retryable. Never ask a user to paste proof JSON in
    chat: only use an id returned by get_holder_verifications.

    Args:
        verification_id: Pending/failed queue id to verify with World.
    """
    return _call("POST", f"/api/worldid/verifications/{verification_id}/verify")


if __name__ == "__main__":
    mcp.run(transport="stdio")
