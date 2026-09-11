import { NextResponse } from "next/server";
import { ApiError, handleRoute, readJson, requireToken } from "@/lib/api/helpers";
import {
  createWorldIdVerification,
  getHolder,
} from "@/lib/db/repo";
import { worldIdHolderSignal } from "@/lib/worldid/policy";
import { serializeWorldIdProof } from "@/lib/worldid/proof";
import { expectedWorldAction } from "@/lib/worldid/verification";
import type { WorldIdCheckKind } from "@/types";
import { triggerHermesLivenessVerification } from "@/lib/hermes/livenessWebhook";

export const dynamic = "force-dynamic";

type VerificationBody = {
  check?: WorldIdCheckKind;
  result?: unknown;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tokenId: string; accountId: string }> }
) {
  return handleRoute(async () => {
    const { tokenId, accountId } = await params;
    const token = requireToken(tokenId);
    const holder = getHolder(tokenId, accountId);
    if (!holder) throw new ApiError("Join this token before verifying with World ID.", 404);
    if (!holder.associated) {
      throw new ApiError("Associate this token with your wallet before World ID verification.", 409);
    }

    const { check, result } = await readJson<VerificationBody>(req);
    if ((check !== "selfie" && check !== "identity") || !result) {
      throw new ApiError("Missing World ID proof.", 400);
    }

    const identityRequired =
      token.compliance.worldIdMinimumAge != null ||
      token.compliance.worldIdNationality != null;
    if (check === "selfie" && !token.compliance.worldIdSelfieCheck) {
      throw new ApiError("This token does not require Selfie Check.", 409);
    }
    if (check === "identity" && !identityRequired) {
      throw new ApiError("This token does not require Identity Check.", 409);
    }
    const recurringSelfie =
      check === "selfie" &&
      token.compliance.livenessEnabled &&
      !!holder.worldIdSelfieVerifiedAt;
    if (recurringSelfie && holder.livenessState === "EXPIRED") {
      throw new ApiError(
        "The Selfie renewal deadline has expired and automatic return is processing.",
        409
      );
    }
    if (
      (check === "selfie" && holder.worldIdSelfieVerifiedAt && !recurringSelfie) ||
      (check === "identity" && holder.worldIdIdentityVerifiedAt)
    ) {
      throw new ApiError("This World ID check is already verified.", 409);
    }

    let proofJson: string;
    let proofHash: string;
    try {
      ({ proofJson, proofHash } = serializeWorldIdProof(result));
    } catch {
      throw new ApiError("The World ID proof could not be serialized.", 400);
    }
    if (!proofJson || proofJson.length > 128_000) {
      throw new ApiError("The World ID proof is empty or too large.", 413);
    }

    const verification = createWorldIdVerification({
      tokenId,
      accountId,
      check,
      action: expectedWorldAction(check),
      expectedSignal: worldIdHolderSignal(token, accountId),
      proofJson,
      proofHash,
    });
    const trigger = recurringSelfie
      ? await triggerHermesLivenessVerification(verification)
      : { triggered: false as const, error: undefined };

    return NextResponse.json(
      {
        success: true,
        submitted: true,
        message: recurringSelfie
          ? "Proof stored securely. Hermes is verifying the recurring Selfie Check."
          : "Proof stored securely. Hermes will verify it with World before sending tokens.",
        verification,
        hermesTriggered: trigger.triggered,
        warning: trigger.error,
      },
      { status: 202 }
    );
  });
}
