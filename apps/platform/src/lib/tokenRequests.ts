import { ApiError } from "@/lib/api/helpers";
import { ReceiptStatusError } from "@hiero-ledger/sdk";
import {
  claimTokenRequest,
  getHolder,
  getToken,
  getTokenRequest,
  insertEvent,
  rejectPendingTokenRequest,
  updateTokenRequest,
} from "@/lib/db/repo";
import {
  getTokenBalanceBaseUnits,
  mintFungible,
  transferFromTreasury,
} from "@/lib/hedera/tokenService";
import type { HolderRecord, TokenRecord, TokenRequestRecord } from "@/types";
import { hasRequiredWorldIdVerification } from "@/lib/worldid/policy";
import { armLivenessReclaim } from "@/lib/liveness";
import {
  getEvmTokenBalance,
  mintEvmToken,
  transferEvmFromTreasury,
} from "@/lib/evm/client";

export function oneDisplayTokenInBaseUnits(decimals: number): string {
  return (BigInt(10) ** BigInt(decimals)).toString();
}

function eligibilityProblem(token: TokenRecord, holder: HolderRecord | null): string | null {
  if (token.tokenType !== "FUNGIBLE") return "Token requests currently support fungible tokens only.";
  if (token.paused) return "The token is paused.";
  if (!holder) return "The holder has not joined this token.";
  if (!holder.associated) return "The holder has not associated this token with their account.";
  if (holder.status === "REVOKED") return "The holder has been revoked.";

  const hasWhitelistGate =
    token.compliance.kycRequired ||
    token.compliance.freezeDefault ||
    token.compliance.worldIdRequired;
  if (hasWhitelistGate && holder.status !== "WHITELISTED") {
    return "The holder has not passed the token's compliance review.";
  }
  if (!hasRequiredWorldIdVerification(token, holder)) {
    return "World ID verification is required.";
  }
  if (token.compliance.livenessEnabled) {
    if (!holder.allowanceGranted) return "The required liveness allowance has not been granted.";
    if (holder.livenessState === "EXPIRED") return "The holder's liveness check-in has expired.";
  }
  return null;
}

/** The amount and destination come exclusively from the stored request. The MCP tool accepts
 *  only the request id, so an LLM cannot alter either value. */
export async function fulfillStoredTokenRequest(requestId: number): Promise<TokenRequestRecord> {
  const request = getTokenRequest(requestId);
  if (!request) throw new ApiError(`Token request ${requestId} not found`, 404);
  if (request.status === "FULFILLED") return request;
  if (request.status === "REJECTED") throw new ApiError("This request has already been rejected.", 409);
  if (request.status === "PROCESSING") {
    throw new ApiError("This request is already being processed.", 409);
  }

  const token = getToken(request.tokenId);
  if (!token) throw new ApiError(`Token ${request.tokenId} not found`, 404);
  const holder = getHolder(request.tokenId, request.accountId);
  const problem = eligibilityProblem(token, holder);
  if (problem) throw new ApiError(problem, 409);

  const expectedAmount = oneDisplayTokenInBaseUnits(token.decimals);
  if (request.amountBaseUnits !== expectedAmount) {
    throw new ApiError("The stored request amount is invalid.", 409);
  }

  const claimed = claimTokenRequest(requestId);
  if (!claimed) throw new ApiError("This request was claimed by another Hermes run.", 409);

  const requestedAmount = BigInt(claimed.amountBaseUnits);
  let treasuryBalance: bigint;
  try {
    treasuryBalance = token.blockchain === "EVM"
      ? await getEvmTokenBalance(claimed.tokenId, token.treasuryAccountId)
      : await getTokenBalanceBaseUnits(claimed.tokenId, token.treasuryAccountId);
  } catch (error) {
    // Balance queries are read-only, so a failed query is always safe to retry.
    const message = error instanceof Error ? error.message : "Unknown Hedera balance query error";
    updateTokenRequest(requestId, { status: "PENDING", processingError: message });
    throw error;
  }

  if (treasuryBalance < requestedAmount) {
    if (!token.keys.supply) {
      const message = "The treasury does not have enough tokens and this token has no supply key.";
      updateTokenRequest(requestId, { status: "PENDING", processingError: message });
      throw new ApiError(message, 409);
    }

    const mintAmount = requestedAmount - treasuryBalance;
    let mintResult;
    try {
      mintResult = token.blockchain === "EVM"
        ? await mintEvmToken(claimed.tokenId, mintAmount)
        : await mintFungible(claimed.tokenId, mintAmount);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Hedera mint error";
      if (error instanceof ReceiptStatusError) {
        // A failed consensus receipt proves the mint did not happen, so retrying is safe.
        updateTokenRequest(requestId, { status: "PENDING", processingError: message });
      } else {
        // A transport failure after submission is ambiguous. Keep the request reserved so a
        // retry cannot accidentally mint the same shortfall twice.
        updateTokenRequest(requestId, { processingError: message });
      }
      throw error;
    }

    insertEvent({
      tokenId: claimed.tokenId,
      type: "TOKEN_MINTED",
      detail: {
        requestId,
        amountBaseUnits: mintAmount.toString(),
        reason: "treasury shortfall",
      },
      txId: mintResult.txId,
      hashscanUrl: mintResult.hashscanUrl,
    });
  }

  let result;
  try {
    result = token.blockchain === "EVM"
      ? await transferEvmFromTreasury(claimed.tokenId, claimed.accountId, requestedAmount)
      : await transferFromTreasury(claimed.tokenId, claimed.accountId, requestedAmount);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Hedera transfer error";
    if (error instanceof ReceiptStatusError) {
      // A non-success consensus receipt proves no transfer occurred, so retrying is safe.
      updateTokenRequest(requestId, { status: "PENDING", processingError: message });
    } else {
      // A timeout/transport failure can be ambiguous: Hedera may have accepted the transaction
      // even if the receipt never reached us. Keep it reserved rather than risk a double send.
      updateTokenRequest(requestId, { processingError: message });
    }
    throw error;
  }

  const fulfilled = updateTokenRequest(requestId, {
    status: "FULFILLED",
    fulfillmentTxId: result.txId,
    fulfillmentHashscanUrl: result.hashscanUrl,
    processingError: null,
  })!;
  insertEvent({
    tokenId: claimed.tokenId,
    accountId: claimed.accountId,
    type: "TOKEN_REQUEST_FULFILLED",
    detail: { requestId, amount: "1", amountBaseUnits: claimed.amountBaseUnits },
    txId: result.txId,
    hashscanUrl: result.hashscanUrl,
  });
  if (token.compliance.livenessEnabled) {
    // The first verified selfie happens before distribution, when there is no holder balance
    // to schedule. Arm the reclaim immediately after the token reaches the holder.
    await armLivenessReclaim(claimed.tokenId, claimed.accountId);
  }
  return fulfilled;
}

export function rejectStoredTokenRequest(requestId: number, reason: string): TokenRequestRecord {
  const existing = getTokenRequest(requestId);
  if (!existing) throw new ApiError(`Token request ${requestId} not found`, 404);
  if (existing.status === "REJECTED") return existing;
  if (existing.status !== "PENDING") {
    throw new ApiError(`Cannot reject a ${existing.status.toLowerCase()} request.`, 409);
  }

  const rejected = rejectPendingTokenRequest(requestId, reason);
  if (!rejected) throw new ApiError("This request changed while Hermes was reviewing it.", 409);
  insertEvent({
    tokenId: rejected.tokenId,
    accountId: rejected.accountId,
    type: "TOKEN_REQUEST_REJECTED",
    detail: { requestId, reason },
  });
  return rejected;
}
