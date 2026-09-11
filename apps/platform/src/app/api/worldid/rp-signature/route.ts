import { signRequest } from "@worldcoin/idkit/signing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type VerificationFlow = "selfie" | "identity";
type VerificationPolicy = "selfie" | "identity" | "identity-age" | "identity-us";

const POLICIES = new Set<VerificationPolicy>([
  "selfie",
  "identity",
  "identity-age",
  "identity-us",
]);

export async function POST(request: Request) {
  const signingKey = process.env.WORLD_RP_SIGNING_KEY;
  const rpId = process.env.WORLD_RP_ID;

  if (!signingKey || !rpId) {
    return NextResponse.json(
      {
        error:
          "World ID is not configured: WORLD_RP_ID or WORLD_RP_SIGNING_KEY is missing.",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    flow?: VerificationFlow;
    policy?: VerificationPolicy;
  };
  const flow: VerificationFlow =
    body.flow === "identity" ? "identity" : "selfie";
  const policy = body.policy;

  if (!policy || !POLICIES.has(policy)) {
    return NextResponse.json(
      { error: "Unknown World ID verification policy." },
      { status: 400 },
    );
  }

  if (
    (flow === "selfie" && policy !== "selfie") ||
    (flow === "identity" && policy === "selfie")
  ) {
    return NextResponse.json(
      { error: "The verification flow does not match the requested policy." },
      { status: 400 },
    );
  }

  const action =
    flow === "identity"
      ? (process.env.WORLD_IDENTITY_ACTION ?? "identity-check-demo")
      : (process.env.WORLD_ACTION ?? "selfie-check-demo");

  try {
    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex: signingKey,
      action,
    });

    return NextResponse.json({
      rp_id: rpId,
      nonce,
      created_at: createdAt,
      expires_at: expiresAt,
      signature: sig,
      action,
    });
  } catch {
    return NextResponse.json(
      { error: "The RP signing key could not sign this World ID request." },
      { status: 500 },
    );
  }
}
