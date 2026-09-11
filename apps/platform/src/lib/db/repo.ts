import { getDb } from "./index";
import type {
  ComplianceOptions,
  CustomFeeConfig,
  EventRecord,
  EventType,
  HolderRecord,
  HolderStatus,
  LivenessReclaimStatus,
  TokenRecord,
  TokenRequestRecord,
  TokenRequestStatus,
  HermesTriggerStatus,
  TokenType,
  SupplyType,
  AssetCategory,
  WorldIdCheckKind,
  WorldIdVerificationRecord,
  WorldIdVerificationStatus,
  Blockchain,
  TokenNetwork,
} from "@/types";
import { tokenExplorerUrl } from "@/lib/chains";

// --- raw row shapes (sqlite gives us 0/1 for booleans and TEXT for everything else) ---

interface TokenRow {
  id: string;
  blockchain: string;
  network: string;
  name: string;
  symbol: string;
  token_type: string;
  decimals: number;
  initial_supply: string;
  supply_type: string;
  max_supply: string | null;
  treasury_account_id: string;
  asset_category: string | null;
  memo: string | null;
  kyc_required: number;
  freeze_default: number;
  wipe_enabled: number;
  pause_enabled: number;
  world_id_required: number;
  world_id_selfie_check: number;
  world_id_minimum_age: number | null;
  world_id_nationality: string | null;
  liveness_enabled: number;
  liveness_period_seconds: number | null;
  custom_fee_enabled: number;
  custom_fee_config: string | null;
  has_admin_key: number;
  has_kyc_key: number;
  has_freeze_key: number;
  has_wipe_key: number;
  has_pause_key: number;
  has_supply_key: number;
  has_fee_schedule_key: number;
  paused: number;
  create_tx_id: string | null;
  created_at: string;
}

interface HolderRow {
  token_id: string;
  account_id: string;
  evm_address: string | null;
  associated: number;
  kyc_granted: number;
  frozen: number;
  allowance_granted: number;
  world_id_verified_at: string | null;
  world_id_selfie_verified_at: string | null;
  world_id_identity_verified_at: string | null;
  last_checkin_at: string | null;
  active_schedule_id: string | null;
  active_schedule_expires_at: string | null;
  liveness_reclaim_status: string;
  liveness_reclaim_error: string | null;
  liveness_reclaim_attempted_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  token_id: string;
  account_id: string | null;
  type: string;
  detail: string | null;
  tx_id: string | null;
  hashscan_url: string | null;
  created_at: string;
}

interface TokenRequestRow {
  id: number;
  token_id: string;
  account_id: string;
  amount_base_units: string;
  status: string;
  trigger_status: string;
  trigger_error: string | null;
  processing_error: string | null;
  rejection_reason: string | null;
  fulfillment_tx_id: string | null;
  fulfillment_hashscan_url: string | null;
  created_at: string;
  updated_at: string;
}

interface WorldIdVerificationRow {
  id: number;
  token_id: string;
  account_id: string;
  check_kind: string;
  status: string;
  action: string;
  expected_signal: string;
  proof_json: string | null;
  proof_hash: string | null;
  credential: string | null;
  nullifier_hash: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  verified_at: string | null;
}

function mapToken(row: TokenRow): TokenRecord {
  // Tokens created before the detailed policy migration only stored a generic World ID flag.
  // Preserve their former behaviour by treating that legacy flag as Selfie Check.
  const hasDetailedWorldIdPolicy =
    !!row.world_id_selfie_check ||
    row.world_id_minimum_age != null ||
    row.world_id_nationality != null;
  const compliance: ComplianceOptions = {
    kycRequired: !!row.kyc_required,
    freezeDefault: !!row.freeze_default,
    wipeEnabled: !!row.wipe_enabled,
    pauseEnabled: !!row.pause_enabled,
    worldIdRequired: !!row.world_id_required,
    worldIdSelfieCheck:
      !!row.world_id_selfie_check || (!!row.world_id_required && !hasDetailedWorldIdPolicy),
    worldIdMinimumAge: row.world_id_minimum_age ?? undefined,
    worldIdNationality: row.world_id_nationality ?? undefined,
    livenessEnabled: !!row.liveness_enabled,
    livenessPeriodSeconds: row.liveness_period_seconds ?? undefined,
  };
  const blockchain = row.blockchain as Blockchain;
  const network = row.network as TokenNetwork;
  const explorerUrl = tokenExplorerUrl(blockchain, network, row.id);
  return {
    id: row.id,
    blockchain,
    network,
    name: row.name,
    symbol: row.symbol,
    tokenType: row.token_type as TokenType,
    decimals: row.decimals,
    initialSupply: row.initial_supply,
    supplyType: row.supply_type as SupplyType,
    maxSupply: row.max_supply,
    treasuryAccountId: row.treasury_account_id,
    assetCategory: (row.asset_category as AssetCategory) ?? null,
    memo: row.memo,
    compliance,
    customFee: row.custom_fee_enabled && row.custom_fee_config
      ? (JSON.parse(row.custom_fee_config) as CustomFeeConfig)
      : null,
    keys: {
      admin: !!row.has_admin_key,
      kyc: !!row.has_kyc_key,
      freeze: !!row.has_freeze_key,
      wipe: !!row.has_wipe_key,
      pause: !!row.has_pause_key,
      supply: !!row.has_supply_key,
      feeSchedule: !!row.has_fee_schedule_key,
    },
    paused: !!row.paused,
    createTxId: row.create_tx_id,
    // Keep this alias while older UI/MCP clients migrate to explorerUrl.
    hashscanUrl: explorerUrl,
    explorerUrl,
    explorerName: blockchain === "EVM" ? "Etherscan" : "HashScan",
    createdAt: row.created_at,
  };
}

