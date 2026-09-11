import { NextResponse } from "next/server";
import { handleRoute, parseRequestId, requireAgentRequest } from "@/lib/api/helpers";
import { fulfillStoredTokenRequest } from "@/lib/tokenRequests";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const { requestId } = await params;
    const request = await fulfillStoredTokenRequest(parseRequestId(requestId));
    return NextResponse.json({ request });
  });
}
