// Shared domain types for the tokenization platform.
// These mirror the SQLite schema (src/lib/db/schema.sql) and the shape returned by the API routes.

export type TokenType = "FUNGIBLE" | "NFT";
export type SupplyType = "FINITE" | "INFINITE";
export type Blockchain = "HEDERA" | "EVM";
export type TokenNetwork = "mainnet" | "testnet" | "previewnet" | "sepolia";
export type AssetCategory =
  | "securities"
  | "real-estate"
  | "invoices"
  | "carbon-credits"
  | "commodities"
  | "other";

export type CustomFeeType = "FIXED_HBAR" | "FRACTIONAL" | "ROYALTY";

export interface FixedHbarFeeConfig {
  type: "FIXED_HBAR";
  amountHbar: number; // charged per transfer, paid to the treasury
}

export interface FractionalFeeConfig {
  type: "FRACTIONAL";
  numerator: number;
  denominator: number;
  minAmount: number;
  maxAmount: number;
  assessedToSender: boolean;
}

export interface RoyaltyFeeConfig {
  type: "ROYALTY";
  numerator: number;
  denominator: number;
  fallbackFeeHbar: number; // charged when royalty can't be assessed (e.g. non-HTS trade)
}

export type CustomFeeConfig = FixedHbarFeeConfig | FractionalFeeConfig | RoyaltyFeeConfig;

/** Compliance checkboxes shown on the "create token" form. */
export interface ComplianceOptions {
  kycRequired: boolean;
  freezeDefault: boolean;
  wipeEnabled: boolean;
  pauseEnabled: boolean;
  worldIdRequired: boolean;
  worldIdSelfieCheck: boolean;
  worldIdMinimumAge?: number;
  worldIdNationality?: string;
  livenessEnabled: boolean;
  livenessPeriodSeconds?: number;
}

export interface CreateTokenInput {
  blockchain?: Blockchain;
  name: string;
  symbol: string;
  tokenType: TokenType;
  decimals: number;
  initialSupply: number;
  supplyType: SupplyType;
  maxSupply?: number;
  assetCategory: AssetCategory;
  memo?: string;
  compliance: ComplianceOptions;
  customFee?: CustomFeeConfig;
}

export interface TokenRecord {
  id: string;
  blockchain: Blockchain;
  network: TokenNetwork;
  name: string;
  symbol: string;
  tokenType: TokenType;
  decimals: number;
  initialSupply: string;
  supplyType: SupplyType;
  maxSupply: string | null;
  treasuryAccountId: string;
  assetCategory: AssetCategory | null;
  memo: string | null;
  compliance: ComplianceOptions;
  customFee: CustomFeeConfig | null;
  keys: {
    admin: boolean;
    kyc: boolean;
    freeze: boolean;
    wipe: boolean;
    pause: boolean;
    supply: boolean;
    feeSchedule: boolean;
  };
  paused: boolean;
  createTxId: string | null;
  hashscanUrl: string;
  explorerUrl: string;
  explorerName: "HashScan" | "Etherscan";
  createdAt: string;
}

export type HolderStatus = "PENDING" | "WHITELISTED" | "REVOKED";
export type LivenessReclaimStatus = "IDLE" | "PROCESSING" | "FAILED" | "COMPLETED";

export interface HolderRecord {
  tokenId: string;
  accountId: string;
  evmAddress: string | null;
  associated: boolean;
  kycGranted: boolean;
  frozen: boolean;
  allowanceGranted: boolean;
  worldIdVerifiedAt: string | null;
  worldIdSelfieVerifiedAt: string | null;
  worldIdIdentityVerifiedAt: string | null;
  worldIdSelfieVerification: WorldIdVerificationRecord | null;
  worldIdIdentityVerification: WorldIdVerificationRecord | null;
  lastCheckinAt: string | null;
  activeScheduleId: string | null;
  activeScheduleExpiresAt: string | null;
  livenessReclaimStatus: LivenessReclaimStatus;
  livenessReclaimError: string | null;
  livenessReclaimAttemptedAt: string | null;
  status: HolderStatus;
  livenessState: "DISABLED" | "OK" | "AT_RISK" | "EXPIRED";
  createdAt: string;
  updatedAt: string;
}

export type WorldIdCheckKind = "selfie" | "identity";
export type WorldIdVerificationStatus =
  | "PENDING"
  | "PROCESSING"
  | "VERIFIED"
  | "REJECTED"
  | "FAILED";

/** Sanitized verification metadata exposed to the UI and World ID MCP.
 * The raw IDKit proof is deliberately absent and remains server-side only. */
export interface WorldIdVerificationRecord {
  id: number;
  tokenId: string;
  accountId: string;
  check: WorldIdCheckKind;
  status: WorldIdVerificationStatus;
  action: string;
  expectedSignal: string;
  credential: string | null;
  nullifierHash: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  verifiedAt: string | null;
}

export interface WorldIdClientConfig {
  appId: string;
  isConfigured: boolean;
  selfieEnvironment: "production";
  identityEnvironment: "staging";
}

export type TokenRequestStatus = "PENDING" | "PROCESSING" | "FULFILLED" | "REJECTED";
export type HermesTriggerStatus = "NOT_TRIGGERED" | "TRIGGERED" | "FAILED";

export interface TokenRequestRecord {
  id: number;
  tokenId: string;
  accountId: string;
  amountBaseUnits: string;
  status: TokenRequestStatus;
  triggerStatus: HermesTriggerStatus;
  triggerError: string | null;
  processingError: string | null;
  rejectionReason: string | null;
  fulfillmentTxId: string | null;
  fulfillmentHashscanUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EventType =
  | "CREATE_TOKEN"
  | "ASSOCIATE"
  | "GRANT_KYC"
  | "REVOKE_KYC"
  | "FREEZE"
  | "UNFREEZE"
  | "WIPE"
  | "PAUSE"
  | "UNPAUSE"
  | "TRANSFER"
  | "ALLOWANCE_APPROVE"
  | "WORLDID_VERIFY"
  | "CHECKIN"
  | "SCHEDULE_RECLAIM"
  | "CANCEL_RECLAIM"
  | "AUTO_RECLAIM_EXECUTED"
  | "TOKEN_REQUESTED"
  | "TOKEN_MINTED"
  | "TOKEN_REQUEST_FULFILLED"
  | "TOKEN_REQUEST_REJECTED";

export interface EventRecord {
  id: number;
  tokenId: string;
  accountId: string | null;
  type: EventType;
  detail: Record<string, unknown> | null;
  txId: string | null;
  hashscanUrl: string | null;
  createdAt: string;
}
