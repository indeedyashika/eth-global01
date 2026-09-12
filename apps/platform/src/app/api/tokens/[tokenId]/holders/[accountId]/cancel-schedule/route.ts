import { NextResponse } from "next/server";
import { ApiError, handleRoute, requireToken } from "@/lib/api/helpers";
import { requireOperatorSession } from "@/lib/api/sessionAuth";
import { getHolder, insertEvent, updateHolder } from "@/lib/db/repo";
import { cancelScheduledReclaim } from "@/lib/hedera/scheduleService";
import { isAddress } from "ethers";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tokenId: string; accountId: string }> }
) {
  return handleRoute(async () => {
    requireOperatorSession(req);
    const { tokenId, accountId } = await params;
    const token = requireToken(tokenId);

    if (token.blockchain === "EVM" && !isAddress(accountId)) {
      throw new ApiError("Token is on EVM; account must be a valid EVM address", 400);
    }
    if (token.blockchain === "HEDERA" && !/^\d+\.\d+\.\d+$/.test(accountId)) {
      throw new ApiError("Token is on Hedera; account must be a valid Hedera account ID", 400);
    }

    const holder = getHolder(tokenId, accountId);
    if (!holder) throw new ApiError("Holder has not registered for this token.", 404);

    if (holder.activeScheduleId) {
      await cancelScheduledReclaim(holder.activeScheduleId);
      updateHolder(tokenId, accountId, { activeScheduleId: null, activeScheduleExpiresAt: null });
      insertEvent({ tokenId, accountId, type: "CANCEL_RECLAIM", detail: { reason: "manually cancelled" } });
    }

    return NextResponse.json({ holder: getHolder(tokenId, accountId) });
  });
}
