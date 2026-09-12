import { getDb } from "@/lib/db";
import { getWorkflowState } from "@/lib/workflow/judgeWorkflow";

export interface AuthoritativePropertyState {
  address: string;
  propertyId: string;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | "FAILED";
  dpvConfirmation: string | null;
  verificationSource: string | null;
  ownershipDisclaimer: string;
  hcsTopic: string | null;
  hcsSequence: number | null;
  hcsTransaction: string | null;
  paymentTxId: string | null;
  timestamp: string | null;
  missingStateError: string | null;
}

export interface AuthoritativeHolderItem {
  accountId: string;
  evmAddress: string | null;
  shares: number;
  sharePercentage: number;
  kycGranted: boolean;
  worldIdVerified: boolean;
  status: string;
}

export interface AuthoritativeTokenState {
  tokenId: string;
  symbol: string;
  name: string;
  network: string;
  totalSupply: string;
  holders: AuthoritativeHolderItem[];
  missingStateError: string | null;
}

export interface AuthoritativeRentState {
  depositedAmount: number;
  depositTransaction: string | null;
  distributableAmount: number;
  vaultAddress: string | null;
  network: string;
  chainId: number;
  blockNumber: number | null;
  hcsSequence: number | null;
  status: "CONFIRMED" | "UNCONFIRMED";
  timestamp: string | null;
  missingStateError: string | null;
}

export interface AuthoritativeStreamState {
  superfluidToken: string;
  receiver: string | null;
  flowRatePerSec: number;
  investorFlowRatePerSec: number;
  flowRateFormatted: string;
  streamTransaction: string | null;
  status: "ACTIVE" | "INACTIVE";
  missingStateError: string | null;
}

export interface AuthoritativeYieldClaimRecord {
  txId: string;
  amount: number;
  recipient: string | null;
  hcsSequenceNumber: number | null;
  timestamp: string;
  hashscanUrl?: string | null;
}

export interface AuthoritativeYieldState {
  accruedAmount: number;
  claimableAmount: number;
  totalClaimedAmount: number;
  claimHistory: AuthoritativeYieldClaimRecord[];
  missingStateError: string | null;
}

export interface AuthoritativeWorkspaceData {
  property: AuthoritativePropertyState;
  token: AuthoritativeTokenState;
  rent: AuthoritativeRentState;
  stream: AuthoritativeStreamState;
  yield: AuthoritativeYieldState;
  workflowStep: number;
  isReadyForInspection: boolean;
  inspectedAt: string | null;
  missingWorkflowError: string | null;
}

