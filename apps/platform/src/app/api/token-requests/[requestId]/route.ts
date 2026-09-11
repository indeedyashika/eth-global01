import { NextResponse } from "next/server";
import { ApiError, handleRoute, parseRequestId, requireAgentRequest } from "@/lib/api/helpers";
import { getTokenRequest } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const { requestId: rawRequestId } = await params;
    const request = getTokenRequest(parseRequestId(rawRequestId));
    if (!request) throw new ApiError(`Token request ${rawRequestId} not found`, 404);
    return NextResponse.json({ request });
  });
}
