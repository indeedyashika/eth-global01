import {
  AccountId,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleId,
  ScheduleInfoQuery,
  Timestamp,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { getOperatorClient, getOperatorId, getOperatorKey } from "./client";
import { hashscanTxUrl } from "./format";
import { getTokenBalance } from "./tokenService";

// Liveness / auto-reclaim mechanism
// ----------------------------------
// A holder who wants to receive tokens under a "liveness-gated" token approves a token
// allowance to the treasury (AccountAllowanceApproveTransaction, signed by the holder's own
// wallet — see hooks/useWalletConnect.ts). That lets the treasury move tokens *out* of the
// holder's account without needing the holder's signature at the moment of the move, via an
// "approved transfer" (TransferTransaction.addApprovedTokenTransfer).
//
// We use that to schedule a long-term Hedera Scheduled Transaction (HIP-423:
// setExpirationTime + setWaitForExpiry(true)) that auto-executes the reclaim transfer at a
// future consensus time — no polling/cron required. The operator's signature (as the
// spender/treasury, the only required signer for an approved transfer) is attached at
// creation time, so the network just waits until the expiry and fires it.
//
// Caveat: a scheduled transaction's amount is fixed at creation time, so this captures the
// holder's *current* balance as the reclaim amount. Checking in (or any admin action that
// should refresh the reclaim) deletes the old schedule and creates a new one against the
// then-current balance. Hedera also caps how far in the future an expiration can be set
// (SCHEDULE_EXPIRY_TOO_LONG if too far out) — see README for the practical ceiling.

export interface ScheduleReclaimResult {
  scheduleId: string;
  amount: number;
  expiresAt: string;
  txId: string;
  hashscanUrl: string;
}

export interface ScheduleReclaimStatus {
  executedAt: string | null;
  deletedAt: string | null;
}

export async function scheduleAutoReclaim(
  tokenId: string,
  holderAccountId: string,
  expiresAt: Date
): Promise<ScheduleReclaimResult> {
  const client = getOperatorClient();
  const operatorId = getOperatorId();
  const operatorKey = getOperatorKey();

  const amount = await getTokenBalance(tokenId, holderAccountId);
  if (amount <= 0) {
    throw new Error("Holder has no balance of this token; nothing to schedule for reclaim.");
  }

  const innerTransfer = new TransferTransaction()
    .addApprovedTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(holderAccountId), -amount)
    .addTokenTransfer(TokenId.fromString(tokenId), operatorId, amount);

  const scheduleTx = new ScheduleCreateTransaction()
    .setScheduledTransaction(innerTransfer)
    .setAdminKey(operatorKey.publicKey) // lets us delete/replace the schedule on check-in
    .setPayerAccountId(operatorId)
    .setScheduleMemo(`auto-reclaim ${tokenId} <- ${holderAccountId} (liveness expired)`)
    .setExpirationTime(Timestamp.fromDate(expiresAt))
    .setWaitForExpiry(true)
    .freezeWith(client);

  // Signing the ScheduleCreate with the operator key also satisfies the operator's required
  // signature on the *inner* transfer (operator is the spender using the holder's allowance),
  // so the schedule is fully signed already and will simply wait for its expiration time.
  const signed = await scheduleTx.sign(operatorKey);
  const response = await signed.execute(client);
  const receipt = await response.getReceipt(client);
  const scheduleId = receipt.scheduleId!.toString();
  const txId = response.transactionId.toString();

  return { scheduleId, amount, expiresAt: expiresAt.toISOString(), txId, hashscanUrl: hashscanTxUrl(txId) };
}

export async function cancelScheduledReclaim(scheduleId: string): Promise<void> {
  const client = getOperatorClient();
  const operatorKey = getOperatorKey();
  try {
    const tx = await new ScheduleDeleteTransaction()
      .setScheduleId(ScheduleId.fromString(scheduleId))
      .freezeWith(client)
      .sign(operatorKey);
    const response = await tx.execute(client);
    await response.getReceipt(client);
  } catch (err) {
    // Already executed or expired schedules can't be deleted (INVALID_SCHEDULE_ID /
    // SCHEDULE_ALREADY_EXECUTED) — that's fine, there's nothing left to cancel.
    const message = err instanceof Error ? err.message : String(err);
    if (!/INVALID_SCHEDULE_ID|SCHEDULE_ALREADY/i.test(message)) throw err;
  }
}

export async function getScheduledReclaimStatus(
  scheduleId: string
): Promise<ScheduleReclaimStatus> {
  const info = await new ScheduleInfoQuery()
    .setScheduleId(ScheduleId.fromString(scheduleId))
    .execute(getOperatorClient());
  return {
    executedAt: info.executed?.toDate().toISOString() ?? null,
    deletedAt: info.deleted?.toDate().toISOString() ?? null,
  };
}
