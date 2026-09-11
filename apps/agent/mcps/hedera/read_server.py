"""Read-only Hedera tokenization MCP server for Hermes.

Exposes only the tools that cannot mutate token state, holder compliance status, or
on-chain balances: storefront bookkeeping lookups (GET-only REST calls) and public
Hedera Mirror Node reads. There is no tool here that can mint, transfer, reclaim, pause,
whitelist, or revoke — see write_server.py for those.

This is the MCP registered for any agent profile that should be able to answer questions
about a token but must never be able to act on it (see server.py:write_config_yaml's
`pr` profile). It shares its HTTP/Mirror Node plumbing with write_server.py via common.py
but is otherwise an independent stdio process with its own tool list — nothing here can
reach a mutating endpoint, regardless of prompt content.

Registered in `config.yaml`'s `mcp_servers.hedera_read` block (see
server.py:write_config_yaml). Hermes launches this as a subprocess, performs the MCP
handshake, and these tools then appear in the agent's native tool list alongside its
built-in tools.

Gotcha baked into the tool docstrings below because it's bitten people before: amounts
are in HTS *base units*, not decimal-adjusted display units.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from common import TokenizationApiError, call, mirror_base_url, mirror_get

mcp = FastMCP("hedera_read")


@mcp.prompt()
def token_deployment_interview() -> str:
    """Return the mandatory operator questions to ask before deploy_token.

    deploy_token itself lives in the write server — this prompt is kept here purely as
    reference guidance for whichever agent is about to hand off to an operator/write
    session; it returns static text and cannot deploy anything on its own.
    """
    return """Before deploying an irreversible HTS token, ask and confirm:
1. Token name.
2. Fungible token or NFT, ticker, decimals, supply type and initial/max supply.
3. RWA category.
4. Should every holder complete World ID Selfie Check?
5. If yes, is Selfie Check one-time or recurring? If recurring, ask the exact
   interval and unit, convert it to seconds (minimum 60; 300 is five minutes),
   and explain that an expired holder's balance returns to treasury.
6. Is there a minimum-age requirement? Ask the exact age or record none.
7. Is there a nationality restriction? Ask the exact supported country or
   record none.
