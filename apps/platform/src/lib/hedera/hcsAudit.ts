import {
  Client,
  TopicId,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { getOperatorClient, isOperatorConfigured } from "./client";
import { hashscanTxUrl } from "./format";

export interface HcsAuditEventPayload {
  event: string;
  invoiceId?: string;
  txId?: string | null;
  payer?: string;
  service?: string;
  amount?: string;
  propertyId?: string;
  addressHash?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface HcsAuditReceipt {
  topicId: string | null;
  sequenceNumber: number | null;
  consensusTimestamp: string;
  txId: string | null;
  hashscanUrl: string | null;
  event: string;
  provenance: "LIVE_ONCHAIN" | "SIMULATED";
}

export interface LogHcsAuditOptions {
  requireLive?: boolean;
}

const HEDERA_ENTITY_ID_REGEX = /^\d+\.\d+\.[1-9]\d*$/;

export function isValidTopicId(topicId: unknown): topicId is string {
  if (typeof topicId !== "string") return false;
  return HEDERA_ENTITY_ID_REGEX.test(topicId.trim());
}

let cachedTopicId: string | null = null;

export function getAuditTopicId(): string | null {
  if (cachedTopicId && isValidTopicId(cachedTopicId)) {
    return cachedTopicId;
  }
  const configured = process.env.HEDERA_AUDIT_TOPIC_ID?.trim();
  if (!configured) return null;

  if (!isValidTopicId(configured)) {
    throw new Error(
      `Invalid HEDERA_AUDIT_TOPIC_ID format: "${configured}". Expected Hedera entity ID format (e.g. 0.0.12345).`
    );
  }

  const operatorId = process.env.HEDERA_OPERATOR_ID?.trim();
  if (operatorId && configured === operatorId) {
    throw new Error(
      `Unsafe configuration: HEDERA_AUDIT_TOPIC_ID (${configured}) is identical to HEDERA_OPERATOR_ID. Operator account and HCS audit topic must be configured separately.`
    );
  }

  cachedTopicId = configured;
  return cachedTopicId;
}

export function requireLiveAuditTopic(): string {
  const isLive = (process.env.PRISM_CONTRACT_MODE ?? "SIMULATED").toUpperCase() === "LIVE";
  if (!isLive) {
    const topicId = getAuditTopicId();
    return topicId ?? "";
  }

  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID?.trim();
  if (!topicId) {
    throw new Error(
      "LIVE mode requires HEDERA_AUDIT_TOPIC_ID to be configured in environment. No audit topic ID found."
    );
  }

  if (!isValidTopicId(topicId)) {
    throw new Error(
      `Invalid HEDERA_AUDIT_TOPIC_ID format for LIVE mode: "${topicId}". Expected Hedera entity ID format (e.g. 0.0.12345).`
    );
  }

  const operatorId = process.env.HEDERA_OPERATOR_ID?.trim();
  if (operatorId && topicId === operatorId) {
    throw new Error(
      `Unsafe configuration: HEDERA_AUDIT_TOPIC_ID (${topicId}) cannot match HEDERA_OPERATOR_ID. Operator account and audit topic must be distinct.`
    );
  }

  cachedTopicId = topicId;
  return topicId;
}

export async function getOrCreateAuditTopic(client?: Client): Promise<string | null> {
  const existing = getAuditTopicId();
  if (existing) return existing;

  // Only attempt dynamic on-chain topic creation if operator is fully configured
  if (isOperatorConfigured()) {
    try {
      const hederaClient = client ?? getOperatorClient();
      const createTx = await new TopicCreateTransaction()
        .setTopicMemo("LiquidityStream x402 Verifiable Audit Trail")
        .execute(hederaClient);
      const receipt = await createTx.getReceipt(hederaClient);
      if (receipt.topicId) {
        cachedTopicId = receipt.topicId.toString();
        return cachedTopicId;
      }
    } catch (err) {
      console.warn("Failed to dynamically create HCS audit topic on Hedera:", err);
    }
  }

  // Never silently fall back to a hardcoded topic ID
  return null;
}

export async function logHcsAuditEvent(
  payload: HcsAuditEventPayload,
  options?: LogHcsAuditOptions
): Promise<HcsAuditReceipt> {
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const isLiveRequested =
    Boolean(options?.requireLive) ||
    (process.env.PRISM_CONTRACT_MODE ?? "SIMULATED").toUpperCase() === "LIVE";

  const topicIdStr = await getOrCreateAuditTopic();

  if (!topicIdStr) {
    if (isLiveRequested) {
      throw new Error(
        "Live HCS audit failed: HEDERA_AUDIT_TOPIC_ID is not configured and live topic creation was unavailable."
      );
    }
    // Explicitly enter SIMULATED mode without hardcoded topic
    return {
      topicId: null,
      sequenceNumber: null,
      consensusTimestamp: timestamp,
      txId: null,
      hashscanUrl: null,
      event: payload.event,
      provenance: "SIMULATED",
    };
  }

  const fullPayload = {
    ...payload,
    timestamp,
    standard: "x402-hcs-audit-v1",
  };
  const messageStr = JSON.stringify(fullPayload);

  try {
    const client = getOperatorClient();
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicIdStr))
      .setMessage(messageStr)
      .execute(client);

    const record = await tx.getRecord(client);
    const sequenceNumber = record.receipt.topicSequenceNumber
      ? Number(record.receipt.topicSequenceNumber)
      : 1;
    const consensusTimestamp = record.consensusTimestamp
      ? record.consensusTimestamp.toDate().toISOString()
      : timestamp;
    const txIdStr = tx.transactionId.toString();

    return {
      topicId: topicIdStr,
      sequenceNumber,
      consensusTimestamp,
      txId: txIdStr,
      hashscanUrl: hashscanTxUrl(txIdStr),
      event: payload.event,
      provenance: "LIVE_ONCHAIN",
    };
  } catch (error) {
    if (isLiveRequested) {
      throw new Error(
        `Live HCS audit message submission failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      topicId: topicIdStr,
      sequenceNumber: null,
      consensusTimestamp: timestamp,
      txId: null,
      hashscanUrl: null,
      event: payload.event,
      provenance: "SIMULATED",
    };
  }
}

export function _resetAuditTopicCacheForTesting(): void {
  cachedTopicId = null;
}

export function _setCachedTopicIdForTesting(topicId: string | null): void {
  cachedTopicId = topicId;
}