function livenessState(
  compliance: ComplianceOptions,
  lastCheckinAt: string | null
): HolderRecord["livenessState"] {
  if (!compliance.livenessEnabled || !compliance.livenessPeriodSeconds) return "DISABLED";
  if (!lastCheckinAt) return "EXPIRED";
  const elapsedMs = Date.now() - new Date(lastCheckinAt).getTime();
  const periodMs = compliance.livenessPeriodSeconds * 1000;
  if (elapsedMs >= periodMs) return "EXPIRED";
  if (elapsedMs >= periodMs * 0.5) return "AT_RISK";
  return "OK";
}

function mapHolder(row: HolderRow, compliance: ComplianceOptions): HolderRecord {
  return {
    tokenId: row.token_id,
    accountId: row.account_id,
    evmAddress: row.evm_address,
    associated: !!row.associated,
    kycGranted: !!row.kyc_granted,
    frozen: !!row.frozen,
    allowanceGranted: !!row.allowance_granted,
    worldIdVerifiedAt: row.world_id_verified_at,
    worldIdSelfieVerifiedAt: row.world_id_selfie_verified_at,
    worldIdIdentityVerifiedAt: row.world_id_identity_verified_at,
    worldIdSelfieVerification: getLatestWorldIdVerification(
      row.token_id,
      row.account_id,
      "selfie"
    ),
    worldIdIdentityVerification: getLatestWorldIdVerification(
      row.token_id,
      row.account_id,
      "identity"
    ),
    lastCheckinAt: row.last_checkin_at,
    activeScheduleId: row.active_schedule_id,
    activeScheduleExpiresAt: row.active_schedule_expires_at,
    livenessReclaimStatus: row.liveness_reclaim_status as LivenessReclaimStatus,
    livenessReclaimError: row.liveness_reclaim_error,
    livenessReclaimAttemptedAt: row.liveness_reclaim_attempted_at,
    status: row.status as HolderStatus,
    livenessState: livenessState(compliance, row.last_checkin_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    accountId: row.account_id,
    type: row.type as EventType,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
    txId: row.tx_id,
    hashscanUrl: row.hashscan_url,
    createdAt: row.created_at,
  };
}

function mapTokenRequest(row: TokenRequestRow): TokenRequestRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    accountId: row.account_id,
    amountBaseUnits: row.amount_base_units,
    status: row.status as TokenRequestStatus,
    triggerStatus: row.trigger_status as HermesTriggerStatus,
    triggerError: row.trigger_error,
    processingError: row.processing_error,
    rejectionReason: row.rejection_reason,
    fulfillmentTxId: row.fulfillment_tx_id,
    fulfillmentHashscanUrl: row.fulfillment_hashscan_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorldIdVerification(row: WorldIdVerificationRow): WorldIdVerificationRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    accountId: row.account_id,
    check: row.check_kind as WorldIdCheckKind,
    status: row.status as WorldIdVerificationStatus,
    action: row.action,
    expectedSignal: row.expected_signal,
    credential: row.credential,
    nullifierHash: row.nullifier_hash,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
  };
}

// --- tokens ---

export interface InsertTokenParams {
  id: string;
  blockchain?: Blockchain;
  network?: TokenNetwork;
  name: string;
  symbol: string;
  tokenType: TokenType;
  decimals: number;
  initialSupply: number;
  supplyType: SupplyType;
  maxSupply?: number;
  treasuryAccountId: string;
  assetCategory: AssetCategory;
  memo?: string;
  compliance: ComplianceOptions;
  customFee: CustomFeeConfig | null;
  keys: TokenRecord["keys"];
  createTxId: string;
}

