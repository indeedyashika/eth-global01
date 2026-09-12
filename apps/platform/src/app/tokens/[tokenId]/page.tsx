import { notFound } from "next/navigation";
import { getToken, listEvents, listHolders, listTokenRequestsForToken } from "@/lib/db/repo";
import TokenWorkspace from "@/components/TokenWorkspace";
import { getAuthoritativeWorkspaceData } from "@/lib/workspace/authoritativeWorkspace";
import type { TokenRecord } from "@/types";

export const dynamic = "force-dynamic";

export default async function TokenDetailPage({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const authData = getAuthoritativeWorkspaceData(tokenId);

  let token = getToken(tokenId);
  if (!token) {
    // If this is the Oak Avenue asset, resolve authoritatively from protocol state
    const isOakAve =
      tokenId === "prop_456_oak_ave" ||
      tokenId === "OAK-RWA" ||
      tokenId === "0.0.4491823" ||
      tokenId === authData.property.propertyId;

    if (isOakAve) {
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
        hashscanUrl: authData.property.hcsTopic
          ? `https://hashscan.io/testnet/topic/${authData.property.hcsTopic}`
          : "",
        explorerUrl: `https://sepolia.basescan.org/address/${authData.rent.vaultAddress || "0xYieldVault"}`,
        explorerName: "Etherscan",
        createdAt: authData.property.timestamp || new Date().toISOString(),
      };
    } else {
      notFound();
    }
  }

  if (!token) {
    notFound();
  }

  const holders = listHolders(token.id);
  const events = listEvents(token.id);
  const requests = listTokenRequestsForToken(token.id);

  const appId = process.env.WORLD_APP_ID ?? process.env["NEXT_PUBLIC_WORLD_APP_ID"] ?? "";
  const worldConfig = {
    appId,
    isConfigured: Boolean(
      appId && process.env.WORLD_RP_ID && process.env.WORLD_RP_SIGNING_KEY
    ),
    selfieEnvironment: "production" as const,
    identityEnvironment: "staging" as const,
  };

  return (
    <TokenWorkspace
      token={token}
      holders={holders}
      events={events}
      requests={requests}
      worldConfig={worldConfig}
      authoritativeWorkspace={authData}
    />
  );
}
