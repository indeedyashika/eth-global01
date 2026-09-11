import { NextResponse } from "next/server";
import { ApiError, handleRoute, requireToken } from "@/lib/api/helpers";
import { getHolder, insertEvent, updateHolder } from "@/lib/db/repo";
import { reclaimViaAllowanceNow, wipeAllFungible } from "@/lib/hedera/tokenService";
import { cancelScheduledReclaim } from "@/lib/hedera/scheduleService";
import { reclaimEvmViaAllowance, recoverEvmBalance } from "@/lib/evm/client";

export const dynamic = "force-dynamic";

/** Immediate, non-scheduled compliance reclaim: pulls the holder's entire current balance back
 *  to the treasury right now. Uses the wipe key if the token has one (works even without a
 *  holder-granted allowance), otherwise falls back to an allowance-based approved transfer. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string; accountId: string }> }
) {
  return handleRoute(async () => {
    const { tokenId, accountId } = await params;
    const token = requireToken(tokenId);
    const holder = getHolder(tokenId, accountId);
    if (!holder) throw new ApiError("Holder has not registered for this token.", 404);

    let result;
    if (token.keys.wipe) {
      result = token.blockchain === "EVM"
        ? await recoverEvmBalance(tokenId, accountId)
        : await wipeAllFungible(tokenId, accountId);
      insertEvent({
        tokenId,
        accountId,
        type: "WIPE",
        detail: { amount: result.amount },
        txId: result.txId,
        hashscanUrl: result.hashscanUrl,
      });
    } else if (holder.allowanceGranted) {
      result = token.blockchain === "EVM"
        ? await reclaimEvmViaAllowance(tokenId, accountId)
        : await reclaimViaAllowanceNow(tokenId, accountId);
      insertEvent({
        tokenId,
        accountId,
        type: "TRANSFER",
        detail: { amount: result.amount, reason: "immediate reclaim via allowance" },
        txId: result.txId,
        hashscanUrl: result.hashscanUrl,
      });
    } else {
      throw new ApiError(
        "Cannot reclaim: this token has no wipe key and the holder hasn't granted a token allowance to the treasury.",
        400
      );
    }

    if (token.blockchain === "HEDERA" && holder.activeScheduleId) {
      await cancelScheduledReclaim(holder.activeScheduleId);
    }
    updateHolder(tokenId, accountId, {
      status: "REVOKED",
      activeScheduleId: null,
      activeScheduleExpiresAt: null,
    });

    return NextResponse.json({ holder: getHolder(tokenId, accountId), ...result });
  });
}
