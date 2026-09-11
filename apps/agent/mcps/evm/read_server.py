"""Read-only Sepolia EVM tokenization MCP server for Hermes.

Exposes only the tools that cannot mutate token state, holder compliance status, or
on-chain balances: storefront bookkeeping lookups (GET-only REST calls). There is no
tool here that can deploy, transfer, reclaim, pause, whitelist, or revoke — see
write_server.py for those. On-chain analytics (top holders, transfers, supply) for
Sepolia come from the separate subgraph MCP, not this one.

This is the MCP registered for any agent profile that should be able to answer questions
about a token but must never be able to act on it (see server.py:write_config_yaml's
`pr` profile).

Registered in `config.yaml`'s `mcp_servers.evm_read` block.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from common import TokenizationApiError, call

mcp = FastMCP("evm_read")


@mcp.prompt()
def token_deployment_interview() -> str:
    """Return the mandatory questions for a Sepolia ERC-20 deployment.

    deploy_token itself lives in the write server — this prompt is kept here purely as
    reference guidance and returns static text; it cannot deploy anything on its own.
    """
    return """Before deploying an irreversible ERC-20 contract on Sepolia, ask and confirm:
1. Name, ticker, decimals, initial supply and finite maximum or infinite supply.
2. RWA category and optional memo.
3. Should every holder complete World ID Selfie Check?
4. If yes, is it one-time or recurring? For recurring checks ask the exact
   interval, convert it to seconds (minimum 60; 300 is five minutes), and
   explain that expiry returns the holder balance to treasury.
5. Optional exact minimum age and supported nationality.
6. Independent freeze, recovery and pause controls.
Summarize every setting and obtain final confirmation before deploy_token.
Sepolia V1 supports fungible ERC-20 tokens; HTS custom fees and NFTs are not available."""


@mcp.tool()
def list_tokens() -> dict[str, Any]:
    """List ERC-20 tokens deployed by this platform on Sepolia."""
    return call("GET", "/api/evm/tokens")


@mcp.tool()
def get_token(contract_address: str) -> dict[str, Any]:
    """Read a Sepolia token, holders, requests and event log by contract address."""
    return call("GET", f"/api/tokens/{contract_address}")


@mcp.tool()
def get_token_request(request_id: int) -> dict[str, Any]:
    """Read the durable one-token holder request. Read-only — fulfilling or
    rejecting it requires the write server."""
    return call("GET", f"/api/token-requests/{request_id}")


@mcp.tool()
def list_token_requests(status: str = "PENDING") -> dict[str, Any]:
    """List durable requests. Results can include both chains; keep only rows whose
    token record is an EVM/Sepolia contract when acting through this MCP."""
    normalized = status.strip().upper()
    if normalized and normalized not in {"PENDING", "PROCESSING", "FULFILLED", "REJECTED"}:
        raise TokenizationApiError("Invalid request status.")
    suffix = f"?status={normalized}" if normalized else ""
    return call("GET", f"/api/token-requests{suffix}")


if __name__ == "__main__":
    mcp.run(transport="stdio")
