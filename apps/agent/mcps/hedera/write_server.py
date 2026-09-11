"""Write (state-mutating) Hedera tokenization MCP server for Hermes.

Thin stdio MCP server exposing the operator-facing Hedera Token Service (HTS)
operations that the `apps/platform` Next.js app already implements. Every tool here is a
single HTTP call to that app's REST API on container loopback (TOKENIZATION_BASE_URL,
default http://127.0.0.1:3000) — it performs no Hedera SDK calls itself and never sees
the operator private key. The Next.js app (`src/lib/hedera/tokenService.ts`) stays the
single source of truth: it owns the operator key, the SQLite bookkeeping DB, and the
on-chain event log.

This server is deliberately kept separate from read_server.py: it is the only place that
can deploy, mint, transfer, reclaim, pause, whitelist, or revoke. Only the
operator/default agent profile should ever have this MCP registered — never the
read-only `pr` profile (see server.py:write_config_yaml).

Registered in `config.yaml`'s `mcp_servers.hedera_write` block. Hermes launches this as a
subprocess, performs the MCP handshake, and these tools then appear in the agent's native
tool list alongside its built-in tools.

Gotchas baked into the tool docstrings below because they've bitten people before:
  - Amounts are in HTS *base units*, not decimal-adjusted display units.
  - `deploy_token` for an NFT collection always starts at supply 0 — per-serial
    minting isn't implemented in the platform yet.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from common import BASE_URL, WORLD_ID_NATIONALITIES, TokenizationApiError, call

mcp = FastMCP("hedera_write")


@mcp.tool()
def fulfill_token_request(request_id: int) -> dict[str, Any]:
    """Atomically fulfill a stored pending request from treasury. The server
    re-validates token type, pause state, wallet association and configured
    compliance/liveness gates. If the treasury balance is too low and the
    token has a supply key, it mints only the exact shortfall before sending
    exactly one display token. Calling this twice cannot create a second mint
    or transfer.

    Args:
        request_id: Integer request id. No destination or amount is accepted.
    """
    return call("POST", f"/api/token-requests/{request_id}/fulfill")


@mcp.tool()
def reject_token_request(request_id: int, reason: str) -> dict[str, Any]:
    """Reject a pending request after a definitive compliance failure. Do not
    reject transient API, network, provider, or Hedera errors; leave those
    pending for retry.

    Args:
        request_id: Integer request id.
        reason: Concise holder-facing reason, maximum 500 characters.
    """
    return call("POST", f"/api/token-requests/{request_id}/reject", json={"reason": reason})


@mcp.tool()
def process_liveness_expirations() -> dict[str, Any]:
    """Run the deterministic recurring-liveness expiry sweep immediately.
    This is useful for a minute-scale demo; production deployments also run
    the same sweep automatically in the background. The backend chooses every
    expired holder, live balance, and treasury destination from trusted state,
    so this tool accepts no financial parameters.
    """
    return call("POST", "/api/liveness/process")


@mcp.tool()
def deploy_token(
    name: str,
    symbol: str,
    token_type: str = "FUNGIBLE",
    decimals: int = 0,
    initial_supply: int = 0,
    supply_type: str = "INFINITE",
    max_supply: int | None = None,
    asset_category: str = "other",
    memo: str | None = None,
    kyc_required: bool = False,
    freeze_default: bool = False,
    wipe_enabled: bool = False,
    pause_enabled: bool = False,
    selfie_check: bool = False,
    minimum_age: int | None = None,
    nationality: str | None = None,
    liveness_enabled: bool = False,
    liveness_period_seconds: int | None = None,
) -> dict[str, Any]:
    """Deploy (create) a new HTS token. The operator account becomes the
    treasury and holds every admin-style key this call turns on. There is no
    public "create token" UI by design — this is the only way a new token gets
    listed on the storefront, so always confirm the token name with the
    operator before calling this.

    Args:
        name: Display name, 1-100 chars.
        symbol: Ticker symbol, 1-20 chars.
        token_type: "FUNGIBLE" or "NFT". NFT collections are created at supply
            0 — per-serial minting is not yet implemented on this platform, so
            don't promise minted NFTs after this call.
        decimals: Ignored (forced to 0) for NFT.
        initial_supply: In base units. Ignored (forced to 0) for NFT.
        supply_type: "FINITE" or "INFINITE". "FINITE" requires max_supply.
        max_supply: Required when supply_type is "FINITE", in base units.
        asset_category: One of "securities", "real-estate", "invoices",
            "carbon-credits", "commodities", "other".
        memo: Optional on-chain memo, max 100 chars.
        kyc_required: Set a KYC key; holders must be KYC-granted before
            receiving tokens. Automatically enabled when any World ID check
            is selected, so the operator does not need to choose an HTS gate.
        freeze_default: Set a freeze key with freeze-by-default; holders start
            frozen until explicitly unfrozen (via whitelist_holder).
        wipe_enabled: Set a wipe key, enabling reclaim_now to claw back tokens
            directly.
        pause_enabled: Set a pause key, enabling pause_token.
        selfie_check: Require World ID Selfie Check before whitelisting.
        minimum_age: Optional World ID Identity Check minimum age, from 1 to
            120. Use None when no age restriction is wanted.
        nationality: Optional World ID Identity Check nationality as an ISO
            3166-1 alpha-3 code. Supported values: ARG, AUS, CHL, COL, CRI,
            GBR, HRV, ITA, JPN, KOR, MEX, MYS, PAN, PRT, SGP, USA. Use None
            when no nationality restriction is wanted.
        liveness_enabled: Require holders to repeat World ID Selfie Check and
            automatically return their balance to treasury if they go stale.
            Requires selfie_check and liveness_period_seconds.
        liveness_period_seconds: Re-check period in seconds, minimum 60.
            Minute-scale values are supported for demos (for example 300 is
            five minutes). Policies up to 60 days also receive an on-chain
            Hedera scheduled-transfer safety net; longer policies use the
            deterministic background expiry worker.
    """
    if supply_type == "FINITE" and not max_supply:
        raise TokenizationApiError("max_supply is required when supply_type is FINITE.")
    normalized_nationality = nationality.strip().upper() if nationality else None
    if minimum_age is not None and not 1 <= minimum_age <= 120:
        raise TokenizationApiError("minimum_age must be between 1 and 120.")
    if normalized_nationality and normalized_nationality not in WORLD_ID_NATIONALITIES:
        raise TokenizationApiError(
            f"Unsupported World ID nationality code: {normalized_nationality}."
        )
    world_id_required = bool(selfie_check or minimum_age is not None or normalized_nationality)
    # World ID decisions need a native HTS gate. KYC is the deterministic default: the
    # server grants it only after verification. Freeze remains a separate optional control.
    if world_id_required:
        kyc_required = True
    if liveness_enabled and not selfie_check:
        raise TokenizationApiError(
            "Recurring liveness requires selfie_check=true."
        )
    if liveness_enabled and token_type.upper() != "FUNGIBLE":
        raise TokenizationApiError(
            "Recurring liveness currently supports FUNGIBLE tokens only."
        )
    if liveness_enabled and liveness_period_seconds is None:
        raise TokenizationApiError(
            "liveness_period_seconds is required when liveness_enabled is true."
        )
    if liveness_enabled and liveness_period_seconds < 60:
        raise TokenizationApiError(
            "liveness_period_seconds must be at least 60 (one minute)."
        )

    body: dict[str, Any] = {
        "name": name,
        "symbol": symbol,
        "tokenType": token_type,
        "decimals": decimals,
        "initialSupply": initial_supply,
        "supplyType": supply_type,
        "assetCategory": asset_category,
        "compliance": {
            "kycRequired": kyc_required,
            "freezeDefault": freeze_default,
            "wipeEnabled": wipe_enabled,
            "pauseEnabled": pause_enabled,
            "worldIdRequired": world_id_required,
            "worldIdSelfieCheck": selfie_check,
            **({"worldIdMinimumAge": minimum_age} if minimum_age is not None else {}),
            **({"worldIdNationality": normalized_nationality} if normalized_nationality else {}),
            "livenessEnabled": liveness_enabled,
            **({"livenessPeriodSeconds": liveness_period_seconds} if liveness_period_seconds else {}),
        },
    }
    if max_supply is not None:
        body["maxSupply"] = max_supply
    if memo:
        body["memo"] = memo

    return call("POST", "/api/tokens", json=body)


@mcp.tool()
def whitelist_holder(token_id: str, account_id: str) -> dict[str, Any]:
    """Approve a registered holder: grants KYC and/or unfreezes their account
    (whichever the token's compliance settings require) and marks them
    WHITELISTED, so they can receive a distribution. The holder must have
    already registered and associated the token on their end.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        account_id: Holder's Hedera account id, e.g. "0.0.654321".
    """
    return call("POST", f"/api/tokens/{token_id}/holders/{account_id}/whitelist")


@mcp.tool()
def revoke_holder(token_id: str, account_id: str) -> dict[str, Any]:
    """Revoke a holder's compliance status: revokes KYC and/or re-freezes their
    account and cancels any scheduled auto-reclaim, marking them REVOKED. Does
    not move their existing token balance — use reclaim_now for that.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        account_id: Holder's Hedera account id, e.g. "0.0.654321".
    """
    return call("POST", f"/api/tokens/{token_id}/holders/{account_id}/revoke")


@mcp.tool()
def distribute(token_id: str, account_id: str, amount: float) -> dict[str, Any]:
    """Transfer tokens from the treasury to a whitelisted holder. The holder
    must already be marked WHITELISTED (via whitelist_holder) — Hedera will
    still reject the transfer on-chain if they aren't actually compliant even
    if our bookkeeping says otherwise.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        account_id: Recipient's Hedera account id, e.g. "0.0.654321".
        amount: Amount in the token's base units (NOT decimal-adjusted display
            units) — for a token with decimals=2, "100" is 1.00 of the token.
    """
    return call("POST", f"/api/tokens/{token_id}/transfer", json={"accountId": account_id, "amount": amount})


@mcp.tool()
def reclaim_now(token_id: str, account_id: str) -> dict[str, Any]:
    """Immediately claw back a holder's entire current balance back to the
    treasury (compliance reclaim) — uses the wipe key if the token has one,
    otherwise a pre-granted allowance. Cancels any pending scheduled reclaim.

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        account_id: Holder's Hedera account id, e.g. "0.0.654321".
    """
    return call("POST", f"/api/tokens/{token_id}/holders/{account_id}/reclaim-now")


@mcp.tool()
def pause_token(token_id: str, paused: bool = True) -> dict[str, Any]:
    """Pause or unpause a token. While paused, no transfers of this token can
    happen for anyone (requires the token to have been created with
    pause_enabled).

    Args:
        token_id: Hedera token id, e.g. "0.0.123456".
        paused: True to pause, False to unpause.
    """
    return call("POST", f"/api/tokens/{token_id}/pause", json={"paused": paused})


def _selftest() -> None:
    """Bypass MCP transport and call a tool function directly — useful to
    smoke-test the HTTP wiring against a locally running tokenization app
    without needing an MCP client. Run: python mcps/hedera/write_server.py --selftest

    Deliberately only exercises list-shaped/no-op-safe behavior indirectly via
    read_server.py's selftest; this one just confirms the process boots and can
    reach the tokenization API, without mutating anything.
    """
    import json

    print(f"Calling reject_token_request with an out-of-range id to confirm connectivity "
          f"(expected: a clean TokenizationApiError, not a network error) against {BASE_URL} ...")
    try:
        reject_token_request(request_id=-1, reason="selftest connectivity probe")
    except TokenizationApiError as exc:
        print(f"Got expected API error: {exc}")
    else:
        print(json.dumps({"warning": "request -1 unexpectedly succeeded"}, indent=2))


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        _selftest()
    else:
        mcp.run()