export function insertToken(params: InsertTokenParams): TokenRecord {
  const db = getDb();
  db.prepare(
    `INSERT INTO tokens (
      id, blockchain, network, name, symbol, token_type, decimals, initial_supply, supply_type, max_supply,
      treasury_account_id, asset_category, memo,
      kyc_required, freeze_default, wipe_enabled, pause_enabled, world_id_required,
      world_id_selfie_check, world_id_minimum_age, world_id_nationality,
      liveness_enabled, liveness_period_seconds,
      custom_fee_enabled, custom_fee_config,
      has_admin_key, has_kyc_key, has_freeze_key, has_wipe_key, has_pause_key, has_supply_key, has_fee_schedule_key,
      create_tx_id
    ) VALUES (
      @id, @blockchain, @network, @name, @symbol, @tokenType, @decimals, @initialSupply, @supplyType, @maxSupply,
      @treasuryAccountId, @assetCategory, @memo,
      @kycRequired, @freezeDefault, @wipeEnabled, @pauseEnabled, @worldIdRequired,
      @worldIdSelfieCheck, @worldIdMinimumAge, @worldIdNationality,
      @livenessEnabled, @livenessPeriodSeconds,
      @customFeeEnabled, @customFeeConfig,
      @hasAdminKey, @hasKycKey, @hasFreezeKey, @hasWipeKey, @hasPauseKey, @hasSupplyKey, @hasFeeScheduleKey,
      @createTxId
    )`
  ).run({
    id: params.id,
    blockchain: params.blockchain ?? "HEDERA",
    network: params.network ?? "testnet",
    name: params.name,
    symbol: params.symbol,
    tokenType: params.tokenType,
    decimals: params.decimals,
    initialSupply: String(params.initialSupply),
    supplyType: params.supplyType,
    maxSupply: params.maxSupply != null ? String(params.maxSupply) : null,
    treasuryAccountId: params.treasuryAccountId,
    assetCategory: params.assetCategory,
    memo: params.memo ?? null,
    kycRequired: params.compliance.kycRequired ? 1 : 0,
    freezeDefault: params.compliance.freezeDefault ? 1 : 0,
    wipeEnabled: params.compliance.wipeEnabled ? 1 : 0,
    pauseEnabled: params.compliance.pauseEnabled ? 1 : 0,
    worldIdRequired: params.compliance.worldIdRequired ? 1 : 0,
    worldIdSelfieCheck: params.compliance.worldIdSelfieCheck ? 1 : 0,
    worldIdMinimumAge: params.compliance.worldIdMinimumAge ?? null,
    worldIdNationality: params.compliance.worldIdNationality ?? null,
    livenessEnabled: params.compliance.livenessEnabled ? 1 : 0,
    livenessPeriodSeconds: params.compliance.livenessPeriodSeconds ?? null,
    customFeeEnabled: params.customFee ? 1 : 0,
    customFeeConfig: params.customFee ? JSON.stringify(params.customFee) : null,
    hasAdminKey: params.keys.admin ? 1 : 0,
    hasKycKey: params.keys.kyc ? 1 : 0,
    hasFreezeKey: params.keys.freeze ? 1 : 0,
    hasWipeKey: params.keys.wipe ? 1 : 0,
    hasPauseKey: params.keys.pause ? 1 : 0,
    hasSupplyKey: params.keys.supply ? 1 : 0,
    hasFeeScheduleKey: params.keys.feeSchedule ? 1 : 0,
    createTxId: params.createTxId,
  });
  return getToken(params.id)!;
}

