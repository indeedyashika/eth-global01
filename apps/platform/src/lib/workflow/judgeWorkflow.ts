import { getDb } from "../db/index";

export type StepStatus = "LOCKED" | "READY" | "EXECUTING" | "SUCCESS" | "FAILED";

export interface JudgeWorkflowState {
  id: string;
  currentStep: number;
  step1: {
    status: StepStatus;
    propertyId: string | null;
    propertyAddress: string | null;
    oracleVerified: boolean;
    dpvConfirmation: string | null;
    paymentTxId: string | null;
    hcsTopicId: string | null;
    hcsSequenceNumber: number | null;
    hcsTxId: string | null;
    consensusTimestamp: string | null;
    network: string;
    provenance: string;
    ownershipDisclaimer: string;
    timestamp: string | null;
    error: string | null;
  };
  step2: {
    status: StepStatus;
    rentAmount: number;
    depositTx: string | null;
    vaultAddress: string | null;
    hcsSequenceNumber: number | null;
    timestamp: string | null;
    error: string | null;
  };
  step3: {
    status: StepStatus;
    claimTxId: string | null;
    claimAmount: number;
    recipient: string | null;
    hcsSequenceNumber: number | null;
    timestamp: string | null;
    error: string | null;
  };
  step4: {
    status: StepStatus;
    tokenId: string | null;
    tokenSymbol: string | null;
    tokenNetwork: string | null;
    tokenTotalSupply: string | null;
    propertyAddress: string | null;
    inspectedAt: string | null;
    error: string | null;
  };
  step5: {
    status: StepStatus;
    verified: boolean;
    nullifierHash: string | null;
    credentialType: string | null;
    sharesClaimed: number;
    claimTxId: string | null;
    timestamp: string | null;
    error: string | null;
  };
  step6: {
    status: StepStatus;
    holderCount: number;
    consensusSeqCount: number;
    confirmedAt: string | null;
    error: string | null;
  };
  step7: {
    status: StepStatus;
    sessionId: string | null;
    executionId: string | null;
    txHash: string | null;
    action: string | null;
    timestamp: string | null;
    error: string | null;
  };
  step8: {
    status: StepStatus;
    attackAction: string | null;
    blocked: boolean;
    rejectionCode: string | null;
    rejectionReason: string | null;
    timestamp: string | null;
    error: string | null;
  };
  step9: {
    status: StepStatus;
    subgraphUrl: string | null;
    subgraphStatus: string | null;
    indexedBlock: number | null;
    queryResult: any | null;
    timestamp: string | null;
    error: string | null;
  };
  updatedAt: string;
}

