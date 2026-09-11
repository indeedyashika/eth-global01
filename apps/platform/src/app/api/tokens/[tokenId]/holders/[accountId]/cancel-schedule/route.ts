import { NextResponse } from "next/server";
import { ApiError, handleRoute, requireToken } from "@/lib/api/helpers";
import { getHolder, insertEvent, updateHolder } from "@/lib/db/repo";
import { cancelScheduledReclaim } from "@/lib/hedera/scheduleService";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string; accountId: string }> }
) {
  return handleRoute(async () => {
    const { tokenId, accountId } = await params;
    requireToken(tokenId);
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