const DEFAULT_DEMO_TOKENS: TokenRecord[] = [
  {
    id: "0.0.4491823",
    blockchain: "HEDERA",
    network: "testnet",
    name: "456 Oak Avenue Luxury Residences",
    symbol: "OAK456",
    tokenType: "FUNGIBLE",
    decimals: 0,
    initialSupply: "1000",
    supplyType: "FINITE",
    maxSupply: "1000",
    treasuryAccountId: "0.0.4491823",
    assetCategory: "real-estate",
    memo: "Miami FL 33101 · USPS DPV Validated · $3,800/mo Superfluid CFA Yield · Base Sepolia Stream: 0xcfA132E353cB4E398080B9700609bb008eceB125",
    compliance: {
      kycRequired: true,
      freezeDefault: false,
      wipeEnabled: true,
      pauseEnabled: true,
      worldIdRequired: true,
      worldIdSelfieCheck: true,
      worldIdMinimumAge: 18,
      worldIdNationality: undefined,
      livenessEnabled: true,
      livenessPeriodSeconds: 604800,
    },
    customFee: null,
    keys: {
      admin: true,
      kyc: true,
      freeze: true,
      wipe: true,
      pause: true,
      supply: true,
      feeSchedule: false,
    },
    paused: false,
    createTxId: "0.0.4491823@1789066000.000000000",
    hashscanUrl: "https://hashscan.io/testnet/token/0.0.4491823",
    explorerUrl: "https://hashscan.io/testnet/token/0.0.4491823",
    explorerName: "HashScan",
    createdAt: "2026-09-07T12:00:00.000Z",
  },
  {
    id: "0x71C8401E25687352f20D235F8d7fD1A392cf99a8",
    blockchain: "EVM",
    network: "sepolia",
    name: "789 Brickell Bay Penthouse",
    symbol: "BRK789",
    tokenType: "FUNGIBLE",
    decimals: 18,
    initialSupply: "10000",
    supplyType: "FINITE",
    maxSupply: "10000",
    treasuryAccountId: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    assetCategory: "real-estate",
    memo: "Miami FL 33131 · USPS DPV Validated · $12,500/mo Rent · The Graph Studio Indexed",
    compliance: {
      kycRequired: true,
      freezeDefault: false,
      wipeEnabled: true,
      pauseEnabled: true,
      worldIdRequired: true,
      worldIdSelfieCheck: true,
      worldIdMinimumAge: 18,
      worldIdNationality: undefined,
      livenessEnabled: false,
      livenessPeriodSeconds: undefined,
    },
    customFee: null,
    keys: {
      admin: true,
      kyc: true,
      freeze: true,
      wipe: true,
      pause: true,
      supply: true,
      feeSchedule: false,
    },
    paused: false,
    createTxId: "0x1e0d77de7d53b824bd0d925cc768efc21bff74cfc51f8ced8f45298fc337f4f2",
    hashscanUrl: "https://sepolia.etherscan.io/tx/0x1e0d77de7d53b824bd0d925cc768efc21bff74cfc51f8ced8f45298fc337f4f2",
    explorerUrl: "https://sepolia.etherscan.io/tx/0x1e0d77de7d53b824bd0d925cc768efc21bff74cfc51f8ced8f45298fc337f4f2",
    explorerName: "Etherscan",
    createdAt: "2026-09-07T12:00:00.000Z",
  },
  {
    id: "0.0.5258180",
    blockchain: "HEDERA",
    network: "testnet",
    name: "101 Ocean Drive Beachfront Villa",
    symbol: "OCN101",
    tokenType: "FUNGIBLE",
    decimals: 0,
    initialSupply: "5000",
    supplyType: "FINITE",
    maxSupply: "5000",
    treasuryAccountId: "0.0.5258180",
    assetCategory: "real-estate",
    memo: "Miami Beach FL 33139 · USPS DPV Validated · $8,200/mo Rental Pool · HCS Topic 0.0.4491823",
    compliance: {
      kycRequired: true,
      freezeDefault: false,
      wipeEnabled: true,
      pauseEnabled: true,
      worldIdRequired: true,
      worldIdSelfieCheck: true,
      worldIdMinimumAge: undefined,
      worldIdNationality: undefined,
      livenessEnabled: false,
      livenessPeriodSeconds: undefined,
    },
    customFee: null,
    keys: {
      admin: true,
      kyc: true,
      freeze: true,
      wipe: true,
      pause: true,
      supply: true,
      feeSchedule: false,
    },
    paused: false,
    createTxId: "0.0.5258180@1789065900.000000000",
    hashscanUrl: "https://hashscan.io/testnet/token/0.0.5258180",
    explorerUrl: "https://hashscan.io/testnet/token/0.0.5258180",
    explorerName: "HashScan",
    createdAt: "2026-09-07T12:00:00.000Z",
  },
];

