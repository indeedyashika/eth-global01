import { NextRequest, NextResponse } from "next/server";
import { getHolder, getToken, listHolders } from "@/lib/db/repo";
import { getSessionById } from "@/lib/hermes/sessionPolicy";

type ClaimResponse = {
  success: false;
  claimStatus: "FAILED";
  error: string;
  code: string;
  txId: null;
  hashscanUrl: null;
  amountClaimed: "0";
};

declare global {
  var __yieldClaimIdempotency: Map<string, ClaimResponse> | undefined;
}

function idempotencyStore(): Map<string, ClaimResponse> {
  if (!globalThis.__yieldClaimIdempotency) globalThis.__yieldClaimIdempotency = new Map();
  return globalThis.__yieldClaimIdempotency;
}

function failure(error: string, code: string): ClaimResponse {
  return {
    success: false,
    claimStatus: "FAILED",
    error,
    code,
    txId: null,
    hashscanUrl: null,
    amountClaimed: "0",
  };
}

/** Fail closed: the UI counter is not an authoritative withdrawable balance. */
export async function POST(req: NextRequest) {
  let body: { sessionId?: unknown; tokenId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(failure("Request body must be valid JSON.", "INVALID_BODY"), { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const tokenId = typeof body.tokenId === "string" ? body.tokenId : "";
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || "";
  if (!sessionId) return NextResponse.json(failure("Authentication required.", "AUTH_REQUIRED"), { status: 401 });
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return NextResponse.json(failure("A valid Idempotency-Key header is required.", "IDEMPOTENCY_REQUIRED"), { status: 400 });
  }

  const session = getSessionById(sessionId);
  if (
    !session ||
    session.status !== "ACTIVE" ||
    session.validAfter > Date.now() ||
    session.validUntil <= Date.now() ||
    (session.expiresAt && session.expiresAt <= Date.now())
  ) {
    return NextResponse.json(failure("Authentication required: session is invalid or expired.", "AUTH_REQUIRED"), { status: 401 });
  }
  const replayKey = `${session.sessionId}:${idempotencyKey}`;
  const replay = idempotencyStore().get(replayKey);
  if (replay) return NextResponse.json(replay, { status: 503, headers: { "Idempotency-Replayed": "true" } });

  if (!tokenId) return NextResponse.json(failure("A token selection is required.", "TOKEN_REQUIRED"), { status: 400 });
  const token = getToken(tokenId);
  if (!token || token.assetCategory !== "real-estate" || token.tokenType !== "FUNGIBLE") {
    return NextResponse.json(failure("Property token is not eligible for yield claims.", "INVALID_PROPERTY"), { status: 404 });
  }
  if (token.paused) return NextResponse.json(failure("Property token is paused.", "TOKEN_PAUSED"), { status: 403 });

  // The session grantor is the sole server-derived investor identity.
  const investor = session.grantor.toLowerCase();
  const holder = listHolders(token.id).find(
    (candidate) =>
      candidate.accountId.toLowerCase() === investor || candidate.evmAddress?.toLowerCase() === investor
  );
  if (!holder || !getHolder(token.id, holder.accountId)) {
    return NextResponse.json(failure("Authenticated investor does not own this property token.", "NOT_OWNER"), { status: 403 });
  }
  if (
    holder.status !== "WHITELISTED" ||
    !holder.associated ||
    !holder.kycGranted ||
    holder.frozen ||
    holder.livenessState === "EXPIRED"
  ) {
    return NextResponse.json(failure("Investor is not compliant to receive yield.", "COMPLIANCE_REQUIRED"), { status: 403 });
  }

  const { getWorkflowState, recordStep3YieldClaim } = await import("@/lib/workflow/judgeWorkflow");
  if (tokenId === "prop_456_oak_ave" || tokenId === "OAK-RWA") {
    const workflow = getWorkflowState();
    if (workflow.step2.status !== "SUCCESS") {
      const step2Err = failure(
        "Step 2 $5,000 Rent Deposit must be confirmed before claiming yield.",
        "STEP2_RENT_REQUIRED"
      );
      idempotencyStore().set(replayKey, step2Err);
      return NextResponse.json(step2Err, { status: 400 });
    }
  }

  // Fail-closed: real execution requires configured Base Sepolia fUSDCx transfer signer
  const result = failure(
    "Yield settlement is unavailable: no configured live fUSDCx transfer signer on Base Sepolia. No funds were transferred.",
    "LIVE_SETTLEMENT_UNAVAILABLE"
  );
  idempotencyStore().set(replayKey, result);

  try {
    recordStep3YieldClaim({
      claimTxId: "",
      claimAmount: 0,
      success: false,
      error: result.error,
    });
  } catch (e) {
    console.warn("[yield claim] could not update workflow state:", e);
  }

  return NextResponse.json(result, { status: 503 });
}
