import { NextResponse } from "next/server";
import { handleRoute, readJson } from "@/lib/api/helpers";
import { insertEvent, insertToken, listTokens } from "@/lib/db/repo";
import { createEvmTokenSchema } from "@/lib/validation";
import { deployEvmToken, getEvmOperatorAddress } from "@/lib/evm/client";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () =>
    NextResponse.json({ tokens: listTokens().filter((token) => token.blockchain === "EVM") })
  );
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const body = await readJson<Record<string, unknown>>(req);
    const input = createEvmTokenSchema.parse({ ...body, blockchain: "EVM" });
    const compliance = input.compliance.worldIdRequired
      ? { ...input.compliance, kycRequired: true }
      : input.compliance;

    let tokenId: string;
    let txId: string;
    let explorerUrl: string;
    let keys: any;
    let treasuryAccountId = input.treasuryAccountId || getEvmOperatorAddress();

    if (input.existingTokenId && input.createTxId) {
      tokenId = input.existingTokenId;
      txId = input.createTxId;
      explorerUrl = `https://sepolia.etherscan.io/tx/${txId}`;
      keys = {
        admin: true,
        kyc: !!(compliance.kycRequired || compliance.worldIdRequired),
        freeze: !!compliance.freezeDefault,
        wipe: !!compliance.wipeEnabled,
        pause: !!compliance.pauseEnabled,
        supply: true,
        feeSchedule: false,
      };
    } else {
      const created = await deployEvmToken({
        name: input.name,
        symbol: input.symbol,
        decimals: input.decimals,
        initialSupply: input.initialSupply,
        supplyType: input.supplyType,
        maxSupply: input.maxSupply,
        compliance,
      });
      tokenId = created.tokenId;
      txId = created.txId;
      explorerUrl = created.explorerUrl;
      keys = created.keys;
    }

    const token = insertToken({
      id: tokenId,
      blockchain: "EVM",
      network: "sepolia",
      name: input.name,
      symbol: input.symbol,
      tokenType: "FUNGIBLE",
      decimals: input.decimals,
      initialSupply: input.initialSupply,
      supplyType: input.supplyType,
      maxSupply: input.maxSupply,
      treasuryAccountId,
      assetCategory: input.assetCategory,
      memo: input.memo,
      compliance,
      customFee: null,
      keys,
      createTxId: txId,
    });

    insertEvent({
      tokenId: token.id,
      type: "CREATE_TOKEN",
      detail: {
        name: token.name,
        symbol: token.symbol,
        tokenType: token.tokenType,
        blockchain: "EVM",
        network: "sepolia",
      },
      txId,
      hashscanUrl: explorerUrl,
    });

    // Ensure initial treasury and investor holders exist
    try {
      const { ensureHolder, updateHolder } = await import("@/lib/db/repo");
      ensureHolder(token.id, treasuryAccountId, treasuryAccountId);
      updateHolder(token.id, treasuryAccountId, {
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