export function getToken(id: string): TokenRecord | null {
  try {
    const row = getDb().prepare("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | undefined;
    if (row) return mapToken(row);
  } catch (err) {
    console.warn("[repo] getToken db error, checking demo tokens:", err);
  }
  return DEFAULT_DEMO_TOKENS.find((t) => t.id === id) ?? null;
}

export function listTokens(): TokenRecord[] {
  try {
    const rows = getDb().prepare("SELECT * FROM tokens ORDER BY created_at DESC").all() as TokenRow[];
    const mapped = rows.map(mapToken);
    return mapped.length > 0 ? mapped : DEFAULT_DEMO_TOKENS;
  } catch (err) {
    console.warn("[repo] listTokens db error, falling back to demo tokens:", err);
    return DEFAULT_DEMO_TOKENS;
  }
}

export function setTokenPaused(tokenId: string, paused: boolean): void {
  try {
    getDb().prepare("UPDATE tokens SET paused = ? WHERE id = ?").run(paused ? 1 : 0, tokenId);
  } catch (err) {
    console.warn("[repo] setTokenPaused error:", err);
  }
}

// --- holders ---

export function getHolder(tokenId: string, accountId: string): HolderRecord | null {
  try {
    const token = getToken(tokenId);
    if (!token) return null;
    const row = getDb()
      .prepare("SELECT * FROM holders WHERE token_id = ? AND account_id = ?")
      .get(tokenId, accountId) as HolderRow | undefined;
    return row ? mapHolder(row, token.compliance) : null;
  } catch (err) {
    console.warn("[repo] getHolder error:", err);
    return null;
  }
}

export function listHolders(tokenId: string): HolderRecord[] {
  try {
    const token = getToken(tokenId);
    if (!token) return [];
    const rows = getDb()
      .prepare("SELECT * FROM holders WHERE token_id = ? ORDER BY created_at ASC")
      .all(tokenId) as HolderRow[];
    return rows.map((r) => mapHolder(r, token.compliance));
  } catch (err) {
    console.warn("[repo] listHolders error:", err);
    return [];
  }
}

/** Insert a holder row if it doesn't exist yet; no-op otherwise. */
export function ensureHolder(tokenId: string, accountId: string, evmAddress?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO holders (token_id, account_id, evm_address)
       VALUES (?, ?, ?)
       ON CONFLICT(token_id, account_id) DO UPDATE SET
         evm_address = COALESCE(excluded.evm_address, holders.evm_address)`
    )
    .run(tokenId, accountId, evmAddress ?? null);
}

export interface HolderPatch {
  associated?: boolean;
  kycGranted?: boolean;
  frozen?: boolean;
  allowanceGranted?: boolean;
  worldIdVerifiedAt?: string | null;
  worldIdSelfieVerifiedAt?: string | null;
  worldIdIdentityVerifiedAt?: string | null;
  lastCheckinAt?: string | null;
  activeScheduleId?: string | null;
  activeScheduleExpiresAt?: string | null;
  livenessReclaimStatus?: LivenessReclaimStatus;
  livenessReclaimError?: string | null;
  livenessReclaimAttemptedAt?: string | null;
  status?: HolderStatus;
}

const PATCH_COLUMN: Record<keyof HolderPatch, string> = {
  associated: "associated",
  kycGranted: "kyc_granted",
  frozen: "frozen",
  allowanceGranted: "allowance_granted",
  worldIdVerifiedAt: "world_id_verified_at",
  worldIdSelfieVerifiedAt: "world_id_selfie_verified_at",
  worldIdIdentityVerifiedAt: "world_id_identity_verified_at",
  lastCheckinAt: "last_checkin_at",
  activeScheduleId: "active_schedule_id",
  activeScheduleExpiresAt: "active_schedule_expires_at",
  livenessReclaimStatus: "liveness_reclaim_status",
  livenessReclaimError: "liveness_reclaim_error",
  livenessReclaimAttemptedAt: "liveness_reclaim_attempted_at",
  status: "status",
};

const BOOLEAN_KEYS = new Set<keyof HolderPatch>(["associated", "kycGranted", "frozen", "allowanceGranted"]);

export function updateHolder(tokenId: string, accountId: string, patch: HolderPatch): void {
  ensureHolder(tokenId, accountId);
  const entries = Object.entries(patch) as [keyof HolderPatch, unknown][];
  if (entries.length === 0) return;
  const setClauses = entries.map(([key]) => `${PATCH_COLUMN[key]} = ?`);
  const values = entries.map(([key, value]) =>
    BOOLEAN_KEYS.has(key) ? (value ? 1 : 0) : (value as string | null)
  );
  setClauses.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE holders SET ${setClauses.join(", ")} WHERE token_id = ? AND account_id = ?`)
    .run(...values, tokenId, accountId);
}

/** Claim one expired holder for a single reclaim attempt. Failed attempts are retried at most
 * once per minute; a process that died mid-flight can be recovered after five minutes. */
