import { NextRequest, NextResponse } from "next/server";

interface StreamRecord {
  propertyId: string;
  token: string;
  receiver: string;
  flowRate: number;
  monthlyRentEquivUsd: number;
  startedAt: number;
  status: string;
  txHash: string;
}

const activeStreamsMap = new Map<string, StreamRecord>();

// Seed a default stream for the demo
activeStreamsMap.set("prop_456_oak_ave:default", {
  propertyId: "prop_456_oak_ave",
  token: "0x42bb40bF79730451B11f6De1CbA222F17b87Afd7",
  receiver: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  flowRate: 1620370370370,
  monthlyRentEquivUsd: 3800,
  startedAt: Math.floor(Date.now() / 1000) - 7200, // started 2 hours ago
  status: "ACTIVE",
  txHash: "0x7b58a129d21e843f5451e944738590172bf4212a",
});

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
  try {
    const body = (await req.json()) as StreamRecord;
    const key = `${body.propertyId}:${body.receiver?.toLowerCase()}`;
    activeStreamsMap.set(key, body);

    return NextResponse.json({ success: true, stream: body });
  } catch (err) {
    return NextResponse.json({ error: "Invalid stream payload" }, { status: 400 });
  }
}
