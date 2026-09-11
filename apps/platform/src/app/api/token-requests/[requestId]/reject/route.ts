import { NextResponse } from "next/server";
import { handleRoute, parseRequestId, readJson, requireAgentRequest } from "@/lib/api/helpers";
import { rejectStoredTokenRequest } from "@/lib/tokenRequests";
import { rejectTokenRequestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const { requestId } = await params;
    const { reason } = rejectTokenRequestSchema.parse(await readJson<unknown>(req));
    const request = rejectStoredTokenRequest(parseRequestId(requestId), reason);
    return NextResponse.json({ request });
  });
}
