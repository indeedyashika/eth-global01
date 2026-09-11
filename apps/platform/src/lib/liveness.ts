import {
  claimLivenessReclaim,
  getHolder,
  getToken,
  insertEvent,
  listHolders,
  listTokens,
  updateHolder,
} from "@/lib/db/repo";
import {
  cancelScheduledReclaim,
  getScheduledReclaimStatus,
  scheduleAutoReclaim,
} from "@/lib/hedera/scheduleService";
import {
  freezeAccount,
  getTokenBalance,
  reclaimViaAllowanceNow,
  revokeKyc,
} from "@/lib/hedera/tokenService";
import type { HolderRecord, TokenRecord } from "@/types";
import {
  getEvmTokenBalance,
  reclaimEvmViaAllowance,
  setEvmApproved,
  setEvmFrozen,
} from "@/lib/evm/client";

export const MIN_LIVENESS_PERIOD_SECONDS = 60;
// Hedera accepts expirations up to 62 days. Keep a two-day margin so clock skew and
// verification/transfer latency cannot turn a valid policy into SCHEDULE_EXPIRY_TOO_LONG.
export const MAX_ONCHAIN_LIVENESS_PERIOD_SECONDS = 60 * 24 * 60 * 60;
const SCHEDULE_EXECUTION_GRACE_MS = 15_000;

export type LivenessArmResult =
  | { mode: "disabled" | "worker" | "waiting-for-allowance" | "waiting-for-balance" | "expired" }
  | { mode: "scheduled"; scheduleId: string; expiresAt: string };

export function livenessDeadline(
  verifiedAt: string,
  periodSeconds: number
): Date {
  return new Date(new Date(verifiedAt).getTime() + periodSeconds * 1000);
}

/** Record a liveness refresh only after World has verified a fresh Selfie proof. A legacy
 * public "check in" request must never call this function. */
export async function recordVerifiedSelfieLiveness(
  tokenId: string,
  accountId: string,
  verifiedAt: string
): Promise<LivenessArmResult> {
  const token = getToken(tokenId);
  const holder = getHolder(tokenId, accountId);
  if (!token || !holder) throw new Error("The liveness token or holder no longer exists.");
  if (!token.compliance.livenessEnabled) return { mode: "disabled" };
  if (!token.compliance.worldIdSelfieCheck) {
    throw new Error("Recurring liveness requires World ID Selfie Check.");
  }
  if (holder.livenessReclaimStatus === "PROCESSING") {
    throw new Error("The expired token is already being reclaimed.");
  }

  if (holder.lastCheckinAt !== verifiedAt) {
    if (token.blockchain === "HEDERA" && holder.activeScheduleId) {
      await cancelScheduledReclaim(holder.activeScheduleId);
      insertEvent({
        tokenId,
        accountId,
        type: "CANCEL_RECLAIM",
        detail: { reason: "fresh World ID Selfie Check" },
      });
    }
    updateHolder(tokenId, accountId, {
      lastCheckinAt: verifiedAt,
      activeScheduleId: null,
      activeScheduleExpiresAt: null,
      livenessReclaimStatus: "IDLE",
      livenessReclaimError: null,
      livenessReclaimAttemptedAt: null,
    });
    insertEvent({
      tokenId,
      accountId,
      type: "CHECKIN",
      detail: { source: "World ID Selfie Check", verifiedAt },
    });
  }

  return armLivenessReclaim(tokenId, accountId);
}

/** Arm the on-chain safety net after a token reaches the holder. Longer policies are handled
 * by the internal expiry worker because Hedera schedules cannot be created over 62 days out. */
export async function armLivenessReclaim(
  tokenId: string,
  accountId: string
): Promise<LivenessArmResult> {
  const token = getToken(tokenId);
  const holder = getHolder(tokenId, accountId);
  if (!token || !holder) throw new Error("The liveness token or holder no longer exists.");
  const periodSeconds = token.compliance.livenessPeriodSeconds;
  if (!token.compliance.livenessEnabled || !periodSeconds) return { mode: "disabled" };
  if (!holder.lastCheckinAt) return { mode: "expired" };
  if (!holder.allowanceGranted) return { mode: "waiting-for-allowance" };
  if (token.blockchain === "EVM") return { mode: "worker" };
  if (holder.activeScheduleId && holder.activeScheduleExpiresAt) {
    return {
      mode: "scheduled",
      scheduleId: holder.activeScheduleId,
      expiresAt: holder.activeScheduleExpiresAt,
    };
  }

  const expiresAt = livenessDeadline(holder.lastCheckinAt, periodSeconds);
  if (expiresAt.getTime() <= Date.now()) return { mode: "expired" };
  if (periodSeconds > MAX_ONCHAIN_LIVENESS_PERIOD_SECONDS) {
    return { mode: "worker" };
  }

  try {
    const schedule = await scheduleAutoReclaim(tokenId, accountId, expiresAt);
    updateHolder(tokenId, accountId, {
      activeScheduleId: schedule.scheduleId,
      activeScheduleExpiresAt: schedule.expiresAt,
    });
    insertEvent({
      tokenId,
      accountId,
      type: "SCHEDULE_RECLAIM",
      detail: {
        amount: schedule.amount,
        expiresAt: schedule.expiresAt,
        source: "World ID Selfie Check",
      },
      txId: schedule.txId,
      hashscanUrl: schedule.hashscanUrl,
    });
    return {
      mode: "scheduled",
      scheduleId: schedule.scheduleId,
      expiresAt: schedule.expiresAt,
    };
  } catch (error) {
    if (error instanceof Error && /no balance/i.test(error.message)) {
      return { mode: "waiting-for-balance" };
    }
    // The deterministic worker remains the fallback if the network refuses a schedule.
    console.error("Unable to arm Hedera liveness schedule; worker fallback remains active", error);
    return { mode: "worker" };
  }
}

