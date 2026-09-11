import { NextRequest, NextResponse } from "next/server";
import { handlePropertyOracleRequest, PropertyAddressInput } from "@/lib/x402/oracleService";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PropertyAddressInput;

    const paymentTx =
      req.headers.get("x-payment-tx") ||
      req.headers.get("x-payment") ||
      req.headers.get("authorization")?.replace(/^x402\s+/i, "");
    const invoiceId = req.headers.get("x-payment-invoice") || undefined;

    const proof = paymentTx ? { paymentTx, invoiceId } : undefined;
    const result = await handlePropertyOracleRequest(body, proof);

    if (result.status === 402 && result.x402) {
      return NextResponse.json(result, {
        status: 402,
        headers: {
          "X-402-Version": result.x402.version,
          "X-402-Facilitator": result.x402.facilitator,
          "X-402-Network": result.x402.network,
          "X-402-Payee": result.x402.payee,
          "X-402-Amount": result.x402.amount,
          "X-402-Invoice": result.x402.invoiceId,
        },
      });
    }

    if (result.status === 400) {
      return NextResponse.json(result, { status: 400 });
    }

    return NextResponse.json(result.data, { status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ status: 500, error: msg }, { status: 500 });
  }
}