function rowToState(row: any): JudgeWorkflowState {
  let queryResult = null;
  if (row.subgraph_query_result) {
    try {
      queryResult = JSON.parse(row.subgraph_query_result);
    } catch {
      queryResult = row.subgraph_query_result;
    }
  }

  return {
    id: row.id,
    currentStep: row.current_step,
    step1: {
      status: row.step1_status as StepStatus,
      propertyId: row.property_id || null,
      propertyAddress: row.property_address || "456 Oak Avenue, Miami FL 33101",
      oracleVerified: Boolean(row.oracle_verified),
      dpvConfirmation: row.oracle_dpv || null,
      paymentTxId: row.oracle_payment_tx || null,
      hcsTopicId: row.oracle_hcs_topic || null,
      hcsSequenceNumber: row.oracle_hcs_seq ? Number(row.oracle_hcs_seq) : null,
      hcsTxId: row.oracle_hcs_tx || null,
      consensusTimestamp: row.oracle_timestamp || null,
      network: "hedera-testnet",
      provenance: row.oracle_provenance || "LIVE_ONCHAIN",
      ownershipDisclaimer: row.oracle_ownership_disclaimer || "address deliverability verification is NOT proof of property ownership",
      timestamp: row.oracle_timestamp || null,
      error: row.oracle_error || null,
    },
    step2: {
      status: row.step2_status as StepStatus,
      rentAmount: row.rent_deposited_amount ? Number(row.rent_deposited_amount) : 5000,
      depositTx: row.rent_deposit_tx || null,
      vaultAddress: row.rent_vault_address || null,
      hcsSequenceNumber: row.rent_hcs_seq ? Number(row.rent_hcs_seq) : null,
      timestamp: row.rent_timestamp || null,
      error: row.rent_error || null,
    },
    step3: {
      status: row.step3_status as StepStatus,
      claimTxId: row.claim_tx || null,
      claimAmount: row.claim_amount ? Number(row.claim_amount) : 0,
      recipient: row.claim_recipient || null,
      hcsSequenceNumber: row.claim_hcs_seq ? Number(row.claim_hcs_seq) : null,
      timestamp: row.claim_timestamp || null,
      error: row.claim_error || null,
    },
    step4: {
      status: row.step4_status as StepStatus,
      tokenId: row.token_id || null,
      tokenSymbol: row.token_symbol || null,
      tokenNetwork: row.token_network || null,
      tokenTotalSupply: row.token_total_supply || null,
      propertyAddress: row.property_address || null,
      inspectedAt: row.workspace_inspected_at || null,
      error: row.step4_error || null,
    },
    step5: {
      status: row.step5_status as StepStatus,
      verified: Boolean(row.world_id_verified),
      nullifierHash: row.world_id_nullifier || null,
      credentialType: row.world_id_credential_type || null,
      sharesClaimed: row.world_id_shares_claimed ? Number(row.world_id_shares_claimed) : 0,
      claimTxId: row.world_id_claim_tx || null,
      timestamp: row.world_id_timestamp || null,
      error: row.world_id_error || null,
    },
    step6: {
      status: row.step6_status as StepStatus,
      holderCount: row.cap_table_holder_count ? Number(row.cap_table_holder_count) : 0,
      consensusSeqCount: row.consensus_ledger_seq_count ? Number(row.consensus_ledger_seq_count) : 0,
      confirmedAt: row.audit_confirmed_at || null,
      error: row.step6_error || null,
    },
    step7: {
      status: row.step7_status as StepStatus,
      sessionId: row.hermes_session_id || null,
      executionId: row.hermes_execution_id || null,
      txHash: row.hermes_tx_hash || null,
      action: row.hermes_action || null,
      timestamp: row.hermes_timestamp || null,
      error: row.hermes_error || null,
    },
    step8: {
      status: row.step8_status as StepStatus,
      attackAction: row.compromise_attempt_action || null,
      blocked: Boolean(row.compromise_blocked),
      rejectionCode: row.compromise_rejection_code || null,
      rejectionReason: row.compromise_rejection_reason || null,
      timestamp: row.compromise_timestamp || null,
      error: row.step8_error || null,
    },
    step9: {
      status: row.step9_status as StepStatus,
      subgraphUrl: row.subgraph_url || null,
      subgraphStatus: row.subgraph_status || null,
      indexedBlock: row.subgraph_indexed_block ? Number(row.subgraph_indexed_block) : null,
      queryResult,
      timestamp: row.subgraph_timestamp || null,
      error: row.subgraph_error || null,
    },
    updatedAt: row.updated_at,
  };
}

export function getWorkflowState(): JudgeWorkflowState {
  const db = getDb();
  let row = db.prepare("SELECT * FROM judge_workflow_state WHERE id = 'current'").get() as any;
  if (!row) {
    db.prepare(`
      INSERT INTO judge_workflow_state (id, current_step, step1_status, step2_status, step3_status, step4_status, step5_status, step6_status, step7_status, step8_status, step9_status)
      VALUES ('current', 1, 'READY', 'LOCKED', 'LOCKED', 'LOCKED', 'LOCKED', 'LOCKED', 'LOCKED', 'LOCKED', 'LOCKED')
    `).run();
    row = db.prepare("SELECT * FROM judge_workflow_state WHERE id = 'current'").get() as any;
  }
  return rowToState(row);
}

