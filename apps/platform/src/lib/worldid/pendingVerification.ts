import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api/helpers";
import {
  claimWorldIdVerification,
  completeWorldIdVerification,
  failWorldIdVerification,
  getHolder,
  getToken,
  getWorldIdVerification,
  getWorldIdVerificationProof,
  insertEvent,
  updateHolder,
} from "@/lib/db/repo";
import { worldIdHolderSignal } from "@/lib/worldid/policy";
import {
  expectedWorldAction,
  verifyIdentityCredential,
  verifySelfieCredential,
  WorldProofError,
} from "@/lib/worldid/verification";
import type { HolderRecord, WorldIdVerificationRecord } from "@/types";
import { recordVerifiedSelfieLiveness } from "@/lib/liveness";

export type WorldIdExecutionResult = {
  verification: WorldIdVerificationRecord;
  holder: HolderRecord;
};

async function applyVerifiedCheck(
  verification: WorldIdVerificationRecord
): Promise<HolderRecord> {
  const token = getToken(verification.tokenId);
  const holder = getHolder(verification.tokenId, verification.accountId);
  if (!token || !holder) {
    throw new ApiError("The token or holder for this World ID verification no longer exists.", 404);
  }
  if (!verification.verifiedAt) {
    throw new ApiError("The World ID verification has no trusted verification timestamp.", 409);
  }

  const selfieVerifiedAt =
    verification.check === "selfie"
      ? verification.verifiedAt
      : holder.worldIdSelfieVerifiedAt;
  const identityVerifiedAt =
    verification.check === "identity"
      ? verification.verifiedAt
      : holder.worldIdIdentityVerifiedAt;
  const identityRequired =
    token.compliance.worldIdMinimumAge != null ||
    token.compliance.worldIdNationality != null;
  const allRequiredChecksPassed =
    (!token.compliance.worldIdSelfieCheck || !!selfieVerifiedAt) &&
    (!identityRequired || !!identityVerifiedAt);

  updateHolder(verification.tokenId, verification.accountId, {
    worldIdSelfieVerifiedAt: selfieVerifiedAt,
    worldIdIdentityVerifiedAt: identityVerifiedAt,
    worldIdVerifiedAt: allRequiredChecksPassed ? verification.verifiedAt : null,
  });
  if (verification.check === "selfie") {
    await recordVerifiedSelfieLiveness(
      verification.tokenId,
      verification.accountId,
      verification.verifiedAt
    );
  }
  return getHolder(verification.tokenId, verification.accountId)!;
}

/** Execute the one trusted World API exchange for a queued proof. The caller (World ID MCP)
 * supplies only the queue id: proof bytes and provider configuration never enter agent context. */
export async function executeWorldIdVerification(
  id: number
): Promise<WorldIdExecutionResult> {
  const existing = getWorldIdVerification(id);
  if (!existing) throw new ApiError(`World ID verification ${id} not found`, 404);
  const liveToken = getToken(existing.tokenId);
  const liveHolder = getHolder(existing.tokenId, existing.accountId);
  if (
    existing.status !== "VERIFIED" &&
    existing.check === "selfie" &&
    liveToken?.compliance.livenessEnabled &&
    liveHolder?.lastCheckinAt &&
    liveHolder.livenessState === "EXPIRED"
  ) {
    const message = "The Selfie renewal deadline expired before this proof was verified.";
    failWorldIdVerification(id, "liveness_deadline_expired", message, true);
    throw new ApiError(message, 409);
  }
  if (existing.status === "VERIFIED") {
    return { verification: existing, holder: await applyVerifiedCheck(existing) };
  }
  if (existing.status === "REJECTED") {
    throw new ApiError(
      existing.errorDetail ?? "This World ID proof was definitively rejected.",
      409
    );
  }
  if (existing.status === "PROCESSING") {
    throw new ApiError("This World ID proof is already being verified.", 409);
  }

  const claimed = claimWorldIdVerification(id);
  if (!claimed) throw new ApiError("This World ID proof could not be claimed for verification.", 409);

  try {
    const queued = getWorldIdVerificationProof(id);
    if (!queued?.proof) {
      throw new WorldProofError("The queued World ID proof is missing.", 409, "missing_proof");
    }

    if (!liveToken) throw new ApiError("The token for this proof no longer exists.", 404);
    const expectedSignal = worldIdHolderSignal(liveToken, claimed.accountId);
    if (
      claimed.expectedSignal !== expectedSignal ||
      claimed.action !== expectedWorldAction(claimed.check)
    ) {
      throw new WorldProofError(
        "The queued proof context no longer matches this holder policy.",
        409,
        "verification_context_mismatch"
      );
    }

    const result =
      claimed.check === "selfie"
        ? await verifySelfieCredential(queued.proof, expectedSignal)
        : await verifyIdentityCredential(queued.proof, expectedSignal);
    const verifiedAt = new Date().toISOString();
    const nullifierHash = createHash("sha256")
      .update(result.nullifier.toLowerCase())
      .digest("hex");
    const completion = completeWorldIdVerification(
      id,
      result.credential,
      nullifierHash,
      verifiedAt
    );
    if (!completion.completed) {
      throw new ApiError(completion.message, 409);
    }

    const verification = getWorldIdVerification(id)!;
    const holder = await applyVerifiedCheck(verification);
    insertEvent({
      tokenId: verification.tokenId,
      accountId: verification.accountId,
      type: "WORLDID_VERIFY",
      detail: {
        verificationId: verification.id,
        check: verification.check,
        credential: verification.credential,
        provider: "World ID",
        verifiedBy: "Hermes World ID MCP",
        nullifierHash: verification.nullifierHash,
      },
    });
    return { verification, holder };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof WorldProofError) {
      const definitive = error.status < 500;
      failWorldIdVerification(
        id,
        error.code,
        [error.message, error.details].filter(Boolean).join(" · "),
        definitive
      );
      throw new ApiError(
        [error.message, error.code, error.details].filter(Boolean).join(" · "),
        error.status
      );
    }

    const message = error instanceof Error ? error.message : "Unknown World ID verification error";
    failWorldIdVerification(id, "world_verification_internal_error", message, false);
    throw error;
  }
}
