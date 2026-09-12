import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/api/helpers";
import { getAuthoritativeCapTable } from "@/lib/captable/capTableService";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> }
) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const capTable = await getAuthoritativeCapTable(tokenId);
    return NextResponse.json({
      success: true,
      capTable,
    });
  });
}
