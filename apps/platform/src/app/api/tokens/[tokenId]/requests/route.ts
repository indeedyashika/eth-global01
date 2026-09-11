import { NextResponse } from "next/server";
import { ApiError, handleRoute, readJson, requireToken } from "@/lib/api/helpers";
import {
  createOrReopenTokenRequest,
  getHolder,
  insertEvent,
  updateTokenRequest,
} from "@/lib/db/repo";
import { triggerHermesTokenRequest } from "@/lib/hermes/tokenRequestWebhook";
import { oneDisplayTokenInBaseUnits } from "@/lib/tokenRequests";
import { createTokenRequestSchema } from "@/lib/validation";
import { hasRequiredWorldIdSubmission } from "@/lib/worldid/policy";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const token = requireToken(tokenId);
    if (token.tokenType !== "FUNGIBLE") {
      throw new ApiError("Token requests currently support fungible tokens only.", 409);
    }

    const { accountId } = createTokenRequestSchema.parse(await readJson<unknown>(req));
    const holder = getHolder(tokenId, accountId);
    if (!holder) throw new ApiError("Join this token before requesting it.", 409);
    if (!holder.associated) throw new ApiError("Associate this token with your wallet first.", 409);
    if (!hasRequiredWorldIdSubmission(token, holder)) {
      throw new ApiError("Complete every required World ID check before asking Hermes to review.", 409);
    }

    const { request, started, created } = createOrReopenTokenRequest(
      tokenId,
      accountId,
      oneDisplayTokenInBaseUnits(token.decimals)
    );
    if (started) {
      insertEvent({
        tokenId,
        accountId,
        type: "TOKEN_REQUESTED",
        detail: { requestId: request.id, amount: "1", amountBaseUnits: request.amountBaseUnits },
      });
    }

    // Fulfilled/processing requests must never trigger another agent send. A rejected request
    // was reopened to PENDING above so a holder can reapply after fixing compliance.
    if (request.status !== "PENDING") {
      return NextResponse.json({ request, triggered: false }, { status: created ? 201 : 200 });
    }

    const trigger = await triggerHermesTokenRequest(request);
    const updated = updateTokenRequest(request.id, {
      triggerStatus: trigger.triggered ? "TRIGGERED" : "FAILED",
      triggerError: trigger.error ?? null,
    })!;

    return NextResponse.json(
      { request: updated, triggered: trigger.triggered, warning: trigger.error },
      { status: created ? 201 : 200 }
    );
  });
}
