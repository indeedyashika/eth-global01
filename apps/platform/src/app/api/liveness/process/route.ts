import { NextResponse } from "next/server";
import { handleRoute, requireAgentRequest } from "@/lib/api/helpers";
import { processExpiredLiveness } from "@/lib/liveness";

export const dynamic = "force-dynamic";

/** Internal deterministic worker endpoint. The caller cannot choose a token, holder, treasury,
 * or amount; every expired candidate and live balance is resolved server-side. */
export async function POST(req: Request) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const results = await processExpiredLiveness();
    return NextResponse.json({ processed: results.length, results });
  });
}