export interface LivenessSweepResult {
  tokenId: string;
  accountId: string;
  outcome: "reclaimed" | "scheduled-reclaim-confirmed" | "failed";
  error?: string;
}

/** Process expired holders. The amount and destination are always read from live platform and
 * Hedera state; callers cannot supply either financial parameter. */
export async function processExpiredLiveness(): Promise<LivenessSweepResult[]> {
  const results: LivenessSweepResult[] = [];
  for (const token of listTokens()) {
    if (!token.compliance.livenessEnabled || !token.compliance.livenessPeriodSeconds) continue;
    for (const holder of listHolders(token.id)) {
      if (holder.status !== "WHITELISTED" || holder.livenessState !== "EXPIRED") continue;
      // A failed approved transfer clears this flag. Wait for a new wallet-signed allowance
      // instead of submitting the same doomed Hedera transaction on every sweep.
      if (!holder.allowanceGranted) continue;

      if (holder.activeScheduleId && holder.activeScheduleExpiresAt) {
        const expiry = new Date(holder.activeScheduleExpiresAt).getTime();
        if (Date.now() < expiry + SCHEDULE_EXECUTION_GRACE_MS) continue;
      }
      if (!claimLivenessReclaim(token.id, holder.accountId)) continue;

      try {
        const outcome = await reclaimExpiredHolder(token, getHolder(token.id, holder.accountId)!);
        results.push({ tokenId: token.id, accountId: holder.accountId, outcome });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown liveness reclaim error";
        const allowanceMissing = /allowance|SPENDER_DOES_NOT_HAVE/i.test(message);
        updateHolder(token.id, holder.accountId, {
          ...(allowanceMissing ? { allowanceGranted: false } : {}),
          livenessReclaimStatus: "FAILED",
          livenessReclaimError: message,
        });
        results.push({ tokenId: token.id, accountId: holder.accountId, outcome: "failed", error: message });
      }
    }
  }
  return results;
}

async function reclaimExpiredHolder(
  token: TokenRecord,
  holder: HolderRecord
): Promise<"reclaimed" | "scheduled-reclaim-confirmed"> {
  let scheduledExecuted = false;
  if (token.blockchain === "HEDERA" && holder.activeScheduleId) {
    try {
      const schedule = await getScheduledReclaimStatus(holder.activeScheduleId);
      scheduledExecuted = !!schedule.executedAt;
      if (!scheduledExecuted && !schedule.deletedAt) {
        await cancelScheduledReclaim(holder.activeScheduleId);
      }
    } catch (error) {
      // Executed/expired schedules may no longer be queryable. The live balance below is the
      // authoritative result and determines whether a fallback transfer is still necessary.
      const message = error instanceof Error ? error.message : String(error);
      if (!/INVALID_SCHEDULE_ID|SCHEDULE_ALREADY|SCHEDULE_PENDING_EXPIRATION/i.test(message)) {
        throw error;
      }
    }
  }

  const remainingBalance = token.blockchain === "EVM"
    ? await getEvmTokenBalance(token.id, holder.accountId)
    : BigInt(await getTokenBalance(token.id, holder.accountId));
  let transferResult: Awaited<ReturnType<typeof reclaimViaAllowanceNow>> | Awaited<ReturnType<typeof reclaimEvmViaAllowance>> | null = null;
  if (remainingBalance > 0) {
    transferResult = token.blockchain === "EVM"
      ? await reclaimEvmViaAllowance(token.id, holder.accountId)
      : await reclaimViaAllowanceNow(token.id, holder.accountId);
  }

  // Revoke native access only after the approved transfer, otherwise KYC/freeze can block it.
  if (token.compliance.kycRequired && holder.kycGranted) {
    const result = token.blockchain === "EVM"
      ? await setEvmApproved(token.id, holder.accountId, false)
      : await revokeKyc(token.id, holder.accountId);
    insertEvent({
      tokenId: token.id,
      accountId: holder.accountId,
      type: "REVOKE_KYC",
      detail: { reason: "liveness expired" },
      txId: result.txId,
      hashscanUrl: result.hashscanUrl,
    });
  }
  if (token.compliance.freezeDefault && !holder.frozen) {
    const result = token.blockchain === "EVM"
      ? await setEvmFrozen(token.id, holder.accountId, true)
      : await freezeAccount(token.id, holder.accountId);
    insertEvent({
      tokenId: token.id,
      accountId: holder.accountId,
      type: "FREEZE",
      detail: { reason: "liveness expired" },
      txId: result.txId,
      hashscanUrl: result.hashscanUrl,
    });
  }

  updateHolder(token.id, holder.accountId, {
    kycGranted: token.compliance.kycRequired ? false : holder.kycGranted,
    frozen: token.compliance.freezeDefault ? true : holder.frozen,
    status: "REVOKED",
    activeScheduleId: null,
    activeScheduleExpiresAt: null,
    livenessReclaimStatus: "COMPLETED",
    livenessReclaimError: null,
  });
  insertEvent({
    tokenId: token.id,
    accountId: holder.accountId,
    type: "AUTO_RECLAIM_EXECUTED",
    detail: {
      reason: "World ID Selfie Check expired",
      amount: transferResult?.amount ?? remainingBalance.toString(),
      mechanism: transferResult
        ? token.blockchain === "EVM" ? "ERC-20 transferFrom allowance" : "allowance transfer"
        : "Hedera scheduled transfer",
    },
    txId: transferResult?.txId,
    hashscanUrl: transferResult?.hashscanUrl,
  });
  if (transferResult || !scheduledExecuted) return "reclaimed";
  return "scheduled-reclaim-confirmed";
}
