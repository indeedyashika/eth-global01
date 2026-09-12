import { NextRequest, NextResponse } from "next/server";
import { executeX402Payment } from "@/lib/x402/settleService";
import { getInvoice, recordInvoiceSettlement } from "@/lib/x402/oracleService";

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

    const { invoiceId, payee, amount, simulation = false } = body || {};

    if (!invoiceId || typeof invoiceId !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing required field: invoiceId", code: "MISSING_INVOICE" },
        { status: 400 }
      );
    }

    const invoice = getInvoice(invoiceId);
    if (!invoice) {
      return NextResponse.json(
        { success: false, error: "Unknown or expired invoice ID", code: "UNKNOWN_INVOICE" },
        { status: 404 }
      );
    }

    // The challenge is authoritative. A caller cannot redirect a payment or
    // lower the fee by posting different values to the settlement endpoint.
    if (payee !== undefined && (typeof payee !== "string" || !/^\d+\.\d+\.\d+$/.test(payee))) {
      return NextResponse.json(
        { success: false, error: "Invalid recipient account ID", code: "INVALID_RECIPIENT" },
        { status: 400 }
      );
    }
    if (amount !== undefined) {
      try {
        if (BigInt(String(amount)) <= BigInt(0)) throw new Error("non-positive");
      } catch {
        return NextResponse.json(
          { success: false, error: "Invalid payment amount", code: "INVALID_AMOUNT" },
          { status: 400 }
        );
      }
    }
    if (payee !== undefined && payee !== invoice.payee) {
      return NextResponse.json(
        { success: false, error: "Payment recipient does not match the invoice", code: "RECIPIENT_MISMATCH" },
        { status: 400 }
      );
    }
    if (amount !== undefined && String(amount) !== invoice.amountTinybars) {
      return NextResponse.json(
        { success: false, error: "Payment amount does not match the invoice", code: "AMOUNT_MISMATCH" },
        { status: 400 }
      );
    }

    const result = await executeX402Payment({
      invoiceId,
      payee: invoice.payee,
      amountTinybars: invoice.amountTinybars,
    });

    if (!result.success || !result.txId) {
      return NextResponse.json(result, { status: 400 });
    }

    recordInvoiceSettlement(
      result.invoiceId,
      result.txId,
      "LIVE_ONCHAIN",
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
