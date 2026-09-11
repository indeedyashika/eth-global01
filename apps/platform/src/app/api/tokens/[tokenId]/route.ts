import { NextResponse } from "next/server";
import { handleRoute, requireToken } from "@/lib/api/helpers";
import { listEvents, listHolders } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  return handleRoute(async () => {
    const { tokenId } = await params;
    const token = requireToken(tokenId);
    const holders = listHolders(tokenId);
    const events = listEvents(tokenId);
    return NextResponse.json({ token, holders, events });
  });
}
