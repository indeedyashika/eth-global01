import {
  Client,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { getOperatorClient, isOperatorConfigured } from "./client";
import { hashscanTxUrl } from "./format";
import { persistHcsAuditRecord } from "./hcsLedgerService";

export interface HcsAuditEventPayload {
  event: string;
  invoiceId?: string;
  txId?: string;
  payer?: string;
  actor?: string;
  service?: string;
  amount?: string;
  propertyId?: string;
  addressHash?: string;
  token?: string;
  network?: string;
  txLink?: string;
  memo?: string;
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
  provenance: "LIVE_ONCHAIN";
  status?: "CONFIRMED" | "FAILED";
  error?: string;
}

export interface LogHcsAuditOptions {
  requireLive?: boolean;
  throwOnFailure?: boolean;
  client?: Client;
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
  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID?.trim();
  if (!topicId) {
    throw new Error(
      "LIVE mode requires HEDERA_AUDIT_TOPIC_ID to be configured in environment. Live HCS audit failed: HEDERA_AUDIT_TOPIC_ID is not configured in environment. Explicit HCS audit topic ID is required."
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

export async function getOrCreateAuditTopic(_client?: Client): Promise<string | null> {
  const existing = getAuditTopicId();
  if (existing) return existing;
  return null;
}

export async function logHcsAuditEvent(
  payload: HcsAuditEventPayload,
  options?: LogHcsAuditOptions
): Promise<HcsAuditReceipt> {
  const shouldThrow = options?.throwOnFailure ?? options?.requireLive ?? false;

  let topicIdStr: string | null = null;
  try {
    topicIdStr = requireLiveAuditTopic();
  } catch (err) {
    if (shouldThrow) {
      throw err instanceof Error ? err : new Error(`Live HCS audit failed: ${String(err)}`);
    }
    return {
      topicId: null,
      sequenceNumber: null,
      consensusTimestamp: payload.timestamp ?? new Date().toISOString(),
      txId: null,
      hashscanUrl: null,
      event: payload.event,
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      error: err instanceof Error ? err.message : "HCS audit topic is not configured in environment.",
    };
  }

  const timestamp = payload.timestamp ?? new Date().toISOString();
  const fullPayload = {
    ...payload,
    timestamp,
    standard: "x402-hcs-audit-v1",
  };
  const messageStr = JSON.stringify(fullPayload);

  try {
    const client = options?.client ?? getOperatorClient();
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicIdStr))
      .setMessage(messageStr)
      .execute(client);

    const record = await tx.getRecord(client);

    // Retrieve and verify actual sequence number from Hedera Consensus Service
    const rawSeq = record.receipt.topicSequenceNumber;
    const sequenceNumber = rawSeq != null ? Number(rawSeq) : null;
    if (!sequenceNumber || sequenceNumber <= 0 || !Number.isFinite(sequenceNumber)) {
      throw new Error(
        `Hedera HCS consensus receipt did not return a valid sequence number for transaction ${tx.transactionId.toString()}`
      );
    }

    // Retrieve and verify actual consensus timestamp from Hedera consensus record
    if (!record.consensusTimestamp) {
      throw new Error(
        `Hedera HCS consensus receipt did not return a valid consensus timestamp for transaction ${tx.transactionId.toString()}`
      );
    }
    const consensusTimestamp = record.consensusTimestamp.toDate().toISOString();
    const txIdStr = tx.transactionId.toString();
    const hashscanUrl = hashscanTxUrl(txIdStr);

    // Persist to authoritative HCS audit records table
    const propertyId = payload.propertyId || payload.addressHash || "prop_456_oak_ave";
    const actor = payload.actor || payload.payer || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const token = payload.token || "OAK-RWA";
    const network = payload.network || "Hedera Testnet";
    const txLink = payload.txLink || hashscanUrl || `https://hashscan.io/testnet/transaction/${txIdStr}`;

    persistHcsAuditRecord({
      topicId: topicIdStr,
      sequenceNumber,
      consensusTimestamp,
      txId: txIdStr,
      type: payload.event,
      propertyId,
      actor,
      token,
      network,
      txLink,
      memo: payload.memo || null,
      metadata: payload.metadata || null,
    });

    return {
      topicId: topicIdStr,
      sequenceNumber,
      consensusTimestamp,
      txId: txIdStr,
      hashscanUrl,
      event: payload.event,
      provenance: "LIVE_ONCHAIN",
      status: "CONFIRMED",
    };
  } catch (error) {
    if (shouldThrow) {
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
      provenance: "LIVE_ONCHAIN",
      status: "FAILED",
      error: `HCS message submission failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function _resetAuditTopicCacheForTesting(): void {
  cachedTopicId = null;
}

export function _setCachedTopicIdForTesting(topicId: string | null): void {
  cachedTopicId = topicId;
}

