import {
  Client,
  TopicId,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { getOperatorClient, getOperatorId } from "./client";
import { hashscanTxUrl } from "./format";

export interface HcsAuditEventPayload {
  event: string;
  invoiceId?: string;
  txId?: string;
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

let cachedTopicId: string | null = process.env.HEDERA_AUDIT_TOPIC_ID ?? null;

export async function getOrCreateAuditTopic(client?: Client): Promise<string> {
  if (cachedTopicId) return cachedTopicId;

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
    // If running in offline test or mock environment
    console.warn("Hedera operator unavailable for live topic creation; using test topic: 0.0.4491823");
  }

  cachedTopicId = "0.0.4491823";
  return cachedTopicId;
}

export async function logHcsAuditEvent(payload: HcsAuditEventPayload): Promise<HcsAuditReceipt> {
  const timestamp = payload.timestamp ?? new Date().toISOString();
  const fullPayload = {
    ...payload,
    timestamp,
    standard: "x402-hcs-audit-v1",
  };

  const messageStr = JSON.stringify(fullPayload);
  const topicIdStr = await getOrCreateAuditTopic();

  try {
    const client = getOperatorClient();
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicIdStr))
      .setMessage(messageStr)
      .execute(client);

    const record = await tx.getRecord(client);
    const sequenceNumber = record.receipt.topicSequenceNumber ? Number(record.receipt.topicSequenceNumber) : 1;
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
