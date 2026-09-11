import { NextResponse } from "next/server";
import { ApiError, handleRoute, readJson, requireToken } from "@/lib/api/helpers";
import { getWorldIdVerification } from "@/lib/db/repo";
import { triggerHermesLivenessVerification } from "@/lib/hermes/livenessWebhook";

export const dynamic = "force-dynamic";

type RetryBody = { verificationId?: number };

/** Retry only the constrained Hermes run for a proof already stored by this holder. The browser
 * cannot alter the proof, check kind, token, or account attached to the verification. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ tokenId: string; accountId: string }> }
) {
  return handleRoute(async () => {
    const { tokenId, accountId } = await params;
    const token = requireToken(tokenId);
    if (!token.compliance.livenessEnabled || !token.compliance.worldIdSelfieCheck) {
      throw new ApiError("This token does not use recurring Selfie Check.", 409);
    }

    const { verificationId } = await readJson<RetryBody>(req);
    if (!Number.isSafeInteger(verificationId) || !verificationId || verificationId < 1) {
      throw new ApiError("A valid World ID verification id is required.", 400);
    }
    const verification = getWorldIdVerification(verificationId);
    if (
      !verification ||
      verification.tokenId !== tokenId ||
      verification.accountId !== accountId ||
      verification.check !== "selfie"
    ) {
      throw new ApiError("This Selfie verification does not belong to this holder.", 404);
    }
    if (verification.status !== "PENDING" && verification.status !== "FAILED") {
      throw new ApiError(`This proof cannot be retried while it is ${verification.status}.`, 409);
    }

    const trigger = await triggerHermesLivenessVerification(verification);
    if (!trigger.triggered) {
      throw new ApiError(trigger.error ?? "Hermes could not be started.", 503);
    }
    return NextResponse.json({ triggered: true }, { status: 202 });
  });
}
