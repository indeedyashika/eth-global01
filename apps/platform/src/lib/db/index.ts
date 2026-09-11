import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";
import { serializeWorldIdProof } from "../worldid/proof";
import { seedDatabase } from "./seed";

// better-sqlite3 is synchronous and file-backed, which is perfect for a single-process
// Next.js server holding one Hedera operator/treasury account. Not meant to scale past a
// hackathon demo (no connection pooling / multi-instance story), see README for notes on
// swapping this for a hosted DB in production.

declare global {
  var __tokenizationDb: Database.Database | undefined;
}

function openDb(): Database.Database {
  const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  let dbPath = process.env.DATABASE_PATH;

  if (!dbPath) {
    dbPath = isServerless ? "/tmp/tokenization.db" : "./data/tokenization.db";
  }

  let resolved = path.isAbsolute(dbPath)
    ? dbPath
    : path.join(/* turbopackIgnore: true */ process.cwd(), dbPath);

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (err) {
    console.warn(`[DB] Cannot create directory ${path.dirname(resolved)}, falling back to /tmp/tokenization.db:`, err);
    resolved = "/tmp/tokenization.db";
  }

  const db = new Database(resolved);
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    try {
      db.pragma("journal_mode = DELETE");
    } catch {
      // Fallback in restricted serverless environments
    }
  }
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrateTokenChains(db);
  migrateTokenCompliancePolicy(db);
  migrateHolderWorldIdProofs(db);
  migrateHolderLivenessState(db);
  migrateWorldIdVerificationQueue(db);
  seedDatabase(db);

  return db;
}

/** Existing Railway volumes predate multi-chain support. Their rows are Hedera testnet
 * deployments and must retain that identity exactly after the migration. */
function migrateTokenChains(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(tokens)") as Array<{ name: string }>).map((column) => column.name)
  );
  if (!columns.has("blockchain")) {
    db.exec("ALTER TABLE tokens ADD COLUMN blockchain TEXT NOT NULL DEFAULT 'HEDERA'");
  }
  const addedNetwork = !columns.has("network");
  if (addedNetwork) {
    db.exec("ALTER TABLE tokens ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet'");
  }
  if (addedNetwork) {
    const configured = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase();
    const network = configured === "mainnet" || configured === "previewnet" ? configured : "testnet";
    db.prepare("UPDATE tokens SET network = ? WHERE blockchain = 'HEDERA'").run(network);
  }
}

/** Persist reclaim attempts so a restarted worker cannot double-submit or retry a broken
 * allowance every few seconds on an existing Railway volume. */
function migrateHolderLivenessState(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(holders)") as Array<{ name: string }>).map((column) => column.name)
  );
  const additions = [
    ["liveness_reclaim_status", "TEXT NOT NULL DEFAULT 'IDLE'"],
    ["liveness_reclaim_error", "TEXT"],
    ["liveness_reclaim_attempted_at", "TEXT"],
  ] as const;

  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE holders ADD COLUMN ${name} ${definition}`);
  }
}

/** Keep the proof queue compatible with existing Railway volumes. Nullifiers identify a person
 * for an RP action, so they must not be globally unique across every token. The proof digest is
 * retained instead to reject an exact payload replay while allowing a fresh check later. */
function migrateWorldIdVerificationQueue(db: Database.Database): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'world_id_verifications'")
    .get();
  if (!table) return;
  const columns = new Set(
    (db.pragma("table_info(world_id_verifications)") as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has("expires_at")) {
    db.exec("ALTER TABLE world_id_verifications ADD COLUMN expires_at TEXT");
  }
  if (!columns.has("proof_hash")) {
    db.exec("ALTER TABLE world_id_verifications ADD COLUMN proof_hash TEXT");
  }

  const unhashedProofs = db
    .prepare(
      `SELECT id, proof_json FROM world_id_verifications
       WHERE proof_json IS NOT NULL AND proof_hash IS NULL`
    )
    .all() as Array<{ id: number; proof_json: string }>;
  const saveProofHash = db.prepare(
    "UPDATE world_id_verifications SET proof_hash = ? WHERE id = ?"
  );
  db.transaction(() => {
    for (const proof of unhashedProofs) {
      let proofHash: string;
      try {
        proofHash = serializeWorldIdProof(JSON.parse(proof.proof_json)).proofHash;
      } catch {
        // A malformed legacy row must not prevent the application from starting. World will
        // reject it later, while its raw digest still prevents byte-for-byte resubmission.
        proofHash = createHash("sha256").update(proof.proof_json).digest("hex");
      }
      saveProofHash.run(proofHash, proof.id);
    }
  })();

  db.exec(`
    UPDATE world_id_verifications
    SET expires_at = datetime(created_at, '+30 minutes')
    WHERE expires_at IS NULL;

    -- The old index incorrectly treated one person verifying two different tokens as a replay.
    DROP INDEX IF EXISTS idx_world_id_verifications_nullifier;
    CREATE INDEX IF NOT EXISTS idx_world_id_verifications_proof
      ON world_id_verifications(proof_hash)
      WHERE proof_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_world_id_verifications_identity_scope
      ON world_id_verifications(token_id, check_kind, nullifier_hash, account_id)
      WHERE nullifier_hash IS NOT NULL;
  `);
}

/** Keep credential-specific proof state separate. A legacy mocked timestamp must never
 * satisfy a real Selfie or Identity Check after this migration. */
function migrateHolderWorldIdProofs(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(holders)") as Array<{ name: string }>).map((column) => column.name)
  );
  const additions = [
    ["world_id_selfie_verified_at", "TEXT"],
    ["world_id_identity_verified_at", "TEXT"],
  ] as const;

  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE holders ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    UPDATE holders
    SET world_id_verified_at = NULL
    WHERE world_id_verified_at IS NOT NULL
      AND (
        (world_id_selfie_verified_at IS NULL AND token_id IN (
          SELECT id FROM tokens WHERE world_id_selfie_check = 1
        ))
        OR
        (world_id_identity_verified_at IS NULL AND token_id IN (
          SELECT id FROM tokens
          WHERE world_id_minimum_age IS NOT NULL OR world_id_nationality IS NOT NULL
        ))
      )
  `);
}

/** CREATE TABLE IF NOT EXISTS does not add columns to Railway's existing persistent DB. */
function migrateTokenCompliancePolicy(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(tokens)") as Array<{ name: string }>).map((column) => column.name)
  );
  const additions = [
    ["world_id_selfie_check", "INTEGER NOT NULL DEFAULT 0"],
    ["world_id_minimum_age", "INTEGER"],
    ["world_id_nationality", "TEXT"],
  ] as const;

  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE tokens ADD COLUMN ${name} ${definition}`);
  }
}

// Cache the connection on `globalThis` so Next.js dev-mode module reloads (and route handler
// invocations, which each re-import this module) reuse a single open SQLite file handle.
export function getDb(): Database.Database {
  if (!globalThis.__tokenizationDb) {
    globalThis.__tokenizationDb = openDb();
  }
  return globalThis.__tokenizationDb;
}