export function recordStep1Oracle(data: {
  propertyId: string;
  propertyAddress: string;
  dpvConfirmation: string;
  paymentTxId?: string | null;
  hcsTopicId?: string | null;
  hcsSequenceNumber?: number | null;
  hcsTxId?: string | null;
  consensusTimestamp?: string | null;
  network?: string;
  provenance?: string;
  uspsMetadata?: any;
  isValid: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const db = getDb();
  const now = new Date().toISOString();

  if (data.isValid) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 2),
        step1_status = 'SUCCESS',
        step2_status = CASE WHEN step2_status = 'LOCKED' THEN 'READY' ELSE step2_status END,
        property_id = ?,
        property_address = ?,
        oracle_verified = 1,
        oracle_dpv = ?,
        oracle_payment_tx = ?,
        oracle_hcs_topic = ?,
        oracle_hcs_seq = ?,
        oracle_hcs_tx = ?,
        oracle_provenance = ?,
        oracle_ownership_disclaimer = 'address deliverability verification is NOT proof of property ownership',
        oracle_timestamp = ?,
        oracle_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.propertyId,
      data.propertyAddress,
      data.dpvConfirmation,
      data.paymentTxId || null,
      data.hcsTopicId || null,
      data.hcsSequenceNumber || null,
      data.hcsTxId || null,
      data.provenance || 'LIVE_ONCHAIN',
      data.consensusTimestamp || now,
      now
    );

    // Persist into oracle_verifications table for durable audit
    try {
      db.prepare(`
        INSERT INTO oracle_verifications (
          property_id,
          normalized_address,
          payment_proof,
          payment_status,
          usps_metadata,
          dpv_result,
          hcs_topic_id,
          hcs_sequence_number,
          hcs_tx_id,
          consensus_timestamp,
          network,
          provenance,
          ownership_disclaimer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.propertyId,
        data.propertyAddress,
        data.paymentTxId || "VERIFIED_ONCHAIN",
        "CONFIRMED",
        data.uspsMetadata ? JSON.stringify(data.uspsMetadata) : null,
        data.dpvConfirmation,
        data.hcsTopicId || null,
        data.hcsSequenceNumber || null,
        data.hcsTxId || null,
        data.consensusTimestamp || now,
        data.network || "hedera-testnet",
        data.provenance || "LIVE_ONCHAIN",
        "address deliverability verification is NOT proof of property ownership"
      );
    } catch (insertErr) {
      console.warn("[judgeWorkflow] Failed to insert into oracle_verifications:", insertErr);
    }
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step1_status = 'FAILED',
        oracle_verified = 0,
        oracle_dpv = ?,
        oracle_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.dpvConfirmation || null, data.error || "Oracle check failed", now);
  }

  return getWorkflowState();
}

export function recordStep2RentDeposit(data: {
  rentAmount: number;
  txHash: string;
  vaultAddress?: string | null;
  hcsSequenceNumber?: number | null;
  success: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step1.status !== "SUCCESS") {
    throw new Error("Step 1 Oracle Verification is required before depositing rent.");
  }
  if (data.rentAmount !== 5000) {
    throw new Error(`Canonical judge flow rent deposit amount must be exactly $5,000. Received: $${data.rentAmount}`);
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.success) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 3),
        step2_status = 'SUCCESS',
        step3_status = CASE WHEN step3_status = 'LOCKED' THEN 'READY' ELSE step3_status END,
        rent_deposited_amount = ?,
        rent_deposit_tx = ?,
        rent_vault_address = ?,
        rent_hcs_seq = ?,
        rent_timestamp = ?,
        rent_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.rentAmount,
      data.txHash,
      data.vaultAddress || null,
      data.hcsSequenceNumber || null,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step2_status = 'FAILED',
        rent_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "Rent deposit failed", now);
  }

  return getWorkflowState();
}

export function recordStep3YieldClaim(data: {
  claimTxId: string;
  claimAmount: number;
  recipient?: string | null;
  hcsSequenceNumber?: number | null;
  success: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step2.status !== "SUCCESS") {
    throw new Error("Step 2 $5,000 Rent Deposit is required before claiming yield.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.success) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 4),
        step3_status = 'SUCCESS',
        step4_status = CASE WHEN step4_status = 'LOCKED' THEN 'READY' ELSE step4_status END,
        claim_tx = ?,
        claim_amount = ?,
        claim_recipient = ?,
        claim_hcs_seq = ?,
        claim_timestamp = ?,
        claim_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.claimTxId,
      data.claimAmount,
      data.recipient || null,
      data.hcsSequenceNumber || null,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step3_status = 'FAILED',
        claim_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "Yield claim failed", now);
  }

  return getWorkflowState();
}

export function recordStep4WorkspaceInspection(data: {
  tokenId: string;
  tokenSymbol: string;
  tokenNetwork?: string;
  tokenTotalSupply?: string;
  propertyAddress?: string;
  success: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step3.status !== "SUCCESS") {
    throw new Error("Step 3 Claim Yield is required before inspecting Oak Avenue workspace.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.success) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 5),
        step4_status = 'SUCCESS',
        step5_status = CASE WHEN step5_status = 'LOCKED' THEN 'READY' ELSE step5_status END,
        token_id = ?,
        token_symbol = ?,
        token_network = COALESCE(?, token_network),
        token_total_supply = COALESCE(?, token_total_supply),
        property_address = COALESCE(?, property_address),
        workspace_inspected_at = ?,
        step4_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.tokenId,
      data.tokenSymbol,
      data.tokenNetwork || null,
      data.tokenTotalSupply || null,
      data.propertyAddress || null,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step4_status = 'FAILED',
        step4_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "Workspace inspection error", now);
  }

  return getWorkflowState();
}

export function recordStep5WorldId(data: {
  verified: boolean;
  nullifierHash?: string | null;
  credentialType?: string | null;
  sharesClaimed?: number;
  claimTxId?: string | null;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step4.status !== "SUCCESS") {
    throw new Error("Step 4 Workspace Inspection is required before World ID Portal.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.verified) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 6),
        step5_status = 'SUCCESS',
        step6_status = CASE WHEN step6_status = 'LOCKED' THEN 'READY' ELSE step6_status END,
        world_id_verified = 1,
        world_id_nullifier = ?,
        world_id_credential_type = ?,
        world_id_shares_claimed = ?,
        world_id_claim_tx = ?,
        world_id_timestamp = ?,
        world_id_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.nullifierHash || null,
      data.credentialType || "orb",
      data.sharesClaimed || 100,
      data.claimTxId || null,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step5_status = 'FAILED',
        world_id_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "World ID verification failed", now);
  }

  return getWorkflowState();
}

export function recordStep6CapTable(data: {
  holderCount: number;
  consensusSeqCount: number;
  success: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step5.status !== "SUCCESS") {
    throw new Error("Step 5 World ID Portal is required before Cap Table inspection.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.success) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 7),
        step6_status = 'SUCCESS',
        step7_status = CASE WHEN step7_status = 'LOCKED' THEN 'READY' ELSE step7_status END,
        cap_table_holder_count = ?,
        consensus_ledger_seq_count = ?,
        audit_confirmed_at = ?,
        step6_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.holderCount, data.consensusSeqCount, now, now);
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step6_status = 'FAILED',
        step6_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "Cap table validation failed", now);
  }

  return getWorkflowState();
}

export function recordStep7Hermes(data: {
  sessionId: string;
  executionId: string;
  txHash?: string | null;
  action?: string | null;
  success: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step6.status !== "SUCCESS") {
    throw new Error("Step 6 Cap Table is required before Hermes Mission.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.success) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 8),
        step7_status = 'SUCCESS',
        step8_status = CASE WHEN step8_status = 'LOCKED' THEN 'READY' ELSE step8_status END,
        hermes_session_id = ?,
        hermes_execution_id = ?,
        hermes_tx_hash = ?,
        hermes_action = ?,
        hermes_timestamp = ?,
        hermes_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.sessionId,
      data.executionId,
      data.txHash || null,
      data.action || "FULL_TOKENIZATION_AND_YIELD_PIPELINE",
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step7_status = 'FAILED',
        hermes_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "Hermes execution failed", now);
  }

  return getWorkflowState();
}

export function recordStep8Compromise(data: {
  attackAction: string;
  blocked: boolean;
  rejectionCode?: string | null;
  rejectionReason?: string | null;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step7.status !== "SUCCESS") {
    throw new Error("Step 7 Hermes Cockpit is required before Simulate Compromise Attempt.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.blocked) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        current_step = MAX(current_step, 9),
        step8_status = 'SUCCESS',
        step9_status = CASE WHEN step9_status = 'LOCKED' THEN 'READY' ELSE step9_status END,
        compromise_attempt_action = ?,
        compromise_blocked = 1,
        compromise_rejection_code = ?,
        compromise_rejection_reason = ?,
        compromise_timestamp = ?,
        step8_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.attackAction,
      data.rejectionCode || "UNAUTHORIZED_TARGET_SELECTOR",
      data.rejectionReason || "ERC-7579 session guardrail intercepted unauthorized rogue action",
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step8_status = 'FAILED',
        compromise_blocked = 0,
        step8_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.error || "Compromise attempt was not intercepted by guardrails", now);
  }

  return getWorkflowState();
}

export function recordStep9Graph(data: {
  subgraphUrl: string;
  subgraphStatus: string;
  indexedBlock?: number | null;
  queryResult?: any;
  success: boolean;
  error?: string | null;
}): JudgeWorkflowState {
  const current = getWorkflowState();
  if (current.step8.status !== "SUCCESS") {
    throw new Error("Step 8 Compromise Attempt is required before Inspect Live Subgraph.");
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (data.success) {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step9_status = 'SUCCESS',
        subgraph_url = ?,
        subgraph_status = ?,
        subgraph_indexed_block = ?,
        subgraph_query_result = ?,
        subgraph_timestamp = ?,
        subgraph_error = NULL,
        updated_at = ?
      WHERE id = 'current'
    `).run(
      data.subgraphUrl,
      data.subgraphStatus,
      data.indexedBlock || null,
      data.queryResult ? JSON.stringify(data.queryResult) : null,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE judge_workflow_state SET
        step9_status = 'FAILED',
        subgraph_url = ?,
        subgraph_status = ?,
        subgraph_error = ?,
        updated_at = ?
      WHERE id = 'current'
    `).run(data.subgraphUrl || null, data.subgraphStatus || "ERROR", data.error || "Graph query failed", now);
  }

  return getWorkflowState();
}

export function resetWorkflowState(): JudgeWorkflowState {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE judge_workflow_state SET
      current_step = 1,
      step1_status = 'READY',
      property_id = NULL,
      oracle_verified = 0,
      oracle_dpv = NULL,
      oracle_payment_tx = NULL,
      oracle_hcs_topic = NULL,
      oracle_hcs_seq = NULL,
      oracle_timestamp = NULL,
      oracle_error = NULL,
      step2_status = 'LOCKED',
      rent_deposited_amount = 5000,
      rent_deposit_tx = NULL,
      rent_vault_address = NULL,
      rent_hcs_seq = NULL,
      rent_timestamp = NULL,
      rent_error = NULL,
      step3_status = 'LOCKED',
      claim_tx = NULL,
      claim_amount = 0,
      claim_recipient = NULL,
      claim_hcs_seq = NULL,
      claim_timestamp = NULL,
      claim_error = NULL,
      step4_status = 'LOCKED',
      token_id = NULL,
      workspace_inspected_at = NULL,
      step4_error = NULL,
      step5_status = 'LOCKED',
      world_id_verified = 0,
      world_id_nullifier = NULL,
      world_id_credential_type = NULL,
      world_id_shares_claimed = 0,
      world_id_claim_tx = NULL,
      world_id_timestamp = NULL,
      world_id_error = NULL,
      step6_status = 'LOCKED',
      cap_table_holder_count = 0,
      consensus_ledger_seq_count = 0,
      audit_confirmed_at = NULL,
      step6_error = NULL,
      step7_status = 'LOCKED',
      hermes_session_id = NULL,
      hermes_execution_id = NULL,
      hermes_tx_hash = NULL,
      hermes_action = NULL,
      hermes_timestamp = NULL,
      hermes_error = NULL,
      step8_status = 'LOCKED',
      compromise_attempt_action = NULL,
      compromise_blocked = 0,
      compromise_rejection_code = NULL,
      compromise_rejection_reason = NULL,
      compromise_timestamp = NULL,
      step8_error = NULL,
      step9_status = 'LOCKED',
      subgraph_url = NULL,
      subgraph_status = NULL,
      subgraph_indexed_block = NULL,
      subgraph_query_result = NULL,
      subgraph_error = NULL,
      subgraph_timestamp = NULL,
      updated_at = ?
    WHERE id = 'current'
  `).run(now);

  return getWorkflowState();
}
