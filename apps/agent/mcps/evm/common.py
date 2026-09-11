"""Shared plumbing for the split Sepolia EVM MCP servers (read_server.py / write_server.py).

Both servers are thin, keyless stdio adapters. The Next.js platform owns the Sepolia
operator key, contract ABI, SQLite state and World ID policy; MCP tools only call its
agent-safe HTTP API on container loopback (TOKENIZATION_BASE_URL, default
http://127.0.0.1:3000).

This module holds no `@mcp.tool()` definitions of its own — it exists so the read and
write servers can share the HTTP plumbing without duplicating it, while each still ends
up as its own independent `FastMCP` process with its own tool list.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

BASE_URL = os.environ.get("TOKENIZATION_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
AGENT_SECRET = os.environ.get("TOKENIZATION_AGENT_SECRET", "")
WORLD_ID_NATIONALITIES = {
    "ARG", "AUS", "CHL", "COL", "CRI", "GBR", "HRV", "ITA",
    "JPN", "KOR", "MEX", "MYS", "PAN", "PRT", "SGP", "USA",
}


class TokenizationApiError(RuntimeError):
    pass


def call(method: str, path: str, json: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {"X-Tokenization-Agent-Secret": AGENT_SECRET} if AGENT_SECRET else {}
    try:
        response = httpx.request(
            method, f"{BASE_URL}{path}", json=json, headers=headers, timeout=120.0
        )
    except httpx.HTTPError as exc:
        raise TokenizationApiError(f"Could not reach the tokenization API: {exc}") from exc
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.is_error:
        message = body.get("error") if isinstance(body, dict) else None
        raise TokenizationApiError(message or f"{method} {path} failed ({response.status_code})")
    return body
