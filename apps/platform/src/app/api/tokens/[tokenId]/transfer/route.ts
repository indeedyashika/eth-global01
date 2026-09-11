import { NextResponse } from "next/server";
import { ApiError, handleRoute, readJson, requireToken } from "@/lib/api/helpers";
import { getHolder, insertEvent } from "@/lib/db/repo";
import { transferFromTreasury } from "@/lib/hedera/tokenService";
import { transferSchema } from "@/lib/validation";
import { transferEvmFromTreasury } from "@/lib/evm/client";

export const dynamic = "force-dynamic";

/** Treasury -> holder distribution. Hedera itself enforces association/KYC/freeze regardless
 *  of our local bookkeeping, so this will fail on-chain if the holder isn't actually compliant
 *  even if our DB state is stale. */
export async function POST(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const token = requireToken(tokenId);

    const { accountId, amount } = transferSchema.parse(await readJson<unknown>(req));
    const holder = getHolder(tokenId, accountId);
    if (!holder || holder.status !== "WHITELISTED") {
      throw new ApiError(
        "Holder is not marked WHITELISTED in this app yet. Approve their KYC/whitelist request first (the network will still reject the transfer if they aren't actually compliant on-chain).",
        409
      );
    }

    const result = token.blockchain === "EVM"
      ? await transferEvmFromTreasury(tokenId, accountId, amount)
      : await transferFromTreasury(tokenId, accountId, amount);
    insertEvent({
      tokenId,
      accountId,
      type: "TRANSFER",
      detail: { amount },
      txId: result.txId,
      hashscanUrl: result.hashscanUrl,
    });

    return NextResponse.json(result);
  });
}
