import {
  AccountId,
  AccountBalanceQuery,
  Hbar,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  getOperatorClient,
  getOperatorId,
  getOperatorKey,
  isOperatorConfigured,
} from "../hedera/client";
import { hashscanTxUrl } from "../hedera/format";

export interface SettleRequestParams {
  invoiceId: string;
  payee: string;
  amountTinybars: string | bigint;
}

export interface SettleResult {
  success: boolean;
  txId: string | null;
  hashscanUrl: string | null;
  provenance: "LIVE_ONCHAIN";
  status: "CONFIRMED" | "FAILED";
  invoiceId: string;
  amountTinybars: string;
  error?: string;
  code?: string;
}

const HEDERA_ACCOUNT_REGEX = /^\d+\.\d+\.\d+$/;

export async function executeX402Payment(params: SettleRequestParams): Promise<SettleResult> {
  const invoiceId = params.invoiceId;
  if (!invoiceId) {
    return {
      success: false,
      txId: null,
      hashscanUrl: null,
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      invoiceId: "",
      amountTinybars: "0",
      error: "Missing x402 invoice ID.",
      code: "MISSING_INVOICE",
    };
  }
  const payeeStr = (params.payee || "").trim();

  // 1. Validate recipient account format
  if (!HEDERA_ACCOUNT_REGEX.test(payeeStr)) {
    return {
      success: false,
      txId: null,
      hashscanUrl: null,
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      invoiceId,
      amountTinybars: "0",
      error: `Invalid recipient account ID: "${payeeStr}". Expected format: 0.0.x`,
      code: "INVALID_RECIPIENT",
    };
  }

  // 2. Validate amount
  let amountBigInt: bigint;
  try {
    amountBigInt = BigInt(String(params.amountTinybars));
    if (amountBigInt <= BigInt(0)) {
      throw new Error("Amount must be positive");
    }
  } catch {
    return {
      success: false,
      txId: null,
      hashscanUrl: null,
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      invoiceId,
      amountTinybars: "0",
      error: `Invalid payment amount: "${params.amountTinybars}". Must be positive integer tinybars.`,
      code: "INVALID_AMOUNT",
    };
  }

  // 3. Fail-closed: Ensure Hedera operator is configured for real live execution
  const isLiveConfigured = isOperatorConfigured();
  if (!isLiveConfigured) {
    return {
      success: false,
      txId: null,
      hashscanUrl: null,
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      invoiceId,
      amountTinybars: amountBigInt.toString(),
      error: "Hedera operator credentials are not configured in environment (HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY). Real x402 settlement unavailable.",
      code: "HEDERA_OPERATOR_UNCONFIGURED",
    };
  }

  // 4. Perform actual on-chain CryptoTransferTransaction
  try {
    const client = getOperatorClient();
    const operatorId = getOperatorId();
    const operatorKey = getOperatorKey();

    // Verify balance first
    try {
      const balance = await new AccountBalanceQuery()
        .setAccountId(operatorId)
        .execute(client);
      const availableTinybars = BigInt(balance.hbars.toTinybars().toString());
      if (availableTinybars < amountBigInt) {
        return {
          success: false,
          txId: null,
          hashscanUrl: null,
          provenance: "LIVE_ONCHAIN",
          status: "FAILED",
          invoiceId,
          amountTinybars: amountBigInt.toString(),
          error: `Insufficient operator balance. Available: ${balance.hbars.toString()}, required: ${Hbar.fromTinybars(amountBigInt.toString()).toString()}`,
          code: "INSUFFICIENT_BALANCE",
        };
      }
    } catch (balErr: any) {
      return {
        success: false,
        txId: null,
        hashscanUrl: null,
        provenance: "LIVE_ONCHAIN",
        status: "FAILED",
        invoiceId,
        amountTinybars: amountBigInt.toString(),
        error: `Failed to verify operator account balance: ${balErr.message || String(balErr)}`,
        code: "BALANCE_CHECK_FAILED",
      };
    }

    // Construct CryptoTransferTransaction
    const transferTx = new TransferTransaction()
      .addHbarTransfer(operatorId, Hbar.fromTinybars((-amountBigInt).toString()))
      .addHbarTransfer(AccountId.fromString(payeeStr), Hbar.fromTinybars(amountBigInt.toString()))
      .setTransactionMemo(`x402:${invoiceId}`);

    const frozen = transferTx.freezeWith(client);
    const signed = await frozen.sign(operatorKey);
    const response = await signed.execute(client);
    const receipt = await response.getReceipt(client);

    const receiptStatus = receipt.status.toString();
    if (receiptStatus !== "SUCCESS") {
      return {
        success: false,
        txId: null,
        hashscanUrl: null,
        provenance: "LIVE_ONCHAIN",
        status: "FAILED",
        invoiceId,
        amountTinybars: amountBigInt.toString(),
        error: `Hedera CryptoTransfer failed on-chain with receipt status: ${receiptStatus}`,
        code: "TRANSACTION_FAILURE",
      };
    }

    const txId = response.transactionId.toString();
    return {
      success: true,
      txId,
      hashscanUrl: hashscanTxUrl(txId),
      provenance: "LIVE_ONCHAIN",
      status: "CONFIRMED",
      invoiceId,
      amountTinybars: amountBigInt.toString(),
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    const timedOut = /timeout|timed out|deadline/i.test(message);
    return {
      success: false,
      txId: null,
      hashscanUrl: null,
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      invoiceId,
      amountTinybars: amountBigInt.toString(),
      error: timedOut
        ? "Hedera settlement timed out while communicating with network consensus nodes."
        : `Hedera payment execution error: ${message}`,
      code: timedOut ? "SETTLEMENT_TIMEOUT" : "EXECUTION_ERROR",
    };
  }
}
