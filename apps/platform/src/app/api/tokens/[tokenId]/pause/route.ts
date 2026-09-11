import { NextResponse } from "next/server";
import { ApiError, handleRoute, readJson, requireToken } from "@/lib/api/helpers";
import { insertEvent, setTokenPaused } from "@/lib/db/repo";
import { pauseToken, unpauseToken } from "@/lib/hedera/tokenService";
import { pauseSchema } from "@/lib/validation";
import { pauseEvmToken } from "@/lib/evm/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const token = requireToken(tokenId);
    if (!token.keys.pause) throw new ApiError("This token was created without a pause key.", 400);

    const { paused } = pauseSchema.parse(await readJson<unknown>(req));
    const result = token.blockchain === "EVM"
      ? await pauseEvmToken(tokenId, paused)
      : paused
        ? await pauseToken(tokenId)
        : await unpauseToken(tokenId);

    setTokenPaused(tokenId, paused);
    insertEvent({
      tokenId,
      type: paused ? "PAUSE" : "UNPAUSE",
      txId: result.txId,
      hashscanUrl: result.hashscanUrl,
    });

    return NextResponse.json({ paused, ...result });
  });
}
