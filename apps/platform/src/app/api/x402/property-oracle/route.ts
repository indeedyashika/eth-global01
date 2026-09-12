import { NextRequest, NextResponse } from "next/server";
import { handlePropertyOracleRequest, PropertyAddressInput } from "@/lib/x402/oracleService";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    const body = rawBody as PropertyAddressInput;
    const mode =
      rawBody?.mode ||
      req.headers.get("x-verification-mode") ||
      undefined;

    const paymentTx =
      req.headers.get("x-payment-tx") ||
      req.headers.get("x-payment") ||
      req.headers.get("authorization")?.replace(/^x402\s+/i, "") ||
      rawBody?.paymentTx ||
      undefined;
    const invoiceId =
      req.headers.get("x-payment-invoice") ||
      rawBody?.invoiceId ||
      undefined;
    const provenance =
      (req.headers.get("x-payment-provenance") || rawBody?.provenance) as "LIVE_ONCHAIN" | undefined;

    const proof =
      paymentTx !== undefined || invoiceId !== undefined || provenance !== undefined
        ? { paymentTx: paymentTx || null, invoiceId, provenance }
        : undefined;

    const result = await handlePropertyOracleRequest(body, proof, { mode });

    if (result.status === 402) {
      const headers: Record<string, string> = {};
      if (result.x402) {
        headers["X-402-Version"] = result.x402.version;
        headers["X-402-Facilitator"] = result.x402.facilitator;
        headers["X-402-Network"] = result.x402.network;
        headers["X-402-Payee"] = result.x402.payee;
        headers["X-402-Amount"] = result.x402.amount;
        headers["X-402-Invoice"] = result.x402.invoiceId;
      }
      return NextResponse.json(
        { error: result.error || "Payment Required", status: 402, x402: result.x402 },
        { status: 402, headers }
      );
    }

    if (result.status === 503) {
      return NextResponse.json(
        { error: result.error, code: result.code || "USPS_CREDENTIALS_REQUIRED", status: 503 },
        { status: 503 }
      );
    }

    if (result.status === 502) {
      return NextResponse.json(
        { error: result.error, code: result.code || "HCS_SUBMISSION_FAILED", status: 502 },
        { status: 502 }
      );
    }

    if (result.status === 422) {
      return NextResponse.json(
        { error: result.error, code: result.code || "USPS_DPV_FAILED", status: 422, data: result.data },
        { status: 422 }
      );
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
