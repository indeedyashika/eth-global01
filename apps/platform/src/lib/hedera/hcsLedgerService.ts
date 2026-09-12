import { getDb } from "@/lib/db";
import { getAuditTopicId } from "./hcsAudit";

export interface HcsAuditRecord {
  id?: number;
  topicId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  txId: string;
  type: string;
  propertyId: string;
  actor: string;
  token: string;
  network: string;
  txLink: string;
  memo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AuthoritativeHcsLedger {
  topicId: string | null;
  records: HcsAuditRecord[];
  totalCount: number;
  configured: boolean;
}

interface DbHcsRecordRow {
  id: number;
  topic_id: string;
  sequence_number: number;
  consensus_timestamp: string;
  tx_id: string;
  event_type: string;
  property_id: string;
  actor: string;
  token_id: string;
  network: string;
  tx_link: string;
  memo: string | null;
  metadata_json: string | null;
  created_at: string;
}

function mapRowToRecord(row: DbHcsRecordRow): HcsAuditRecord {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {}
  }

  return {
    id: row.id,
    topicId: row.topic_id,
    sequenceNumber: Number(row.sequence_number),
    consensusTimestamp: row.consensus_timestamp,
    txId: row.tx_id,
    type: row.event_type,
    propertyId: row.property_id,
    actor: row.actor,
    token: row.token_id,
    network: row.network,
    txLink: row.tx_link,
    memo: row.memo,
    metadata,
    createdAt: row.created_at,
  };
}

/**
 * Persist an authoritative, verified HCS consensus record.
 * Throws if sequence number or topic ID is missing, or on conflict.
 */
export function persistHcsAuditRecord(record: {
  topicId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  txId: string;
  type: string;
  propertyId: string;
  actor: string;
  token: string;
  network: string;
  txLink: string;
  memo?: string | null;
  metadata?: Record<string, unknown> | null;
}): HcsAuditRecord {
  if (!record.topicId || !record.sequenceNumber || !record.consensusTimestamp || !record.txId) {
    throw new Error(
      "Cannot persist HCS audit record: topicId, sequenceNumber, consensusTimestamp, and txId are strictly required."
    );
  }

  const db = getDb();
  const metadataJson = record.metadata ? JSON.stringify(record.metadata) : null;

  db.prepare(`
    INSERT OR REPLACE INTO hcs_audit_records (
      topic_id,
      sequence_number,
      consensus_timestamp,
      tx_id,
      event_type,
      property_id,
      actor,
      token_id,
      network,
      tx_link,
      memo,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.topicId,
    record.sequenceNumber,
    record.consensusTimestamp,
    record.txId,
    record.type,
    record.propertyId,
    record.actor,
    record.token,
    record.network,
    record.txLink,
    record.memo || null,
    metadataJson
  );

  return {
    ...record,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Retrieve authoritative HCS audit records for a token or property.
 * Strictly queries verified HCS rows; never injects fabricated mock events.
 */
export function getAuthoritativeHcsLedger(filter?: {
  propertyId?: string;
  tokenId?: string;
  topicId?: string;
}): AuthoritativeHcsLedger {
  const configuredTopicId = getAuditTopicId();
  const db = getDb();

  const conditions: string[] = [];
  const params: any[] = [];

  if (filter?.topicId) {
    conditions.push("topic_id = ?");
    params.push(filter.topicId);
  }

  if (filter?.propertyId && filter?.tokenId) {
    conditions.push("(property_id = ? OR token_id = ? OR property_id = ? OR token_id = ?)");
    params.push(filter.propertyId, filter.tokenId, filter.tokenId, filter.propertyId);
  } else if (filter?.propertyId) {
    conditions.push("(property_id = ? OR token_id = ?)");
    params.push(filter.propertyId, filter.propertyId);
  } else if (filter?.tokenId) {
    conditions.push("(property_id = ? OR token_id = ?)");
    params.push(filter.tokenId, filter.tokenId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT * FROM hcs_audit_records
    ${whereClause}
    ORDER BY sequence_number ASC
  `;

  let rows: DbHcsRecordRow[] = [];
  try {
    rows = db.prepare(query).all(...params) as DbHcsRecordRow[];
  } catch (err) {
    console.warn("[getAuthoritativeHcsLedger] Query error:", err);
  }

  const records = rows.map(mapRowToRecord);

  return {
    topicId: configuredTopicId,
    records,
    totalCount: records.length,
    configured: Boolean(configuredTopicId),
  };
}

/**
 * Get count of authoritative verified HCS records.
 */
export function getHcsSequenceCount(filter?: {
  propertyId?: string;
  tokenId?: string;
  topicId?: string;
}): number {
  const ledger = getAuthoritativeHcsLedger(filter);
  return ledger.totalCount;
}
