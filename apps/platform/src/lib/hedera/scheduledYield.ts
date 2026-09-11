import {
  AccountId,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleId,
  ScheduleInfoQuery,
  Timestamp,
  TokenId,
  TransferTransaction,
  Hbar,
} from "@hiero-ledger/sdk";
import { getOperatorClient, getOperatorId, getOperatorKey } from "./client";
import { hashscanTxUrl } from "./format";

export interface ScheduledYieldPayoutResult {
  scheduleId: string;
  propertyId: string;
  tokenId: string;
  recipientCount: number;
  totalPayoutAmount: number;
  scheduledExecutionTime: string;
  txId: string | null;
  hashscanUrl: string | null;
  provenance: "LIVE_ONCHAIN" | "SIMULATED";
}

export interface YieldRecipient {
  accountId: string;
  amount: number;
}

/**
 * Creates a Hedera Scheduled Transaction (HIP-423) that will execute yield distribution
 * to property token holders at a designated future consensus timestamp.
 */
export async function scheduleRecurringYieldPayout(
  propertyId: string,
  payoutTokenId: string, // HTS token ID or "HBAR"
  recipients: YieldRecipient[],
  executionTime: Date
): Promise<ScheduledYieldPayoutResult> {
  const totalAmount = recipients.reduce((sum, r) => sum + r.amount, 0);

  try {
    const client = getOperatorClient();
    const operatorId = getOperatorId();
    const operatorKey = getOperatorKey();

    const transferTx = new TransferTransaction();

    if (payoutTokenId.toUpperCase() === "HBAR") {
      transferTx.addHbarTransfer(operatorId, new Hbar(-totalAmount));
      for (const r of recipients) {
        transferTx.addHbarTransfer(AccountId.fromString(r.accountId), new Hbar(r.amount));
      }
    } else {
      const tokenId = TokenId.fromString(payoutTokenId);
      transferTx.addTokenTransfer(tokenId, operatorId, -totalAmount);
      for (const r of recipients) {
        transferTx.addTokenTransfer(tokenId, AccountId.fromString(r.accountId), r.amount);
      }
    }

    const expirationTimestamp = Timestamp.fromDate(executionTime);
    const scheduleTx = await new ScheduleCreateTransaction()
      .setScheduledTransaction(transferTx)
      .setScheduleMemo(`LiquidityStream: Yield payout for property ${propertyId}`)
      .setAdminKey(operatorKey)
      .setPayerAccountId(operatorId)
      .setExpirationTime(expirationTimestamp)
      .setWaitForExpiry(true)
      .execute(client);

    const receipt = await scheduleTx.getReceipt(client);
    const scheduleIdStr = receipt.scheduleId?.toString() ?? "0.0.unknown";
    const txIdStr = scheduleTx.transactionId.toString();

    return {
      scheduleId: scheduleIdStr,
      propertyId,
      tokenId: payoutTokenId,
      recipientCount: recipients.length,
      totalPayoutAmount: totalAmount,
      scheduledExecutionTime: executionTime.toISOString(),
      txId: txIdStr,
      hashscanUrl: hashscanTxUrl(txIdStr),
      provenance: "LIVE_ONCHAIN",
    };
  } catch (error) {
    return {
      scheduleId: "SIMULATED_SCHEDULE",
      propertyId,
      tokenId: payoutTokenId,
      recipientCount: recipients.length,
      totalPayoutAmount: totalAmount,
      scheduledExecutionTime: executionTime.toISOString(),
      txId: null,
      hashscanUrl: null,
      provenance: "SIMULATED",
    };
  }
}