8. Ask any independent freeze, wipe, pause, fee, or memo choices.
Summarize every value and obtain final confirmation before deploy_token.
Recurring liveness requires a fungible token and Selfie Check."""


@mcp.tool()
def list_tokens() -> dict[str, Any]:
    """List every token deployed so far on this storefront (id, name, symbol,
    type, supply, treasury, compliance settings). Use this to check live data
    before answering questions about what tokens exist — never guess."""
    return call("GET", "/api/tokens")


@mcp.tool()
def get_token(token_id: str) -> dict[str, Any]:
    """Get full detail for one token: its record, every registered holder
    (association/KYC/whitelist/frozen status), and its on-chain event log.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
    """
    return call("GET", f"/api/tokens/{token_id}")


@mcp.tool()
def list_token_requests(status: str = "PENDING") -> dict[str, Any]:
    """List durable holder token requests, normally the pending queue. Read-only
    lookup — use get_token_request for the exact id from a webhook prompt.

    Args:
        status: PENDING, PROCESSING, FULFILLED, or REJECTED. Pass an empty
            string only when asked for every request.
    """
    normalized = status.strip().upper()
    if normalized and normalized not in {"PENDING", "PROCESSING", "FULFILLED", "REJECTED"}:
        raise TokenizationApiError("Invalid request status.")
    suffix = f"?status={normalized}" if normalized else ""
    return call("GET", f"/api/token-requests{suffix}")


@mcp.tool()
def get_token_request(request_id: int) -> dict[str, Any]:
    """Read one durable request. Read-only — fulfilling or rejecting it requires
    the write server.

    Args:
        request_id: Integer request id supplied by the webhook or queue.
    """
    return call("GET", f"/api/token-requests/{request_id}")


@mcp.tool()
def get_onchain_token_info(token_id: str) -> dict[str, Any]:
    """Read a token's LIVE on-chain state from the Hedera Mirror Node — the ground
    truth from consensus, as opposed to this storefront's own bookkeeping record
    (use get_token for the latter). Prefer this when someone asks about the real
    current supply, treasury, or on-chain configuration of a token we launched.

    Returns the Mirror Node token entity: total_supply and max_supply (in base
    units, NOT decimal-adjusted), decimals, type (FUNGIBLE_COMMON / NON_FUNGIBLE_
    UNIQUE), supply_type, treasury_account_id, pause_status, deleted, custom_fees,
    and which keys are set (admin/kyc/freeze/wipe/supply/pause) — a set key is a
    non-null object, a null key means that capability was not enabled at creation.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
    """
    return mirror_get(f"/api/v1/tokens/{token_id}")


@mcp.tool()
def get_top_holders(token_id: str, limit: int = 10) -> dict[str, Any]:
    """List the accounts holding the largest current balances of a token, newest
    consensus snapshot first-ranked by balance — i.e. the token's supply
    distribution across the network, from the Hedera Mirror Node. The treasury
    account is normally the #1 holder (it holds all undistributed supply).

    Balances are in the token's base units (NOT decimal-adjusted); the response
    includes each entry's decimals so you can convert to display units.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        limit: Number of holders to return, 1-100 (default 10).
    """
    limit = max(1, min(limit, 100))
    return mirror_get(
        f"/api/v1/tokens/{token_id}/balances",
        params={"order": "desc", "limit": limit},
    )


@mcp.tool()
def get_holder_balance(account_id: str, token_id: str) -> dict[str, Any]:
    """Get one account's LIVE on-chain balance and HTS compliance flags for a
    single token, from the Hedera Mirror Node. Complements the storefront's own
    holder record (get_token lists registered holders) with consensus truth.

    Returns the account's token relationship — balance (base units, NOT
    decimal-adjusted), freeze_status, and kyc_status — or a clear "not associated"
    result when the account has never associated this token (so its effective
    balance is zero).

    Args:
        account_id: Holder's Hedera account id, e.g. "0.0.654321".
        token_id: Hedera token id, e.g. "0.0.123456".
    """
    body = mirror_get(
        f"/api/v1/accounts/{account_id}/tokens",
        params={"token.id": token_id, "limit": 1},
    )
    tokens = body.get("tokens") if isinstance(body, dict) else None
    if isinstance(tokens, list) and tokens:
        return {"accountId": account_id, "tokenId": token_id, "relationship": tokens[0]}
    return {
        "accountId": account_id,
        "tokenId": token_id,
        "relationship": None,
        "note": "Account has not associated this token on the network; effective balance is 0.",
    }


@mcp.tool()
def get_recent_token_transfers(token_id: str, limit: int = 20) -> dict[str, Any]:
    """List the most recent on-chain transfers of a token we launched, newest
    first, from the Hedera Mirror Node. Use this to answer "what recently happened
    with this token" — distributions, reclaims, and mints all flow through the
    treasury, and this surfaces exactly those movements.

    The Mirror Node transactions endpoint can't filter by token, so this queries
    the token's treasury account's CRYPTOTRANSFER transactions and keeps only the
    transfer legs for this token. That covers every treasury-involved movement
    (the vast majority for a storefront token); peer-to-peer transfers between two
    non-treasury holders would not appear. Amounts are base units (positive =
    credit to the account, negative = debit); a treasury debit with a holder
    credit is a distribution, the reverse is a reclaim.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        limit: Max number of matching transactions to return, 1-100 (default 20).
    """
    limit = max(1, min(limit, 100))
    info = mirror_get(f"/api/v1/tokens/{token_id}")
    treasury = info.get("treasury_account_id")
    if not treasury:
        raise TokenizationApiError(
            f"Could not determine the treasury account for token {token_id} from the Mirror Node."
        )

    # Over-fetch before filtering: not every treasury CRYPTOTRANSFER touches this
    # exact token (the treasury/operator is party to many tokens' transfers).
    body = mirror_get(
        "/api/v1/transactions",
        params={
            "account.id": treasury,
            "transactiontype": "CRYPTOTRANSFER",
            "order": "desc",
            "limit": min(limit * 5, 100),
        },
    )
    transactions = body.get("transactions") if isinstance(body, dict) else None
    matches: list[dict[str, Any]] = []
    for tx in transactions or []:
        legs = [
            {"account": t.get("account"), "amount": t.get("amount")}
            for t in (tx.get("token_transfers") or [])
            if t.get("token_id") == token_id
        ]
        if legs:
            matches.append(
                {
                    "consensus_timestamp": tx.get("consensus_timestamp"),
                    "transaction_id": tx.get("transaction_id"),
                    "result": tx.get("result"),
                    "transfers": legs,
                }
            )
        if len(matches) >= limit:
            break

    return {"tokenId": token_id, "treasuryAccountId": treasury, "transfers": matches}


def _selftest() -> None:
    """Bypass MCP transport and call a tool function directly — useful to
    smoke-test the HTTP wiring against a locally running tokenization app
    without needing an MCP client. Run: python mcps/hedera/read_server.py --selftest
    """
    import json

    print(f"Calling list_tokens() against against tokenization app ...")
    result = list_tokens()
    print(json.dumps(result, indent=2))

    print(f"\nResolved Mirror Node base URL: {mirror_base_url()}")
    tokens = result.get("tokens") if isinstance(result, dict) else None
    if tokens:
        token_id = tokens[0].get("id")
        print(f"\nCalling get_onchain_token_info({token_id!r}) ...")
        print(json.dumps(get_onchain_token_info(token_id), indent=2))
        print(f"\nCalling get_top_holders({token_id!r}) ...")
        print(json.dumps(get_top_holders(token_id), indent=2))
        print(f"\nCalling get_recent_token_transfers({token_id!r}) ...")
        print(json.dumps(get_recent_token_transfers(token_id), indent=2))
    else:
        print("\nNo deployed tokens found — skipping Mirror Node tool smoke test.")


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        _selftest()
    else:
        mcp.run()
