import { NextResponse } from "next/server";
import { ApiError, handleRoute, readJson } from "@/lib/api/helpers";
import { insertEvent, insertToken, listTokens } from "@/lib/db/repo";
import { createToken } from "@/lib/hedera/tokenService";
import { getOperatorId } from "@/lib/hedera/client";
import { createTokenSchema } from "@/lib/validation";
import { configuredHederaNetwork } from "@/lib/chains";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () => NextResponse.json({ tokens: listTokens() }));
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const body = await readJson<unknown>(req);
    const input = createTokenSchema.parse(body);
    if (input.blockchain !== "HEDERA") {
      throw new ApiError("Use /api/evm/tokens to deploy a Sepolia ERC-20 token.", 400);
    }

    const created = await createToken({
      name: input.name,
      symbol: input.symbol,
      tokenType: input.tokenType,
      decimals: input.tokenType === "NFT" ? 0 : input.decimals,
      initialSupply: input.tokenType === "NFT" ? 0 : input.initialSupply,
      supplyType: input.supplyType,
      maxSupply: input.maxSupply,
      memo: input.memo,
      compliance: input.compliance,
      customFee: input.customFee ?? null,
    });

    const token = insertToken({
      id: created.tokenId,
      blockchain: "HEDERA",
      network: configuredHederaNetwork(),
      name: input.name,
      symbol: input.symbol,
      tokenType: input.tokenType,
      decimals: input.tokenType === "NFT" ? 0 : input.decimals,
      initialSupply: input.tokenType === "NFT" ? 0 : input.initialSupply,
      supplyType: input.supplyType,
      maxSupply: input.maxSupply,
      treasuryAccountId: getOperatorId().toString(),
      assetCategory: input.assetCategory,
      memo: input.memo,
      compliance: input.compliance,
      customFee: input.customFee ?? null,
      keys: created.keys,
      createTxId: created.txId,
    });

    insertEvent({
      tokenId: token.id,
      type: "CREATE_TOKEN",
      detail: { name: token.name, symbol: token.symbol, tokenType: token.tokenType },
      txId: created.txId,
      hashscanUrl: created.hashscanUrl,
    });

    // Ensure initial treasury and investor holders exist
    try {
      const { ensureHolder, updateHolder } = await import("@/lib/db/repo");
      ensureHolder(token.id, token.treasuryAccountId, "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7");
      updateHolder(token.id, token.treasuryAccountId, {
        associated: true,
        kycGranted: true,
        status: "WHITELISTED",
      });
      const demoInvestor = "0x28a8746e75304c0780e011bed21c72cd78cd535e";
      ensureHolder(token.id, demoInvestor, demoInvestor);
      updateHolder(token.id, demoInvestor, {
        associated: true,
        kycGranted: true,
        status: "WHITELISTED",
      });
    } catch (holderErr) {
      console.warn("Could not insert initial holders:", holderErr);
    }

    return NextResponse.json({ token }, { status: 201 });
  });
}
