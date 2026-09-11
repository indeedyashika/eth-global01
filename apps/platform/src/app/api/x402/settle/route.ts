import { NextRequest, NextResponse } from "next/server";
import { executeX402Payment } from "@/lib/x402/settleService";
import { recordInvoiceSettlement } from "@/lib/x402/oracleService";

export async function POST(req: NextRequest) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body", code: "INVALID_BODY" },
        { status: 400 }
      );
    }

    const {
      invoiceId,
      payee = process.env.HEDERA_OPERATOR_ID || "0.0.4491823",
      amount = "50000000",
      simulation = false,
    } = body || {};

    if (!invoiceId || typeof invoiceId !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing required field: invoiceId", code: "MISSING_INVOICE" },
        { status: 400 }
      );
    }

    const result = await executeX402Payment({
      invoiceId,
      payee,
      amountTinybars: amount,
      simulationRequested: Boolean(simulation),
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    // Record verified settlement server-side
    recordInvoiceSettlement(
      result.invoiceId,
      result.txId,
      result.provenance,
      result.amountTinybars
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json(
      {
        success: false,
        error: `Settlement execution failed: ${error.message || String(error)}`,
        code: "SERVER_ERROR",
      },
      { status: 500 }
    );
  }
}
