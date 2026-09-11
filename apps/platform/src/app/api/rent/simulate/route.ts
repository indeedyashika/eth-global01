import { NextRequest, NextResponse } from "next/server";
import { logHcsAuditEvent } from "@/lib/hedera/hcsAudit";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const propertyId = body.propertyId || "prop_456_oak_ave";
    const amount = Number(body.amount || 3800);
    const tenantName = body.tenantName || "Acme Residential Tenant Corp";

    const flowRatePerSec = amount / 2592000;
    const txId = `0.0.4491823@${Math.floor(Date.now() / 1000)}.000000000`;

    // Log unforgeable event to Hedera Consensus Service
    const hcsReceipt = await logHcsAuditEvent({
      event: "TENANT_RENT_DEPOSITED",
      propertyId,
      amount: `$${amount} USD`,
      txId,
      metadata: {
        tenant: tenantName,
        monthlyRate: amount,
        calculatedFlowRate: flowRatePerSec,
      },
    });

    // Persist event to sqlite audit trail
    try {
      const { insertEvent } = await import("@/lib/db/repo");
      const targetTokenId = propertyId.startsWith("0.") || propertyId.startsWith("0x") ? propertyId : "0.0.4491823";
      insertEvent({
        tokenId: targetTokenId,
        type: "TRANSFER",
        detail: {
          action: "TENANT_RENT_DEPOSITED",
          amount: `$${amount.toLocaleString()} USD`,
          tenant: tenantName,
          flowRatePerSec,
          hcsSequenceNumber: hcsReceipt.sequenceNumber,
        },
        txId,
        hashscanUrl: hcsReceipt.hashscanUrl || `https://hashscan.io/testnet/topic/0.0.4491823`,
      });
    } catch (e) {
      console.warn("[simulate rent] Could not record event in sqlite:", e);
    }

    return NextResponse.json({
      success: true,
      propertyId,
      amountDeposited: amount,
      currency: "USDC (Wrapped fUSDCx)",
      calculatedFlowRate: flowRatePerSec,
      hcsAudit: hcsReceipt,
      depositTimestamp: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
