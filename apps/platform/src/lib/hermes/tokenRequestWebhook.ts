import { createHmac } from "node:crypto";
import type { TokenRequestRecord } from "@/types";

export interface HermesTriggerResult {
  triggered: boolean;
  error?: string;
}

/** Notify the loopback-only Hermes webhook adapter. The request is already durable by the time
 *  this runs, so failures are reported to the UI without losing the request. */
export async function triggerHermesTokenRequest(
  request: TokenRequestRecord
): Promise<HermesTriggerResult> {
  const url = process.env.HERMES_TOKEN_REQUEST_WEBHOOK_URL;
  const secret = process.env.HERMES_TOKEN_REQUEST_WEBHOOK_SECRET;
  if (!url || !secret) {
    return { triggered: false, error: "Hermes token-request webhook is not configured." };
  }

  const body = JSON.stringify({
    event_type: "token_request",
    request_id: request.id,
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        // Each explicit retry must create a fresh agent run. Business-level
        // idempotence is enforced by the request's atomic PENDING -> PROCESSING claim.
        "X-Request-ID": `token-request-${request.id}-${Date.now()}`,
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
      error: error instanceof Error ? error.message : "Hermes webhook request failed.",
    };
  }
}
