import { NextResponse } from "next/server";
import {
  verifyIdentityCredential,
  WorldProofError,
} from "@/lib/worldid/verification";

export const runtime = "nodejs";

type IdentityPolicy = "identity-age" | "identity-us";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { result?: unknown; policy?: IdentityPolicy }
    | null;

  if (!body?.result || !["identity-age", "identity-us"].includes(body.policy ?? "")) {
    return NextResponse.json(
      { error: "Missing Identity Check result or policy." },
      { status: 400 }
    );
  }

  try {
    const verification = await verifyIdentityCredential(body.result);
    return NextResponse.json({
      success: true,
      world_verified: true,
      identity_attested: true,
      credential: verification.credential,
      checks:
        body.policy === "identity-us"
          ? [
              { type: "minimum_age", operator: ">=", value: 18 },
              { type: "nationality", operator: "=", value: "USA" },
            ]
          : [{ type: "minimum_age", operator: ">=", value: 18 }],
    });
  } catch (error) {
    if (error instanceof WorldProofError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status }
      );
    }
    throw error;
  }
}
