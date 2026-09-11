import { NextResponse } from "next/server";

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
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
