import { NextRequest, NextResponse } from "next/server";
import { handleRoute } from "@/lib/api/helpers";
import { requireOperatorSession } from "@/lib/api/sessionAuth";

interface StreamRecord {
  propertyId: string;
  token: string;
  receiver: string;
  flowRate: number;
  monthlyRentEquivUsd: number;
  startedAt: number;
  status: string;
  txHash: string | null;
  provenance: "LIVE_ONCHAIN";
}

const activeStreamsMap = new Map<string, StreamRecord>();

export async function GET(req: NextRequest) {
  const propertyId = req.nextUrl.searchParams.get("propertyId");
  const streams = Array.from(activeStreamsMap.values()).filter((s) =>
    propertyId ? s.propertyId === propertyId : true
  );

  return NextResponse.json({
    success: true,
    count: streams.length,
    streams,
  });
}

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    requireOperatorSession(req);
    const body = (await req.json()) as StreamRecord;
    const key = `${body.propertyId}:${body.receiver?.toLowerCase()}`;
    activeStreamsMap.set(key, {
      ...body,
      provenance: "LIVE_ONCHAIN",
    });

    return NextResponse.json({ success: true, stream: body });
  });
}
