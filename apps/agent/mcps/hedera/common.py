"""Shared plumbing for the split Hedera MCP servers (read_server.py / write_server.py).

Both servers are thin stdio adapters: every tool is either a single HTTP call to the
`apps/platform` Next.js app's REST API on container loopback (TOKENIZATION_BASE_URL,
default http://127.0.0.1:3000) or a read against the public Hedera Mirror Node. Neither
server performs Hedera SDK calls itself or ever sees the operator private key — the
Next.js app (`src/lib/hedera/tokenService.ts`) stays the single source of truth: it owns
the operator key, the SQLite bookkeeping DB, and the on-chain event log.

This module holds no `@mcp.tool()` definitions of its own — it exists so the read and
write servers can share the HTTP/Mirror Node plumbing without duplicating it, while each
still ends up as its own independent `FastMCP` process with its own tool list.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

BASE_URL = os.environ.get("TOKENIZATION_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
AGENT_SECRET = os.environ.get("TOKENIZATION_AGENT_SECRET", "")

HEDERA_NETWORKS = {"mainnet", "testnet", "previewnet"}
# Resolved once and cached (see _mirror_base_url) — the network never changes for a
# running container, so there's no reason to re-fetch it per tool call.
_MIRROR_BASE_URL: str | None = None

WORLD_ID_NATIONALITIES = {
    "ARG", "AUS", "CHL", "COL", "CRI", "GBR", "HRV", "ITA",
    "JPN", "KOR", "MEX", "MYS", "PAN", "PRT", "SGP", "USA",
}


class TokenizationApiError(RuntimeError):
    """Raised with the tokenization app's own {error} message so the agent sees
    the same friendly text a human would get from the REST API (see
    apps/platform/src/lib/api/helpers.ts:handleRoute)."""


def call(method: str, path: str, json: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{BASE_URL}{path}"
    headers = {"X-Tokenization-Agent-Secret": AGENT_SECRET} if AGENT_SECRET else {}
    try:
        resp = httpx.request(method, url, json=json, headers=headers, timeout=30.0)
    except httpx.HTTPError as exc:
        raise TokenizationApiError(
            f"Could not reach the tokenization API at {url}: {exc}. "
            "Is the tokenization app running?"
        ) from exc

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.is_error:
        message = body.get("error") if isinstance(body, dict) else None
        raise TokenizationApiError(message or f"{method} {path} failed with HTTP {resp.status_code}")

    return body


def mirror_base_url() -> str:
    """Return the Hedera Mirror Node base URL for the active network, cached.

    The Mirror Node host is derived from the network exactly like the platform does
    (apps/platform/src/lib/hedera/mirrorNode.ts): https://{network}.mirrornode.hedera.com.
    Hermes does not inject HEDERA_NETWORK into this MCP's subprocess env today (see
    write_config_yaml in apps/agent/server.py — only the tokenization URL/secret are
    passed), so we resolve it ourselves: honor HEDERA_NETWORK if it's ever set, else
    ask the tokenization app's unauthenticated /api/runtime-config (which reports the
    same network the storefront runs on), else fall back to testnet.
    """
    global _MIRROR_BASE_URL
    if _MIRROR_BASE_URL is not None:
        return _MIRROR_BASE_URL

    network = os.environ.get("HEDERA_NETWORK", "").strip().lower()
    if network not in HEDERA_NETWORKS:
        network = ""
        try:
            resp = httpx.get(f"{BASE_URL}/api/runtime-config", timeout=10.0)
            if resp.is_success:
                candidate = str((resp.json() or {}).get("network", "")).strip().lower()
                if candidate in HEDERA_NETWORKS:
                    network = candidate
        except (httpx.HTTPError, ValueError):
            network = ""
    if not network:
        network = "testnet"

    _MIRROR_BASE_URL = f"https://{network}.mirrornode.hedera.com"
    return _MIRROR_BASE_URL


def mirror_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET a Hedera Mirror Node REST endpoint (read-only, no auth) and return JSON.

    Unlike call(), this targets the public Mirror Node — a different host and no
    agent-secret header — but raises the same TokenizationApiError on failure so the
    agent sees one consistent error style.
    """
    url = f"{mirror_base_url()}{path}"
    try:
        resp = httpx.get(url, params=params, timeout=30.0)
    except httpx.HTTPError as exc:
        raise TokenizationApiError(
            f"Could not reach the Hedera Mirror Node at {url}: {exc}."
        ) from exc

    try:
        body = resp.json()
    except ValueError:
        body = {}

    if resp.is_error:
        detail = None
        if isinstance(body, dict):
            messages = (body.get("_status") or {}).get("messages") if isinstance(body.get("_status"), dict) else None
            if isinstance(messages, list) and messages:
                detail = messages[0].get("message") if isinstance(messages[0], dict) else None
        raise TokenizationApiError(
            detail or f"Hedera Mirror Node GET {path} failed with HTTP {resp.status_code}."
        )

    return body if isinstance(body, dict) else {}
