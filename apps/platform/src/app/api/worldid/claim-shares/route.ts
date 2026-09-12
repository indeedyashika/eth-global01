import { NextRequest, NextResponse } from "next/server";
import { handleRoute } from "@/lib/api/helpers";
import {
  verifyWorldIdProofAndClaimShares,
  ShareClaimError,
} from "@/lib/worldid/shareClaimService";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    try {
      const result = await verifyWorldIdProofAndClaimShares(body);
      return NextResponse.json(result);
    } catch (err: any) {
      if (err instanceof ShareClaimError) {
        return NextResponse.json(
          {
            success: false,
            error: err.message,
            code: err.code,
            details: err.details,
          },
          { status: err.status }
        );
      }
      throw err;
    }
  });
}
