import { NextResponse } from "next/server";
import { getAddress } from "ethers";
import { ApiError, handleRoute, requireToken } from "@/lib/api/helpers";
import { getLiveTokenBalance } from "@/lib/chat/eligibility";

export const dynamic = "force-dynamic";

function normalizeAccountId(blockchain: "EVM" | "HEDERA", accountId: string): string {
  if (blockchain === "EVM") {
    try {
      return getAddress(accountId);
    } catch {
      throw new ApiError("Invalid Sepolia wallet address.", 400);
    }
  }

  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    throw new ApiError("Invalid Hedera account ID.", 400);
  }
  return accountId;
}

/** Read the connected wallet's live on-chain balance for this token. */
export async function GET(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const token = requireToken(tokenId);
    const accountId = new URL(req.url).searchParams.get("accountId");
    if (!accountId) throw new ApiError("accountId is required.", 400);

    const normalizedAccountId = normalizeAccountId(token.blockchain, accountId);
    const balanceBaseUnits = await getLiveTokenBalance(token, normalizedAccountId);

    return NextResponse.json(
      { balanceBaseUnits: balanceBaseUnits.toString() },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
