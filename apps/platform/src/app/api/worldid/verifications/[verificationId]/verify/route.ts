import { NextResponse } from "next/server";
import {
  handleRoute,
  parseWorldIdVerificationId,
  requireAgentRequest,
} from "@/lib/api/helpers";
import { executeWorldIdVerification } from "@/lib/worldid/pendingVerification";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ verificationId: string }> }
) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const { verificationId: rawId } = await params;
    const result = await executeWorldIdVerification(parseWorldIdVerificationId(rawId));
    return NextResponse.json({ success: true, ...result });
  });
}
