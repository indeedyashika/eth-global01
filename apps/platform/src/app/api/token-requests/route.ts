import { NextResponse } from "next/server";
import { handleRoute, requireAgentRequest } from "@/lib/api/helpers";
import { listTokenRequests } from "@/lib/db/repo";
import { tokenRequestStatusSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const rawStatus = new URL(req.url).searchParams.get("status");
    const status = rawStatus ? tokenRequestStatusSchema.parse(rawStatus) : undefined;
    return NextResponse.json({ requests: listTokenRequests(status) });
  });
}