export function claimLivenessReclaim(tokenId: string, accountId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE holders
       SET liveness_reclaim_status = 'PROCESSING', liveness_reclaim_error = NULL,
           liveness_reclaim_attempted_at = datetime('now'), updated_at = datetime('now')
       WHERE token_id = ? AND account_id = ? AND status = 'WHITELISTED'
         AND (
           liveness_reclaim_status = 'IDLE'
           OR (liveness_reclaim_status = 'FAILED'
               AND (liveness_reclaim_attempted_at IS NULL
                    OR liveness_reclaim_attempted_at <= datetime('now', '-1 minute')))
           OR (liveness_reclaim_status = 'PROCESSING'
               AND liveness_reclaim_attempted_at <= datetime('now', '-5 minutes'))
         )`
    )
    .run(tokenId, accountId);
  return result.changes === 1;
}

// --- token requests (holder -> Hermes -> one treasury token) ---

export function createOrReopenTokenRequest(
  tokenId: string,
  accountId: string,
  amountBaseUnits: string
): { request: TokenRequestRecord; started: boolean; created: boolean } {
  const db = getDb();
  const existing = getTokenRequestForHolder(tokenId, accountId);
  let started = false;
  let created = false;

  if (!existing) {
    const result = db
      .prepare(
        `INSERT INTO token_requests (token_id, account_id, amount_base_units)
         VALUES (?, ?, ?)
         ON CONFLICT(token_id, account_id) DO NOTHING`
      )
      .run(tokenId, accountId, amountBaseUnits);
    started = result.changes === 1;
    created = started;
  } else if (existing.status === "REJECTED") {
    const result = db
      .prepare(
        `UPDATE token_requests
         SET status = 'PENDING', amount_base_units = ?, trigger_status = 'NOT_TRIGGERED',
             trigger_error = NULL, processing_error = NULL, rejection_reason = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND status = 'REJECTED'`
      )
      .run(amountBaseUnits, existing.id);
    started = result.changes === 1;
  }

  return { request: getTokenRequestForHolder(tokenId, accountId)!, started, created };
}

export function getTokenRequest(id: number): TokenRequestRecord | null {
  const row = getDb().prepare("SELECT * FROM token_requests WHERE id = ?").get(id) as
    | TokenRequestRow
    | undefined;
  return row ? mapTokenRequest(row) : null;
}

export function getTokenRequestForHolder(
  tokenId: string,
  accountId: string
): TokenRequestRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM token_requests WHERE token_id = ? AND account_id = ?")
    .get(tokenId, accountId) as TokenRequestRow | undefined;
  return row ? mapTokenRequest(row) : null;
}

export function listTokenRequestsForToken(tokenId: string): TokenRequestRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM token_requests WHERE token_id = ? ORDER BY created_at DESC, id DESC")
    .all(tokenId) as TokenRequestRow[];
  return rows.map(mapTokenRequest);
}

export function listTokenRequests(status?: TokenRequestStatus): TokenRequestRecord[] {
  const rows = (status
    ? getDb()
        .prepare("SELECT * FROM token_requests WHERE status = ? ORDER BY created_at ASC, id ASC")
        .all(status)
    : getDb().prepare("SELECT * FROM token_requests ORDER BY created_at ASC, id ASC").all()) as
    TokenRequestRow[];
  return rows.map(mapTokenRequest);
}

export interface TokenRequestPatch {
  status?: TokenRequestStatus;
  triggerStatus?: HermesTriggerStatus;
  triggerError?: string | null;
  processingError?: string | null;
  rejectionReason?: string | null;
  fulfillmentTxId?: string | null;
  fulfillmentHashscanUrl?: string | null;
}

const TOKEN_REQUEST_PATCH_COLUMN: Record<keyof TokenRequestPatch, string> = {
  status: "status",
  triggerStatus: "trigger_status",
  triggerError: "trigger_error",
  processingError: "processing_error",
  rejectionReason: "rejection_reason",
  fulfillmentTxId: "fulfillment_tx_id",
  fulfillmentHashscanUrl: "fulfillment_hashscan_url",
};

export function updateTokenRequest(id: number, patch: TokenRequestPatch): TokenRequestRecord | null {
  const entries = Object.entries(patch) as [keyof TokenRequestPatch, unknown][];
  if (entries.length === 0) return getTokenRequest(id);
  const clauses = entries.map(([key]) => `${TOKEN_REQUEST_PATCH_COLUMN[key]} = ?`);
  clauses.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE token_requests SET ${clauses.join(", ")} WHERE id = ?`)
    .run(...entries.map(([, value]) => value as string | null), id);
  return getTokenRequest(id);
}

/** Atomically reserves a pending request so concurrent Hermes runs cannot send it twice. */
export function claimTokenRequest(id: number): TokenRequestRecord | null {
  const result = getDb()
    .prepare(
      `UPDATE token_requests
       SET status = 'PROCESSING', processing_error = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'PENDING'`
    )
    .run(id);
  return result.changes === 1 ? getTokenRequest(id) : null;
}

