import { createHmac } from "node:crypto";
import type { WorldIdVerificationRecord } from "@/types";
import type { HermesTriggerResult } from "@/lib/hermes/tokenRequestWebhook";

/** Launch a constrained Hermes run for a recurring Selfie proof. The proof itself stays in the
 * trusted Next.js queue; only its id and fixed holder context reach the webhook prompt. */
export async function triggerHermesLivenessVerification(
  verification: WorldIdVerificationRecord
): Promise<HermesTriggerResult> {
  const url = process.env.HERMES_LIVENESS_WEBHOOK_URL;
  const secret = process.env.HERMES_LIVENESS_WEBHOOK_SECRET;
  if (!url || !secret) {
    return { triggered: false, error: "Hermes liveness webhook is not configured." };
  }

  const body = JSON.stringify({
    event_type: "liveness_verification",
    verification_id: verification.id,
    token_id: verification.tokenId,
    account_id: verification.accountId,
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Request-ID": `liveness-verification-${verification.id}-${Date.now()}`,
      },
      body,
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return { triggered: false, error: `Hermes webhook returned HTTP ${response.status}.` };
    }
    return { triggered: true };
  } catch (error) {
    return {
      triggered: false,
      error: error instanceof Error ? error.message : "Hermes liveness webhook request failed.",
    };
  }
}
