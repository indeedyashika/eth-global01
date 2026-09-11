import { NextResponse } from "next/server";
import {
  ApiError,
  handleRoute,
  parseWorldIdVerificationId,
  requireAgentRequest,
} from "@/lib/api/helpers";
import { getWorldIdVerification } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ verificationId: string }> }
) {
  return handleRoute(async () => {
    requireAgentRequest(req);
    const { verificationId: rawId } = await params;
    const verification = getWorldIdVerification(parseWorldIdVerificationId(rawId));
    if (!verification) throw new ApiError(`World ID verification ${rawId} not found`, 404);
    return NextResponse.json({ verification });
  });
}
