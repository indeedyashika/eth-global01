import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/api/helpers";
import { getToken, listEvents, listHolders } from "@/lib/db/repo";
import { getAuthoritativeWorkspaceData } from "@/lib/workspace/authoritativeWorkspace";
import { getAuthoritativeCapTable } from "@/lib/captable/capTableService";
import type { TokenRecord } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const authData = getAuthoritativeWorkspaceData(tokenId);

    let token = getToken(tokenId);
    if (!token && (tokenId === "prop_456_oak_ave" || tokenId === authData.property.propertyId)) {
      token = {
        id: authData.property.propertyId,
        blockchain: "EVM",
        network: "sepolia",
        name: authData.token.name,
        symbol: authData.token.symbol,
        tokenType: "FUNGIBLE",
        decimals: 0,
        initialSupply: "1000",
        supplyType: "FINITE",
        maxSupply: "1000",
        treasuryAccountId: authData.rent.vaultAddress || "0xYieldVault",
        assetCategory: "real-estate",
        memo: `${authData.property.address} · USPS DPV Validated · $5,000/mo Superfluid CFA Yield · Base Sepolia Stream`,
        compliance: {
          kycRequired: true,
          freezeDefault: false,
          wipeEnabled: true,
          pauseEnabled: true,
          worldIdRequired: true,
          worldIdSelfieCheck: true,
          livenessEnabled: false,
        },
        customFee: null,
        keys: { admin: true, kyc: true, freeze: true, wipe: true, pause: true, supply: true, feeSchedule: false },
        paused: false,
        createTxId: authData.property.paymentTxId,
        hashscanUrl: authData.property.hcsTopic ? `https://hashscan.io/testnet/topic/${authData.property.hcsTopic}` : "",
        explorerUrl: `https://sepolia.basescan.org/address/${authData.rent.vaultAddress || "0xYieldVault"}`,
        explorerName: "Etherscan",
        createdAt: authData.property.timestamp || new Date().toISOString(),
      };
    }

    const capTable = await getAuthoritativeCapTable(tokenId);
    const holders = listHolders(tokenId);
    const events = listEvents(tokenId);
    return NextResponse.json({
      token,
      holders,
      events,
      capTable,
      authoritativeWorkspace: authData,
    });
  });
}
