import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/api/helpers";
import { getAuthoritativeHcsLedger } from "@/lib/hedera/hcsLedgerService";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> }
) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const ledger = getAuthoritativeHcsLedger({
      tokenId,
      propertyId: tokenId === "OAK-RWA" || tokenId === "prop_456_oak_ave" ? "prop_456_oak_ave" : tokenId,
    });

    return NextResponse.json({
      success: true,
      topicId: ledger.topicId,
      records: ledger.records,
      totalCount: ledger.totalCount,
      configured: ledger.configured,
    });
  });
}
