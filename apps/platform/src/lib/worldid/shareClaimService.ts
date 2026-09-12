import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { getDb } from "@/lib/db";
import { getToken, insertEvent } from "@/lib/db/repo";
import { getWorkflowState, recordStep5WorldId } from "@/lib/workflow/judgeWorkflow";
import { worldIdHolderSignal } from "@/lib/worldid/policy";
import { logHcsAuditEvent } from "@/lib/hedera/hcsAudit";
import CompliantRwaTokenArtifact from "@/lib/evm/generated/CompliantRwaToken.json";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { TokenRecord } from "@/types";

export interface ShareClaimInput {
  investorAddress: string;
  tokenId?: string;
  idkitResult?: any;
  // If true or simulated flag passed without proof, it will be strictly rejected!
  verified?: boolean;
  nullifier?: string;
  action?: string;
  signal?: string;
}

export interface ShareClaimResult {
  success: boolean;
  verified: boolean;
  investorAddress: string;
  nullifierHash: string;
  credentialType: string;
  sharesClaimed: number;
  initialBalance: number;
  newBalance: number;
  txHash: string;
  blockNumber: number;
  explorerUrl: string;
  hcsSequenceNumber: number | null;
  workflowState: any;
}

export class ShareClaimError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = "ShareClaimError";
  }
}

// Injected test hooks for adversarial / isolated testing
let testProvider: ethers.Provider | null = null;
let testWorldVerifier: ((rpId: string, result: any) => Promise<{ success: boolean; nullifier: string; credential?: string }>) | null = null;

export function setProviderForTesting(provider: ethers.Provider | null) {
  testProvider = provider;
}

export function setWorldVerifierForTesting(
  verifier: ((rpId: string, result: any) => Promise<{ success: boolean; nullifier: string; credential?: string }>) | null
) {
  testWorldVerifier = verifier;
}

export function getEvmProvider(): ethers.Provider {
  if (testProvider) return testProvider;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL || "https://sepolia.base.org";
  return new ethers.JsonRpcProvider(rpcUrl);
}

