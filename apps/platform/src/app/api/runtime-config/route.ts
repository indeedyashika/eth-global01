import { NextResponse } from "next/server";
import { contractDeploymentStatus, requireLiveContractDeployments } from "@/lib/evm/contracts";
import { getAuditTopicId, requireLiveAuditTopic } from "@/lib/hedera/hcsAudit";

export const dynamic = "force-dynamic";

function hederaNetwork(): "mainnet" | "testnet" | "previewnet" {
  const value = (
    process.env.HEDERA_NETWORK ??
    process.env.NEXT_PUBLIC_HEDERA_NETWORK ??
    "testnet"
  ).toLowerCase();
  if (value === "mainnet" || value === "previewnet") return value;
  return "testnet";
}

export function GET() {
  try {
    requireLiveContractDeployments();
    requireLiveAuditTopic();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid runtime configuration" }, { status: 503 });
  }
  return NextResponse.json(
    {
      network: hederaNetwork(),
      walletConnectProjectId:
        process.env.WALLETCONNECT_PROJECT_ID ??
        process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
        "",
      appUrl:
        process.env.TOKENIZATION_APP_URL ??
        process.env.NEXT_PUBLIC_APP_URL ??
        "",
      contracts: contractDeploymentStatus(),
      auditTopicConfigured: Boolean(getAuditTopicId()),
      auditTopicId: getAuditTopicId(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
