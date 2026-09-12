// Kept as a TS string (rather than read from a .sql file at runtime) so Next.js's file tracer
// doesn't have to follow a dynamic fs.readFile() call into the bundle — see the "Encountered
// unexpected file in NFT list" build warning this used to produce.

// Local application database. This never touches on-chain state directly; it mirrors/caches
// what we did on Hedera plus off-chain compliance metadata (World ID verification,
// liveness check-ins) that doesn't belong on the ledger.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  id                        TEXT PRIMARY KEY,      -- Hedera token id or EVM contract address
  blockchain                TEXT NOT NULL DEFAULT 'HEDERA', -- HEDERA | EVM
  network                   TEXT NOT NULL DEFAULT 'testnet', -- testnet | sepolia
  name                      TEXT NOT NULL,
  symbol                    TEXT NOT NULL,
  token_type                TEXT NOT NULL,          -- FUNGIBLE | NFT
  decimals                  INTEGER NOT NULL DEFAULT 0,
  initial_supply            TEXT NOT NULL DEFAULT '0',
  supply_type               TEXT NOT NULL,          -- FINITE | INFINITE
  max_supply                TEXT,
  treasury_account_id       TEXT NOT NULL,
  asset_category             TEXT,                   -- securities | real-estate | invoices | carbon-credits | commodities | other
  memo                      TEXT,

  -- compliance controls (checkboxes at creation time)
  kyc_required               INTEGER NOT NULL DEFAULT 0,
  freeze_default             INTEGER NOT NULL DEFAULT 0,
  wipe_enabled                INTEGER NOT NULL DEFAULT 0,
  pause_enabled               INTEGER NOT NULL DEFAULT 0,
  world_id_required           INTEGER NOT NULL DEFAULT 0,
  world_id_selfie_check       INTEGER NOT NULL DEFAULT 0,
  world_id_minimum_age        INTEGER,
  world_id_nationality        TEXT,
  liveness_enabled            INTEGER NOT NULL DEFAULT 0,
  liveness_period_seconds     INTEGER,

  -- custom fee schedule
  custom_fee_enabled          INTEGER NOT NULL DEFAULT 0,
  custom_fee_config           TEXT,                   -- JSON blob, see types/index.ts CustomFeeConfig

  -- which HTS keys were actually set on the token (all mirror the operator key in this build)
  has_admin_key                INTEGER NOT NULL DEFAULT 0,
  has_kyc_key                  INTEGER NOT NULL DEFAULT 0,
  has_freeze_key                INTEGER NOT NULL DEFAULT 0,
  has_wipe_key                  INTEGER NOT NULL DEFAULT 0,
  has_pause_key                 INTEGER NOT NULL DEFAULT 0,
  has_supply_key                INTEGER NOT NULL DEFAULT 0,
  has_fee_schedule_key          INTEGER NOT NULL DEFAULT 0,

  paused                     INTEGER NOT NULL DEFAULT 0,
  create_tx_id                TEXT,
  provenance                  TEXT NOT NULL DEFAULT 'LIVE_ONCHAIN',
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holders (
  token_id                    TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  account_id                  TEXT NOT NULL,          -- Hedera account id, e.g. "0.0.98765"
  evm_address                 TEXT,

  associated                  INTEGER NOT NULL DEFAULT 0,
  kyc_granted                 INTEGER NOT NULL DEFAULT 0,
  frozen                      INTEGER NOT NULL DEFAULT 0,
  allowance_granted            INTEGER NOT NULL DEFAULT 0,   -- holder approved a token allowance to treasury (needed for scheduled auto-reclaim)

  world_id_verified_at          TEXT,
  world_id_selfie_verified_at   TEXT,
  world_id_identity_verified_at TEXT,

  last_checkin_at              TEXT,
  active_schedule_id            TEXT,                  -- pending Hedera ScheduleId for auto-reclaim, if any
  active_schedule_expires_at    TEXT,
  liveness_reclaim_status       TEXT NOT NULL DEFAULT 'IDLE', -- IDLE | PROCESSING | FAILED | COMPLETED
  liveness_reclaim_error        TEXT,
  liveness_reclaim_attempted_at TEXT,

  status                      TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | WHITELISTED | REVOKED
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (token_id, account_id)
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id      TEXT NOT NULL,
  account_id    TEXT,
  type          TEXT NOT NULL,   -- see types/index.ts EventType
  detail        TEXT,            -- JSON blob
  tx_id         TEXT,
  hashscan_url  TEXT,
  provenance    TEXT NOT NULL DEFAULT 'LIVE_ONCHAIN',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A holder can make one durable request per token. The amount is fixed server-side when
-- the request is created; Hermes never gets to choose it. Keeping the request in SQLite
-- before invoking Hermes makes webhook outages recoverable and prevents double sends.
CREATE TABLE IF NOT EXISTS token_requests (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id                 TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  account_id               TEXT NOT NULL,
  amount_base_units        TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  trigger_status           TEXT NOT NULL DEFAULT 'NOT_TRIGGERED',
  trigger_error            TEXT,
  processing_error         TEXT,
  rejection_reason         TEXT,
  fulfillment_tx_id        TEXT,
  fulfillment_hashscan_url TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (token_id, account_id)
);

-- Raw IDKit results are held only while an agent-triggered World verification is pending.
-- They are cleared after a definitive result. The sanitized fields are safe to expose through
-- the World ID MCP; proof_json is intentionally never returned by repository read methods.
CREATE TABLE IF NOT EXISTS world_id_verifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id          TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  check_kind        TEXT NOT NULL,       -- selfie | identity
  status            TEXT NOT NULL DEFAULT 'PENDING',
  action            TEXT NOT NULL,
  expected_signal   TEXT NOT NULL,
  proof_json        TEXT,
  proof_hash        TEXT,
  credential        TEXT,
  nullifier_hash    TEXT,
  error_code        TEXT,
  error_detail      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL DEFAULT (datetime('now', '+30 minutes')),
  verified_at       TEXT,
  FOREIGN KEY (token_id, account_id)
    REFERENCES holders(token_id, account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS judge_workflow_state (
  id                          TEXT PRIMARY KEY DEFAULT 'current',
  current_step                INTEGER NOT NULL DEFAULT 1,

  step1_status                TEXT NOT NULL DEFAULT 'READY',
  property_id                 TEXT,
  property_address            TEXT,
  oracle_verified             INTEGER NOT NULL DEFAULT 0,
  oracle_dpv                  TEXT,
  oracle_payment_tx           TEXT,
  oracle_hcs_topic            TEXT,
  oracle_hcs_seq              INTEGER,
  oracle_hcs_tx               TEXT,
  oracle_provenance           TEXT DEFAULT 'LIVE_ONCHAIN',
  oracle_ownership_disclaimer TEXT DEFAULT 'address deliverability verification is NOT proof of property ownership',
  oracle_timestamp            TEXT,
  oracle_error                TEXT,

  step2_status                TEXT NOT NULL DEFAULT 'LOCKED',
  rent_deposited_amount       REAL DEFAULT 0,
  rent_deposit_tx             TEXT,
  rent_vault_address          TEXT,
  rent_hcs_seq                INTEGER,
  rent_timestamp              TEXT,
  rent_error                  TEXT,

  step3_status                TEXT NOT NULL DEFAULT 'LOCKED',
  claim_tx                    TEXT,
  claim_amount                REAL DEFAULT 0,
  claim_recipient             TEXT,
  claim_hcs_seq               INTEGER,
  claim_timestamp             TEXT,
  claim_error                 TEXT,

  step4_status                TEXT NOT NULL DEFAULT 'LOCKED',
  token_id                    TEXT,
  token_symbol                TEXT,
  token_network               TEXT,
  token_total_supply          TEXT,
  workspace_inspected_at      TEXT,
  step4_error                 TEXT,

  step5_status                TEXT NOT NULL DEFAULT 'LOCKED',
  world_id_verified           INTEGER NOT NULL DEFAULT 0,
  world_id_nullifier          TEXT,
  world_id_credential_type    TEXT,
  world_id_shares_claimed     REAL DEFAULT 0,
  world_id_claim_tx           TEXT,
  world_id_timestamp          TEXT,
  world_id_error              TEXT,

  step6_status                TEXT NOT NULL DEFAULT 'LOCKED',
  cap_table_holder_count      INTEGER DEFAULT 0,
  consensus_ledger_seq_count  INTEGER DEFAULT 0,
  audit_confirmed_at          TEXT,
  step6_error                 TEXT,

  step7_status                TEXT NOT NULL DEFAULT 'LOCKED',
  hermes_session_id           TEXT,
  hermes_execution_id         TEXT,
  hermes_tx_hash              TEXT,
  hermes_action               TEXT,
  hermes_timestamp            TEXT,
  hermes_error                TEXT,

  step8_status                TEXT NOT NULL DEFAULT 'LOCKED',
  compromise_attempt_action   TEXT,
  compromise_blocked          INTEGER NOT NULL DEFAULT 0,
  compromise_rejection_code   TEXT,
  compromise_rejection_reason TEXT,
  compromise_timestamp        TEXT,
  step8_error                 TEXT,

  step9_status                TEXT NOT NULL DEFAULT 'LOCKED',
  subgraph_url                TEXT,
  subgraph_status             TEXT,
  subgraph_indexed_block      INTEGER,
  subgraph_query_result       TEXT,
  subgraph_error              TEXT,
  subgraph_timestamp          TEXT,

  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oracle_verifications (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id                 TEXT NOT NULL,
  normalized_address          TEXT NOT NULL,
  payment_proof               TEXT NOT NULL,
  payment_status              TEXT NOT NULL,
  usps_metadata               TEXT,
  dpv_result                  TEXT NOT NULL,
  hcs_topic_id                TEXT,
  hcs_sequence_number         INTEGER,
  hcs_tx_id                   TEXT,
  consensus_timestamp         TEXT,
  network                     TEXT NOT NULL DEFAULT 'hedera-testnet',
  provenance                  TEXT NOT NULL DEFAULT 'LIVE_ONCHAIN',
  ownership_disclaimer        TEXT NOT NULL DEFAULT 'address deliverability verification is NOT proof of property ownership',
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_holders_token ON holders(token_id);
CREATE INDEX IF NOT EXISTS idx_events_token ON events(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_requests_status ON token_requests(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_token_requests_token ON token_requests(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_id_verifications_status
  ON world_id_verifications(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_world_id_verifications_holder
  ON world_id_verifications(token_id, account_id, check_kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_verifications_property
  ON oracle_verifications(property_id, created_at DESC);
`;
