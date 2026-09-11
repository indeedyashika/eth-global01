import type { HolderRecord, TokenRecord } from "@/types";
import { worldIdHolderSignal as chainBoundWorldIdHolderSignal } from "@/lib/chains";

export function worldIdHolderSignal(token: TokenRecord, accountId: string): string {
  return chainBoundWorldIdHolderSignal(token, accountId);
}

export function hasRequiredWorldIdVerification(
  token: TokenRecord,
  holder: HolderRecord | null
): boolean {
  if (!token.compliance.worldIdRequired) return true;
  if (!holder) return false;

  if (
    token.compliance.worldIdSelfieCheck &&
    !holder.worldIdSelfieVerifiedAt
  ) {
    return false;
  }

  const identityRequired =
    token.compliance.worldIdMinimumAge != null ||
    token.compliance.worldIdNationality != null;
  if (identityRequired && !holder.worldIdIdentityVerifiedAt) return false;

  return true;
}

/** A holder may ask Hermes to review once every required proof is either already verified or
 * durably queued. Hermes performs the actual World API exchange through the World ID MCP. */
export function hasRequiredWorldIdSubmission(
  token: TokenRecord,
  holder: HolderRecord | null
): boolean {
  if (!token.compliance.worldIdRequired) return true;
  if (!holder) return false;

  const usable = (status: string | undefined) =>
    status === "PENDING" || status === "PROCESSING" || status === "FAILED";

  if (
    token.compliance.worldIdSelfieCheck &&
    !holder.worldIdSelfieVerifiedAt &&
    !usable(holder.worldIdSelfieVerification?.status)
  ) {
    return false;
  }

  const identityRequired =
    token.compliance.worldIdMinimumAge != null ||
    token.compliance.worldIdNationality != null;
  if (
    identityRequired &&
    !holder.worldIdIdentityVerifiedAt &&
    !usable(holder.worldIdIdentityVerification?.status)
  ) {
    return false;
  }

  return true;
}