export async function verifyWorldIdProofAndClaimShares(
  input: ShareClaimInput
): Promise<ShareClaimResult> {
  const db = getDb();

  // 1. Precondition: Step 4 Workspace Inspection must have succeeded
  const workflow = getWorkflowState();
  if (workflow.step4.status !== "SUCCESS") {
    throw new ShareClaimError(
      "Step 4 Workspace Inspection is required before World ID Portal. Complete Step 4 first.",
      400,
      "STEP4_INSPECTION_REQUIRED"
    );
  }

  // 2. Client verification flag rejection: NEVER accept verified=true from client
  if (input.verified === true && !input.idkitResult) {
    throw new ShareClaimError(
      "Client-asserted 'verified=true' is strictly rejected. A real ZK proof must be submitted for server-side verification.",
      400,
      "INVALID_PROOF_PAYLOAD"
    );
  }

  if (!input.idkitResult || typeof input.idkitResult !== "object") {
    throw new ShareClaimError(
      "Missing World ID ZK proof payload. Expected IDKit proof object.",
      400,
      "INVALID_PROOF_PAYLOAD"
    );
  }

  // 3. Configuration Validation
  const rpId = process.env.WORLD_RP_ID?.trim();
  const appId = process.env.WORLD_APP_ID?.trim() || process.env.NEXT_PUBLIC_WORLD_APP_ID?.trim();
  if (!rpId || !appId) {
    throw new ShareClaimError(
      "World ID credentials are not configured in environment (WORLD_RP_ID / WORLD_APP_ID). Fail-closed.",
      503,
      "WORLD_ID_CREDENTIALS_REQUIRED"
    );
  }

  // 4. Token Contract Deployment Validation
  const tokenContractAddress =
    process.env.COMPLIANT_RWA_TOKEN_ADDRESS?.trim() ||
    process.env.OAK_TOKEN_ADDRESS?.trim() ||
    process.env.TOKEN_CONTRACT_ADDRESS?.trim();

  if (!tokenContractAddress || !ethers.isAddress(tokenContractAddress)) {
    throw new ShareClaimError(
      "Token contract is not deployed or configured (COMPLIANT_RWA_TOKEN_ADDRESS / OAK_TOKEN_ADDRESS). Fail-closed.",
      503,
      "TOKEN_CONTRACT_NOT_DEPLOYED"
    );
  }

  // 5. Investor Address & Authentication Validation
  const investorAddress = input.investorAddress?.trim();
  if (!investorAddress || !ethers.isAddress(investorAddress)) {
    throw new ShareClaimError(
      `Invalid investor address: '${input.investorAddress}'. A valid EVM address is required.`,
      400,
      "INVALID_INVESTOR_ADDRESS"
    );
  }

  const checksummedInvestor = ethers.getAddress(investorAddress);

  // 6. Accredited Investor & Compliance Check (Decoupled from Proof of Personhood)
  // "Never equate World ID uniqueness with accredited-investor status."
  // World ID proves human uniqueness. Accreditation checks investor eligibility and sanctions.
  const existingHolder = db
    .prepare("SELECT * FROM holders WHERE account_id = ? OR evm_address = ?")
    .get(checksummedInvestor, checksummedInvestor) as any;

  if (existingHolder?.frozen === 1) {
    throw new ShareClaimError(
      "Investor account is frozen for compliance review. Fractional share allocation blocked.",
      403,
      "INVESTOR_ACCOUNT_FROZEN"
    );
  }

  if (existingHolder?.status === "REVOKED") {
    throw new ShareClaimError(
      "Investor accreditation status has been revoked. Allocation blocked.",
      403,
      "ACCREDITATION_REVOKED"
    );
  }

  // 7. Authoritative Property / Token Lineage
  const canonicalTokenId = workflow.step1.propertyId || "prop_456_oak_ave";
  const token: TokenRecord = getToken(canonicalTokenId) || {
    id: canonicalTokenId,
    blockchain: "EVM",
    network: "sepolia",
    name: "456 Oak Avenue Luxury Residences",
    symbol: "OAK-RWA",
    tokenType: "FUNGIBLE",
    decimals: 0,
    initialSupply: "1000",
    supplyType: "FINITE",
    maxSupply: "1000",
    treasuryAccountId: "0xYieldVault",
    assetCategory: "real-estate",
    memo: "Oak Avenue fractional shares",
    compliance: {
      kycRequired: true,
      freezeDefault: false,
      wipeEnabled: true,
      pauseEnabled: true,
      worldIdRequired: true,
      worldIdSelfieCheck: true,
      livenessEnabled: false,
    },
    customFee: null,
    keys: { admin: true, kyc: true, freeze: true, wipe: true, pause: true, supply: true, feeSchedule: false },
    paused: false,
    createTxId: null,
    hashscanUrl: "",
    explorerUrl: "",
    explorerName: "Etherscan",
    createdAt: new Date().toISOString(),
  };

  // 8. ZK Proof Server-Side Verification
  const expectedAction = process.env.WORLD_ACTION?.trim() || "oak-fractional-claim";
  const expectedSignal = worldIdHolderSignal(token, checksummedInvestor);

  // Validate action match if present on proof
  const proofAction = input.idkitResult.action || input.action;
  if (proofAction && proofAction !== expectedAction) {
    throw new ShareClaimError(
      `World ID action mismatch: expected '${expectedAction}', received '${proofAction}'.`,
      400,
      "ACTION_MISMATCH"
    );
  }

  // Validate signal binding
  const proofSignal = input.idkitResult.signal || input.signal;
  if (proofSignal && proofSignal !== expectedSignal) {
    throw new ShareClaimError(
      "World ID proof signal mismatch: proof is not bound to the authenticated investor address.",
      400,
      "SIGNAL_MISMATCH"
    );
  }

  // Check signal_hash if present in proof responses
  const expectedSignalHash = hashSignal(expectedSignal).toLowerCase();
  const responses = input.idkitResult.responses || [];
  for (const resp of responses) {
    if (resp.signal_hash && resp.signal_hash.toLowerCase() !== expectedSignalHash) {
      throw new ShareClaimError(
        "Proof signal hash does not match the authenticated investor address.",
        400,
        "SIGNAL_MISMATCH"
      );
    }
  }

  // Execute server-side proof exchange
  let verifiedNullifier: string;
  let verifiedCredential = "orb";

  if (testWorldVerifier) {
    const testResult = await testWorldVerifier(rpId, input.idkitResult);
    if (!testResult.success) {
      throw new ShareClaimError(
        "World ID verification failed: Proof was rejected by World API.",
        422,
        "WORLD_PROOF_REJECTED"
      );
    }
    verifiedNullifier = testResult.nullifier;
    if (testResult.credential) verifiedCredential = testResult.credential;
  } else {
    // Real World Developer API Verification
    try {
      const response = await fetch(
        `https://developer.world.org/api/v4/verify/${encodeURIComponent(rpId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.idkitResult),
          cache: "no-store",
        }
      );

      const payload = (await response.json()) as any;
      if (!response.ok || payload.success === false) {
        throw new ShareClaimError(
          payload.detail || payload.message || "World rejected the verification proof.",
          response.status >= 500 ? 502 : 422,
          payload.code || "WORLD_PROOF_REJECTED"
        );
      }

      // Extract verified nullifier from response
      const resNullifier =
        payload.nullifier ||
        payload.results?.find((r: any) => r.success && r.nullifier)?.nullifier;

      if (!resNullifier) {
        throw new ShareClaimError(
          "World ID API confirmed verification but did not return a trusted nullifier.",
          502,
          "MISSING_AUTHORITATIVE_NULLIFIER"
        );
      }
      verifiedNullifier = resNullifier;
      verifiedCredential = payload.credential || "orb";
    } catch (err: any) {
      if (err instanceof ShareClaimError) throw err;
      throw new ShareClaimError(
        `The World verification service could not be reached: ${err.message}`,
        502,
        "WORLD_SERVICE_UNAVAILABLE"
      );
    }
  }

  // Compute canonical SHA-256 nullifier hash
  const nullifierHash = createHash("sha256")
    .update(verifiedNullifier.toLowerCase())
    .digest("hex");

  // 9. Nullifier Uniqueness & Sybil Duplicate Enforcement
  const duplicateNullifierInDb = db
    .prepare("SELECT id, account_id FROM world_id_verifications WHERE nullifier_hash = ? AND status = 'VERIFIED'")
    .get(nullifierHash) as any;

  if (duplicateNullifierInDb) {
    throw new ShareClaimError(
      `Nullifier reuse detected: This World ID nullifier has already claimed fractional shares for account ${duplicateNullifierInDb.account_id}. Sybil duplicate prohibited.`,
      409,
      "NULLIFIER_ALREADY_USED"
    );
  }

  const duplicateInWorkflow = db
    .prepare("SELECT id FROM judge_workflow_state WHERE world_id_nullifier = ?")
    .get(nullifierHash) as any;

  if (duplicateInWorkflow) {
    throw new ShareClaimError(
      "Nullifier reuse detected: This World ID proof has already claimed shares in the protocol workflow.",
      409,
      "NULLIFIER_ALREADY_USED"
    );
  }

  // 10. Cap-Table Calculation & Double-Claim Protection
  // Rule: exactly 100 shares per verified investor (10% of 1,000 total supply)
  const sharesToAllocate = 100;

  // Check if investor already has shares on this token
  const existingHolderRow = db
    .prepare("SELECT * FROM holders WHERE token_id = ? AND (account_id = ? OR evm_address = ?)")
    .get(canonicalTokenId, checksummedInvestor, checksummedInvestor) as any;

  if (existingHolderRow && existingHolderRow.world_id_verified_at) {
    throw new ShareClaimError(
      `Investor ${checksummedInvestor} has already verified World ID and claimed fractional shares for this property.`,
      409,
      "ALREADY_CLAIMED"
    );
  }

  // Check remaining cap table capacity
  const allocatedHoldersCount = db
    .prepare("SELECT COUNT(*) as count FROM holders WHERE token_id = ? AND world_id_verified_at IS NOT NULL")
    .get(canonicalTokenId) as any;

  const totalAllocatedShares = (allocatedHoldersCount?.count || 0) * sharesToAllocate;
  if (totalAllocatedShares + sharesToAllocate > 1000) {
    throw new ShareClaimError(
      "Cap table allocation exhausted: All 1,000 fractional shares have been claimed.",
      400,
      "CAP_TABLE_EXHAUSTED"
    );
  }

  // 11. On-Chain Token Allocation Transaction & Balance Verification
  const provider = getEvmProvider();
  const iface = new ethers.Interface(CompliantRwaTokenArtifact.abi);

  let txHash = "";
  let blockNumber = 0;
  let initialBalance = 0;
  let newBalance = sharesToAllocate;

  // If running with injected test provider or live RPC
  try {
    const code = await provider.getCode(tokenContractAddress);
    if (code === "0x") {
      throw new ShareClaimError(
        `Token contract at ${tokenContractAddress} has no bytecode deployed on the target network.`,
        503,
        "TOKEN_CONTRACT_NOT_DEPLOYED"
      );
    }

    // Read initial on-chain balance
    const rawInitialBalance = await provider.call({
      to: tokenContractAddress,
      data: iface.encodeFunctionData("balanceOf", [checksummedInvestor]),
    });
    const [decodedInitial] = iface.decodeFunctionResult("balanceOf", rawInitialBalance);
    initialBalance = Number(decodedInitial);

    // If client provided a pre-signed transaction hash or operator executes
    const inputTxHash = input.idkitResult?.txHash || (input as any).txHash;
    if (inputTxHash && ethers.isHexString(inputTxHash, 32)) {
      txHash = inputTxHash;
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        throw new ShareClaimError(
          `Share allocation transaction ${txHash} is pending or not found on-chain.`,
          400,
          "TRANSACTION_NOT_FOUND"
        );
      }
      if (receipt.status === 0) {
        throw new ShareClaimError(
          `Share allocation transaction ${txHash} reverted on-chain.`,
          422,
          "TRANSACTION_FAILED"
        );
      }
      blockNumber = receipt.blockNumber;

      // Verify balance increased
      const rawNewBalance = await provider.call({
        to: tokenContractAddress,
        data: iface.encodeFunctionData("balanceOf", [checksummedInvestor]),
      });
      const [decodedNew] = iface.decodeFunctionResult("balanceOf", rawNewBalance);
      newBalance = Number(decodedNew);
      if (newBalance <= initialBalance) {
        throw new ShareClaimError(
          "On-chain balance verification failed: Investor balance did not increase after transaction.",
          500,
          "BALANCE_VERIFICATION_FAILED"
        );
      }
    } else {
      // Execute transfer via EVM operator wallet if private key is configured
      const operatorKey = process.env.EVM_OPERATOR_PRIVATE_KEY?.trim();
      if (operatorKey) {
        const wallet = new ethers.Wallet(operatorKey, provider);
        const tokenContract = new ethers.Contract(tokenContractAddress, iface, wallet);

        // Approve investor if gate enabled
        try {
          const approveTx = await tokenContract.setApproved(checksummedInvestor, true);
          await approveTx.wait();
        } catch {
          // May already be approved
        }

        // Transfer 100 shares
        const transferTx = await tokenContract.transfer(checksummedInvestor, sharesToAllocate);
        const receipt = await transferTx.wait();
        if (!receipt || receipt.status === 0) {
          throw new ShareClaimError(
            "On-chain share transfer transaction reverted.",
            422,
            "TRANSACTION_FAILED"
          );
        }
        txHash = receipt.hash;
        blockNumber = receipt.blockNumber;

        // Verify balance
        const updatedBal = await tokenContract.balanceOf(checksummedInvestor);
        newBalance = Number(updatedBal);
        if (newBalance <= initialBalance) {
          throw new ShareClaimError(
            "Investor balance did not increase after transfer transaction.",
            500,
            "BALANCE_VERIFICATION_FAILED"
          );
        }
      } else {
        // If no operator key configured, require client transaction hash or report fail-closed
        throw new ShareClaimError(
          "EVM operator private key (EVM_OPERATOR_PRIVATE_KEY) is not configured to broadcast share allocation.",
          503,
          "EVM_OPERATOR_UNCONFIGURED"
        );
      }
    }
  } catch (err: any) {
    if (err instanceof ShareClaimError) throw err;
    throw new ShareClaimError(
      `Share allocation execution failed on-chain: ${err.message}`,
      422,
      "TRANSACTION_FAILED",
      err.stack
    );
  }

  // 12. Authoritative Persistence & Audit
  const now = new Date().toISOString();

  // Upsert holder
  db.prepare(`
    INSERT INTO holders (
      token_id, account_id, evm_address, associated, kyc_granted,
      world_id_verified_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 1, ?, 'WHITELISTED', ?, ?)
    ON CONFLICT(token_id, account_id) DO UPDATE SET
      evm_address = excluded.evm_address,
      kyc_granted = 1,
      world_id_verified_at = excluded.world_id_verified_at,
      status = 'WHITELISTED',
      updated_at = excluded.updated_at
  `).run(
    canonicalTokenId,
    checksummedInvestor,
    checksummedInvestor,
    now,
    now,
    now
  );

  // Insert world_id_verifications record
  db.prepare(`
    INSERT INTO world_id_verifications (
      token_id, account_id, check_kind, status, action,
      expected_signal, nullifier_hash, credential, verified_at, created_at, updated_at
    ) VALUES (?, ?, 'orb', 'VERIFIED', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    canonicalTokenId,
    checksummedInvestor,
    expectedAction,
    expectedSignal,
    nullifierHash,
    verifiedCredential,
    now,
    now,
    now
  );

  // Record audit events
  insertEvent({
    tokenId: canonicalTokenId,
    accountId: checksummedInvestor,
    type: "WORLDID_VERIFY",
    detail: {
      check: "orb",
      nullifierHash,
      credential: verifiedCredential,
      provider: "World ID",
      action: expectedAction,
      verifiedAt: now,
    },
    txId: txHash,
  });

  insertEvent({
    tokenId: canonicalTokenId,
    accountId: checksummedInvestor,
    type: "TRANSFER",
    detail: {
      from: "0xTreasury",
      to: checksummedInvestor,
      amount: sharesToAllocate,
      sharePercentage: 10.0,
      txHash,
      blockNumber,
    },
    txId: txHash,
  });

  // Hedera HCS Audit Log: Anchor verified allocation to immutable consensus
  let hcsSequenceNumber: number | null = null;
  try {
    const hcsReceipt = await logHcsAuditEvent({
      event: "INVESTOR_WORLD_ID_VERIFIED",
      propertyId: "prop_456_oak_ave",
      actor: checksummedInvestor,
      token: "OAK-RWA",
      network: "Base Sepolia",
      txId: txHash,
      txLink: `https://sepolia.basescan.org/tx/${txHash}`,
      memo: `World ID verified fractional share allocation (${sharesToAllocate} shares)`,
      metadata: {
        investor: checksummedInvestor,
        sharesClaimed: sharesToAllocate,
        nullifierHash,
        credential: verifiedCredential,
        blockNumber,
      },
    });
    if (hcsReceipt.status === "CONFIRMED" && hcsReceipt.sequenceNumber) {
      hcsSequenceNumber = hcsReceipt.sequenceNumber;
    }
  } catch (hcsErr) {
    console.warn("[shareClaimService] HCS audit logging error:", hcsErr);
  }

  // Update canonical workflow state (advances to Step 6)
  const workflowState = recordStep5WorldId({
    verified: true,
    nullifierHash,
    credentialType: verifiedCredential,
    sharesClaimed: sharesToAllocate,
    claimTxId: txHash,
  });

  return {
    success: true,
    verified: true,
    investorAddress: checksummedInvestor,
    nullifierHash,
    credentialType: verifiedCredential,
    sharesClaimed: sharesToAllocate,
    initialBalance,
    newBalance,
    txHash,
    blockNumber,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    hcsSequenceNumber,
    workflowState,
  };
}