export function getAuthoritativeWorkspaceData(identifier: string = "prop_456_oak_ave"): AuthoritativeWorkspaceData {
  const db = getDb();
  const workflow = getWorkflowState();

  // 1. Resolve canonical property identifier
  // Accept: "prop_456_oak_ave", "OAK-RWA", "0.0.4491823", or hex propertyId from Step 1
  const isOakAve =
    !identifier ||
    identifier === "prop_456_oak_ave" ||
    identifier === "OAK-RWA" ||
    identifier === "0.0.4491823" ||
    identifier === "oak-ave" ||
    identifier === workflow.step1.propertyId;

  const canonicalPropertyId = isOakAve
    ? workflow.step1.propertyId || "prop_456_oak_ave"
    : identifier;

  const canonicalPropertyAddress = isOakAve
    ? workflow.step1.propertyAddress || "456 Oak Avenue, Miami FL 33101"
    : "Property " + identifier;

  // 2. Query Authoritative Oracle Verifications from SQLite
  let oracleRow: any = null;
  try {
    oracleRow = db
      .prepare("SELECT * FROM oracle_verifications WHERE property_id = ? ORDER BY id DESC LIMIT 1")
      .get(canonicalPropertyId);
  } catch (err) {
    console.warn("[authoritativeWorkspace] oracle_verifications query error:", err);
  }

  const isStep1Verified = workflow.step1.status === "SUCCESS" || Boolean(oracleRow);

  const propertyState: AuthoritativePropertyState = {
    address: oracleRow?.normalized_address || canonicalPropertyAddress,
    propertyId: canonicalPropertyId,
    verificationStatus: isStep1Verified
      ? "VERIFIED"
      : workflow.step1.status === "FAILED"
      ? "FAILED"
      : "UNVERIFIED",
    dpvConfirmation: workflow.step1.dpvConfirmation || oracleRow?.dpv_result || null,
    verificationSource:
      workflow.step1.provenance ||
      oracleRow?.provenance ||
      (isStep1Verified ? "USPS Web Tools API Revision 1 · LIVE_ONCHAIN" : null),
    ownershipDisclaimer:
      workflow.step1.ownershipDisclaimer ||
      oracleRow?.ownership_disclaimer ||
      "address deliverability verification is NOT proof of property ownership",
    hcsTopic: workflow.step1.hcsTopicId || oracleRow?.hcs_topic_id || null,
    hcsSequence: workflow.step1.hcsSequenceNumber ?? oracleRow?.hcs_sequence_number ?? null,
    hcsTransaction: workflow.step1.hcsTxId || oracleRow?.hcs_tx_id || null,
    paymentTxId: workflow.step1.paymentTxId || oracleRow?.payment_proof || null,
    timestamp: workflow.step1.timestamp || oracleRow?.created_at || null,
    missingStateError: isStep1Verified
      ? null
      : "Step 1 Oracle Verification has not been executed for 456 Oak Avenue. Run Live x402 Oracle Check first to verify physical deliverability.",
  };

  // 3. Query Authoritative Rent Deposits from SQLite
  let rentRow: any = null;
  try {
    rentRow = db
      .prepare("SELECT * FROM rent_deposits WHERE property_id = ? ORDER BY id DESC LIMIT 1")
      .get(canonicalPropertyId);
  } catch (err) {
    console.warn("[authoritativeWorkspace] rent_deposits query error:", err);
  }

  const isStep2Deposited = workflow.step2.status === "SUCCESS" || Boolean(rentRow);
  const depositedAmount = rentRow?.amount_usd ?? (workflow.step2.status === "SUCCESS" ? workflow.step2.rentAmount : 0);
  const depositTx = rentRow?.tx_hash ?? workflow.step2.depositTx ?? null;
  const vaultAddress =
    rentRow?.vault_address ??
    workflow.step2.vaultAddress ??
    process.env.YIELD_VAULT_ADDRESS ??
    null;

  const rentState: AuthoritativeRentState = {
    depositedAmount: isStep2Deposited ? depositedAmount : 0,
    depositTransaction: isStep2Deposited ? depositTx : null,
    distributableAmount: isStep2Deposited ? depositedAmount : 0,
    vaultAddress,
    network: rentRow?.network ?? "Base Sepolia",
    chainId: rentRow?.chain_id ?? 84532,
    blockNumber: rentRow?.block_number ?? null,
    hcsSequence: rentRow?.hcs_sequence_number ?? workflow.step2.hcsSequenceNumber ?? null,
    status: isStep2Deposited ? "CONFIRMED" : "UNCONFIRMED",
    timestamp: rentRow?.created_at ?? workflow.step2.timestamp ?? null,
    missingStateError: isStep2Deposited
      ? null
      : "Step 2 Rent Deposit ($5,000) has not been confirmed. Reserves are unallocated and streaming is inactive.",
  };

  // 4. Authoritative Superfluid CFA Stream State
  const grossFlowRatePerSec = isStep2Deposited && depositedAmount > 0 ? depositedAmount / 2592000 : 0;
  const investorFlowRatePerSec = isStep2Deposited && depositedAmount > 0 ? (depositedAmount * 0.1) / 2592000 : 0;

  const streamState: AuthoritativeStreamState = {
    superfluidToken: process.env.FUSDCX_ADDRESS || "fUSDCx (Base Sepolia)",
    receiver: vaultAddress,
    flowRatePerSec: grossFlowRatePerSec,
    investorFlowRatePerSec,
    flowRateFormatted: grossFlowRatePerSec > 0 ? `+$${grossFlowRatePerSec.toFixed(8)}/sec` : "$0.00/sec",
    streamTransaction: isStep2Deposited ? depositTx : null,
    status: isStep2Deposited ? "ACTIVE" : "INACTIVE",
    missingStateError: isStep2Deposited
      ? null
      : "No active Superfluid stream: canonical $5,000 rent deposit is required to initiate continuous yield.",
  };

  // 5. Authoritative Yield & Claim History
  const claimHistory: AuthoritativeYieldClaimRecord[] = [];

  // Query events table for real claim events
  try {
    const claimEvents = db
      .prepare(
        "SELECT * FROM events WHERE (token_id = ? OR token_id = ?) AND (type = 'CLAIM' OR detail LIKE '%CLAIM%') ORDER BY id DESC"
      )
      .all(canonicalPropertyId, "prop_456_oak_ave") as any[];

    for (const ce of claimEvents) {
      let detail: any = {};
      try {
        detail = JSON.parse(ce.detail);
      } catch {}
      claimHistory.push({
        txId: ce.tx_id || "0xClaimConfirmed",
        amount: detail.amountClaimed || detail.amount || workflow.step3.claimAmount || 0,
        recipient: ce.account_id || workflow.step3.recipient || null,
        hcsSequenceNumber: detail.hcsSequenceNumber || null,
        timestamp: ce.created_at,
        hashscanUrl: ce.hashscan_url || null,
      });
    }
  } catch (err) {
    console.warn("[authoritativeWorkspace] events query error:", err);
  }

  // Include step3 claim record if not already in events
  if (workflow.step3.status === "SUCCESS" && workflow.step3.claimTxId) {
    const alreadyPresent = claimHistory.some((c) => c.txId === workflow.step3.claimTxId);
    if (!alreadyPresent) {
      claimHistory.unshift({
        txId: workflow.step3.claimTxId,
        amount: workflow.step3.claimAmount,
        recipient: workflow.step3.recipient,
        hcsSequenceNumber: workflow.step3.hcsSequenceNumber,
        timestamp: workflow.step3.timestamp || new Date().toISOString(),
      });
    }
  }

  const isStep3Settled = workflow.step3.status === "SUCCESS" || claimHistory.length > 0;
  const totalClaimedAmount = claimHistory.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

  // Compute live accrued yield from real deposit timestamp
  let accruedAmount = 0;
  if (isStep2Deposited && rentState.timestamp && investorFlowRatePerSec > 0) {
    const depositTime = new Date(rentState.timestamp).getTime();
    if (!isNaN(depositTime)) {
      const elapsedSec = Math.max(0, (Date.now() - depositTime) / 1000);
      accruedAmount = Math.max(0, elapsedSec * investorFlowRatePerSec - totalClaimedAmount);
    }
  }

  const yieldState: AuthoritativeYieldState = {
    accruedAmount,
    claimableAmount: Math.max(0, accruedAmount),
    totalClaimedAmount,
    claimHistory,
    missingStateError: isStep3Settled
      ? null
      : isStep2Deposited
      ? "Yield is actively accruing from $5,000 deposit; no on-chain claim has been settled yet."
      : "No yield claim state: Step 2 Rent Deposit must be confirmed before yield can accrue.",
  };

  // 6. Authoritative Token & Real Holders
  const realHolders: AuthoritativeHolderItem[] = [];
  try {
    const holderRows = db
      .prepare(
        "SELECT * FROM holders WHERE token_id = ? OR token_id = ? ORDER BY created_at ASC"
      )
      .all(canonicalPropertyId, "prop_456_oak_ave") as any[];

    for (const hr of holderRows) {
      realHolders.push({
        accountId: hr.account_id,
        evmAddress: hr.evm_address || hr.account_id,
        shares: 100, // standard fractional share allocation upon verification
        sharePercentage: 10.0,
        kycGranted: Boolean(hr.kyc_granted),
        worldIdVerified: Boolean(hr.world_id_verified_at || hr.world_id_selfie_verified_at),
        status: hr.status || "WHITELISTED",
      });
    }
  } catch (err) {
    console.warn("[authoritativeWorkspace] holders query error:", err);
  }

  const tokenState: AuthoritativeTokenState = {
    tokenId: canonicalPropertyId,
    symbol: "OAK-RWA",
    name: "456 Oak Avenue Luxury Residences",
    network: "Base Sepolia",
    totalSupply: "1,000 Shares",
    holders: realHolders,
    missingStateError:
      workflow.step4.status === "LOCKED" && !isStep3Settled
        ? "Token Workspace is locked. Complete Steps 1-3 to unlock Oak Avenue workspace."
        : null,
  };

  // Overall workspace readiness
  const isReadyForInspection = workflow.step3.status === "SUCCESS";
  const missingWorkflowError =
    workflow.step1.status !== "SUCCESS"
      ? "Step 1 Oracle Verification has not succeeded."
      : workflow.step2.status !== "SUCCESS"
      ? "Step 2 $5,000 Rent Deposit has not succeeded."
      : workflow.step3.status !== "SUCCESS"
      ? "Step 3 Claim Yield has not succeeded."
      : null;

  return {
    property: propertyState,
    token: tokenState,
    rent: rentState,
    stream: streamState,
    yield: yieldState,
    workflowStep: workflow.currentStep,
    isReadyForInspection,
    inspectedAt: workflow.step4.inspectedAt,
    missingWorkflowError,
  };
}
