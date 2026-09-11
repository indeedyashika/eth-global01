import { NextResponse } from "next/server";
import { ApiError, handleRoute, requireAgentRequest } from "@/lib/api/helpers";
import { listWorldIdVerifications } from "@/lib/db/repo";
import type { WorldIdVerificationStatus } from "@/types";

export const dynamic = "force-dynamic";

const STATUSES = new Set<WorldIdVerificationStatus>([
  "PENDING",
  "PROCESSING",
  "VERIFIED",
  "REJECTED",
  "FAILED",
]);

export async function GET(req: Request) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const query = new URL(req.url).searchParams;
    const rawStatus = query.get("status")?.toUpperCase();
    if (rawStatus && !STATUSES.has(rawStatus as WorldIdVerificationStatus)) {
      throw new ApiError("Invalid World ID verification status.", 400);
    }
    const verifications = listWorldIdVerifications({
      status: rawStatus as WorldIdVerificationStatus | undefined,
      tokenId: query.get("tokenId") ?? undefined,
      accountId: query.get("accountId") ?? undefined,
    });
    return NextResponse.json({ verifications });
  });
}