export function rejectPendingTokenRequest(id: number, reason: string): TokenRequestRecord | null {
  const result = getDb()
    .prepare(
      `UPDATE token_requests
       SET status = 'REJECTED', rejection_reason = ?, processing_error = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'PENDING'`
    )
    .run(reason, id);
  return result.changes === 1 ? getTokenRequest(id) : null;
}

// --- World ID proof queue (browser -> server -> World ID MCP -> World API) ---

export function createWorldIdVerification(params: {
  tokenId: string;
  accountId: string;
  check: WorldIdCheckKind;
  action: string;
  expectedSignal: string;
  proofJson: string;
  proofHash: string;
}): WorldIdVerificationRecord {
  const db = getDb();
  expireWorldIdVerifications();
  const insert = db.transaction(() => {
    // A newly submitted proof supersedes older unprocessed attempts. Their raw proof is erased
    // immediately so the persistent volume never accumulates abandoned World payloads.
    db.prepare(
      `UPDATE world_id_verifications
       SET status = 'REJECTED', proof_json = NULL, error_code = 'superseded',
           error_detail = 'A newer proof was submitted.', updated_at = datetime('now')
       WHERE token_id = ? AND account_id = ? AND check_kind = ?
         AND status IN ('PENDING', 'FAILED')`
    ).run(params.tokenId, params.accountId, params.check);

    return db.prepare(
      `INSERT INTO world_id_verifications (
         token_id, account_id, check_kind, action, expected_signal, proof_json, proof_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.tokenId,
      params.accountId,
      params.check,
      params.action,
      params.expectedSignal,
      params.proofJson,
      params.proofHash
    ).lastInsertRowid;
  });

  return getWorldIdVerification(Number(insert()))!;
}

export function getWorldIdVerification(id: number): WorldIdVerificationRecord | null {
  expireWorldIdVerifications();
  const row = getDb()
    .prepare("SELECT * FROM world_id_verifications WHERE id = ?")
    .get(id) as WorldIdVerificationRow | undefined;
  return row ? mapWorldIdVerification(row) : null;
}

/** Server-only proof access for the verification executor. Never serialize this return value. */
export function getWorldIdVerificationProof(id: number): {
  verification: WorldIdVerificationRecord;
  proof: unknown;
} | null {
  expireWorldIdVerifications();
  const row = getDb()
    .prepare("SELECT * FROM world_id_verifications WHERE id = ?")
    .get(id) as WorldIdVerificationRow | undefined;
  if (!row) return null;
  if (!row.proof_json) return { verification: mapWorldIdVerification(row), proof: null };
  return { verification: mapWorldIdVerification(row), proof: JSON.parse(row.proof_json) as unknown };
}

export function getLatestWorldIdVerification(
  tokenId: string,
  accountId: string,
  check: WorldIdCheckKind
): WorldIdVerificationRecord | null {
  expireWorldIdVerifications();
  const row = getDb()
    .prepare(
      `SELECT * FROM world_id_verifications
       WHERE token_id = ? AND account_id = ? AND check_kind = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(tokenId, accountId, check) as WorldIdVerificationRow | undefined;
  return row ? mapWorldIdVerification(row) : null;
}

export function listWorldIdVerifications(filters: {
  status?: WorldIdVerificationStatus;
  tokenId?: string;
  accountId?: string;
} = {}): WorldIdVerificationRecord[] {
  expireWorldIdVerifications();
  const clauses: string[] = [];
  const values: string[] = [];
  if (filters.status) {
    clauses.push("status = ?");
    values.push(filters.status);
  }
  if (filters.tokenId) {
    clauses.push("token_id = ?");
    values.push(filters.tokenId);
  }
  if (filters.accountId) {
    clauses.push("account_id = ?");
    values.push(filters.accountId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM world_id_verifications ${where} ORDER BY created_at ASC, id ASC`)
    .all(...values) as WorldIdVerificationRow[];
  return rows.map(mapWorldIdVerification);
}

/** Atomically reserve a proof so concurrent agent runs cannot call World twice. */
export function claimWorldIdVerification(id: number): WorldIdVerificationRecord | null {
  expireWorldIdVerifications();
  const result = getDb()
    .prepare(
      `UPDATE world_id_verifications
       SET status = 'PROCESSING', error_code = NULL, error_detail = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND status IN ('PENDING', 'FAILED') AND proof_json IS NOT NULL`
    )
    .run(id);
  return result.changes === 1 ? getWorldIdVerification(id) : null;
}

/** Erase abandoned raw proofs. A normal proof gets 30 minutes to reach Hermes; a process that
 * crashed mid-call is retained for one hour for diagnosis, then purged as well. */
function expireWorldIdVerifications(): void {
  getDb().prepare(
    `UPDATE world_id_verifications
     SET status = 'REJECTED', proof_json = NULL, error_code = 'proof_expired',
         error_detail = 'The queued proof expired before verification.',
         updated_at = datetime('now')
     WHERE proof_json IS NOT NULL
       AND (
         (status IN ('PENDING', 'FAILED') AND expires_at <= datetime('now'))
         OR (status = 'PROCESSING' AND updated_at <= datetime('now', '-1 hour'))
       )`
  ).run();
}

export function failWorldIdVerification(
  id: number,
  errorCode: string,
  errorDetail: string,
  definitive: boolean
): WorldIdVerificationRecord | null {
  getDb()
    .prepare(
      `UPDATE world_id_verifications
       SET status = ?, proof_json = CASE WHEN ? THEN NULL ELSE proof_json END,
           error_code = ?, error_detail = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(definitive ? "REJECTED" : "FAILED", definitive ? 1 : 0, errorCode, errorDetail, id);
  return getWorldIdVerification(id);
}

export type WorldIdCompletionResult =
  | { completed: true }
  | { completed: false; code: string; message: string };

/** Save the trusted World result and erase the raw proof.
 *
 * A World nullifier is stable for a person + RP + action. It is intentionally reusable by the
 * same holder for another token and for a later liveness refresh on the same token. We only
 * reject an exact proof payload replay, or the same World identity claiming the same token from
 * another Hedera account. */
export function completeWorldIdVerification(
  id: number,
  credential: string,
  nullifierHash: string,
  verifiedAt: string
): WorldIdCompletionResult {
  const db = getDb();
  return db.transaction((): WorldIdCompletionResult => {
    const current = db
      .prepare(
        `SELECT token_id, account_id, check_kind, action, proof_hash
         FROM world_id_verifications WHERE id = ?`
      )
      .get(id) as {
        token_id: string;
        account_id: string;
        check_kind: string;
        action: string;
        proof_hash: string | null;
      } | undefined;
    if (!current) {
      return { completed: false, code: "verification_missing", message: "Verification not found." };
    }

    const reject = (code: string, message: string): WorldIdCompletionResult => {
      db.prepare(
        `UPDATE world_id_verifications
         SET status = 'REJECTED', proof_json = NULL, error_code = ?, error_detail = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(code, message, id);
      return { completed: false, code, message };
    };

    if (current.proof_hash) {
      const proofReplay = db
        .prepare(
          `SELECT id FROM world_id_verifications
           WHERE proof_hash = ? AND id != ? AND status IN ('VERIFIED', 'REJECTED') LIMIT 1`
        )
        .get(current.proof_hash, id) as { id: number } | undefined;
      if (proofReplay) {
        return reject("proof_replayed", "This exact World ID proof was already submitted.");
      }
    }

    const identityClaim = db
      .prepare(
        `SELECT id FROM world_id_verifications
         WHERE token_id = ? AND check_kind = ? AND action = ? AND nullifier_hash = ?
           AND account_id != ? AND status = 'VERIFIED' LIMIT 1`
      )
      .get(
        current.token_id,
        current.check_kind,
        current.action,
        nullifierHash,
        current.account_id
      ) as { id: number } | undefined;
    if (identityClaim) {
      return reject(
        "identity_already_claimed",
        "This World ID is already linked to another wallet for this token."
      );
    }

    const result = db.prepare(
      `UPDATE world_id_verifications
       SET status = 'VERIFIED', proof_json = NULL, credential = ?, nullifier_hash = ?,
           error_code = NULL, error_detail = NULL, verified_at = ?,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'PROCESSING'`
    ).run(credential, nullifierHash, verifiedAt, id);
    return result.changes === 1
      ? { completed: true }
      : {
          completed: false,
          code: "verification_not_processing",
          message: "This World ID verification is no longer processing.",
        };
  })();
}

// --- events (audit trail shown in the UI) ---

export function insertEvent(params: {
  tokenId: string;
  accountId?: string | null;
  type: EventType;
  detail?: Record<string, unknown> | null;
  txId?: string | null;
  hashscanUrl?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO events (token_id, account_id, type, detail, tx_id, hashscan_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.tokenId,
      params.accountId ?? null,
      params.type,
      params.detail ? JSON.stringify(params.detail) : null,
      params.txId ?? null,
      params.hashscanUrl ?? null
    );
}

export function listEvents(tokenId: string, limit = 100): EventRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE token_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(tokenId, limit) as EventRow[];
  return rows.map(mapEvent);
}
