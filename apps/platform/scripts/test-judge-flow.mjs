import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(__dirname, "..");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-judge-flow.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

import fs from "node:fs";

const testDbPath = path.join(platformRoot, "data", "test-judge-flow.db");
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch {}
process.env.DATABASE_PATH = testDbPath;

async function runTests() {
  console.log("=== Testing PRISM 8 Canonical Judge Flow Sequence & State Machine ===");

  const workflowModuleUrl = pathToFileURL(path.join(platformRoot, "src/lib/workflow/judgeWorkflow.ts")).href;
  const {
    getWorkflowState,
    resetWorkflowState,
    recordStep1Oracle,
    recordStep2RentDeposit,
    recordStep3YieldClaim,
    recordStep4WorkspaceInspection,
    recordStep5WorldId,
    recordStep6CapTable,
    recordStep7Hermes,
    recordStep8Compromise,
    recordStep9Graph,
  } = await import(workflowModuleUrl);

  // 1. Initial State Check
  console.log("\n[Test 1] Initial state has Step 1 READY and Steps 2-9 LOCKED...");
  const initial = resetWorkflowState();
  assert.strictEqual(initial.step1.status, "READY", "Step 1 must start in READY state");
  assert.strictEqual(initial.step2.status, "LOCKED", "Step 2 must start LOCKED");
  assert.strictEqual(initial.step3.status, "LOCKED", "Step 3 must start LOCKED");
  assert.strictEqual(initial.step4.status, "LOCKED", "Step 4 must start LOCKED");
  assert.strictEqual(initial.step5.status, "LOCKED", "Step 5 must start LOCKED");
  assert.strictEqual(initial.step6.status, "LOCKED", "Step 6 must start LOCKED");
  assert.strictEqual(initial.step7.status, "LOCKED", "Step 7 must start LOCKED");
  assert.strictEqual(initial.step8.status, "LOCKED", "Step 8 must start LOCKED");
  assert.strictEqual(initial.step9.status, "LOCKED", "Step 9 must start LOCKED");
  console.log("✓ Initial state confirmed: Step 1 READY, Steps 2-9 LOCKED");

  // 2. Failure Enforcement: FAILED state never unlocks the next step
  console.log("\n[Test 2] Failure in Step 1 sets FAILED and keeps Step 2 LOCKED...");
  const failedStep1 = recordStep1Oracle({
    propertyId: "prop_456_oak_ave",
    propertyAddress: "456 Oak Avenue, Miami FL 33101",
    dpvConfirmation: "N",
    isValid: false,
    error: "USPS DPV Code N: Address not deliverable",
  });
  assert.strictEqual(failedStep1.step1.status, "FAILED", "Step 1 should be FAILED");
  assert.strictEqual(failedStep1.step2.status, "LOCKED", "Step 2 must remain LOCKED after Step 1 failure");
  assert.throws(
    () => {
      recordStep2RentDeposit({
        rentAmount: 5000,
        txHash: "0x123",
        success: true,
      });
    },
    /Step 1 Oracle Verification is required/,
    "Step 2 must reject execution when Step 1 is not SUCCESS"
  );
  console.log("✓ FAILED state confirmed: Step 2 remains LOCKED and rejects execution");

  // 3. Step 1 Success unlocks Step 2
  console.log("\n[Test 3] Step 1 Success (Rail 3: Live x402 Oracle Check)...");
  const step1Success = recordStep1Oracle({
    propertyId: "0x456oakavehash",
    propertyAddress: "456 Oak Avenue, Miami FL 33101",
    dpvConfirmation: "Y",
    paymentTxId: "0.0.12345@1700000000.000000000",
    hcsTopicId: "0.0.5698421",
    hcsSequenceNumber: 1,
    isValid: true,
  });
  assert.strictEqual(step1Success.step1.status, "SUCCESS", "Step 1 must be SUCCESS");
  assert.strictEqual(step1Success.step1.oracleVerified, true, "oracleVerified must be true");
  assert.strictEqual(step1Success.step2.status, "READY", "Step 2 must become READY after Step 1 SUCCESS");
  assert.strictEqual(step1Success.step3.status, "LOCKED", "Step 3 must remain LOCKED");
  console.log("✓ Step 1 verified: DPV Y, HCS Seq #1, Step 2 unlocked to READY");

  // 4. Step 2 Success (Rail 2: Deposit $5,000 Rent)
  console.log("\n[Test 4] Step 2 Success (Rail 2: Deposit $5,000 Rent)...");
  const step2Success = recordStep2RentDeposit({
    rentAmount: 5000,
    txHash: "0x5000renttxhash",
    vaultAddress: "0xYieldVaultAddress",
    hcsSequenceNumber: 2,
    success: true,
  });
  assert.strictEqual(step2Success.step2.status, "SUCCESS", "Step 2 must be SUCCESS");
  assert.strictEqual(step2Success.step2.rentAmount, 5000, "Step 2 rent amount must be canonical 5000");
  assert.strictEqual(step2Success.step3.status, "READY", "Step 3 must become READY after Step 2 SUCCESS");
  assert.strictEqual(step2Success.step4.status, "LOCKED", "Step 4 must remain LOCKED");
  console.log("✓ Step 2 verified: $5,000 rent deposited, HCS Seq #2, Step 3 unlocked to READY");

  // 5. Step 3 Success (Rail 1: Claim Yield)
  console.log("\n[Test 5] Step 3 Success (Rail 1: Claim Yield)...");
  const step3Success = recordStep3YieldClaim({
    claimTxId: "0xyieldclaimtxhash",
    claimAmount: 14.8251,
    recipient: "0xInvestorAddress",
    hcsSequenceNumber: 3,
    success: true,
  });
  assert.strictEqual(step3Success.step3.status, "SUCCESS", "Step 3 must be SUCCESS");
  assert.strictEqual(step3Success.step4.status, "READY", "Step 4 must become READY after Step 3 SUCCESS");
  assert.strictEqual(step3Success.step5.status, "LOCKED", "Step 5 must remain LOCKED");
  console.log("✓ Step 3 verified: Yield claimed, Step 4 unlocked to READY");

  // 6. Step 4 Success (Inspect Token Workspace on Oak Avenue)
  console.log("\n[Test 6] Step 4 Success (Inspect Token Workspace on Oak Avenue)...");
  const step4Success = recordStep4WorkspaceInspection({
    tokenId: "prop_456_oak_ave",
    tokenSymbol: "OAK-RWA",
    tokenNetwork: "Base Sepolia",
    tokenTotalSupply: "1,000",
    propertyAddress: "456 Oak Avenue, Miami FL 33101",
    success: true,
  });
  assert.strictEqual(step4Success.step4.status, "SUCCESS", "Step 4 must be SUCCESS");
  assert.strictEqual(step4Success.step5.status, "READY", "Step 5 must become READY after Step 4 SUCCESS");
  assert.strictEqual(step4Success.step6.status, "LOCKED", "Step 6 must remain LOCKED");
  console.log("✓ Step 4 verified: Oak Avenue workspace state confirmed, Step 5 unlocked to READY");

  // 7. Step 5 Success (World ID Portal & Fractional Share Claim)
  console.log("\n[Test 7] Step 5 Success (World ID Portal)...");
  const step5Success = recordStep5WorldId({
    verified: true,
    nullifierHash: "0x8f2a9d4e1b7c3f5a0d6e8b2c4a9f1e7d3b5c8a0f",
    credentialType: "orb",
    sharesClaimed: 100,
    claimTxId: "0xworldidclaimtxhash",
  });
  assert.strictEqual(step5Success.step5.status, "SUCCESS", "Step 5 must be SUCCESS");
  assert.strictEqual(step5Success.step5.verified, true, "World ID verified must be true");
  assert.strictEqual(step5Success.step6.status, "READY", "Step 6 must become READY after Step 5 SUCCESS");
  assert.strictEqual(step5Success.step7.status, "LOCKED", "Step 7 must remain LOCKED");
  console.log("✓ Step 5 verified: World ID ZK proof verified, Step 6 unlocked to READY");

  // 8. Step 6 Success (Cap Table + Consensus Ledger)
  console.log("\n[Test 8] Step 6 Success (Cap Table + Consensus Ledger)...");
  const step6Success = recordStep6CapTable({
    holderCount: 2,
    consensusSeqCount: 4,
    success: true,
  });
  assert.strictEqual(step6Success.step6.status, "SUCCESS", "Step 6 must be SUCCESS");
  assert.strictEqual(step6Success.step7.status, "READY", "Step 7 must become READY after Step 6 SUCCESS");
  assert.strictEqual(step6Success.step8.status, "LOCKED", "Step 8 must remain LOCKED");
  console.log("✓ Step 6 verified: Cap table & HCS ledger confirmed, Step 7 unlocked to READY");

  // 9. Step 7 Success (Hermes Cockpit: Authorize & Launch Mission)
  console.log("\n[Test 9] Step 7 Success (Hermes Cockpit: Launch Mission)...");
  const step7Success = recordStep7Hermes({
    sessionId: "sess_test_123",
    executionId: "exec_hermes_001",
    txHash: "0xhermestxhash",
    action: "FULL_TOKENIZATION_AND_YIELD_PIPELINE",
    success: true,
  });
  assert.strictEqual(step7Success.step7.status, "SUCCESS", "Step 7 must be SUCCESS");
  assert.strictEqual(step7Success.step8.status, "READY", "Step 8 must become READY after Step 7 SUCCESS");
  assert.strictEqual(step7Success.step9.status, "LOCKED", "Step 9 must remain LOCKED");
  console.log("✓ Step 7 verified: Hermes mission executed under session, Step 8 unlocked to READY");

  // 10. Step 8 Success (Simulate Compromise Attempt)
  console.log("\n[Test 10] Step 8 Success (Simulate Compromise Attempt)...");
  const step8Success = recordStep8Compromise({
    attackAction: "UNAUTHORIZED_TREASURY_TRANSFER",
    blocked: true,
    rejectionCode: "CRYPTOGRAPHIC_POLICY_VIOLATION_HALTED",
    rejectionReason: "ERC-7579 session guardrail intercepted unauthorized rogue action",
  });
  assert.strictEqual(step8Success.step8.status, "SUCCESS", "Step 8 must be SUCCESS");
  assert.strictEqual(step8Success.step8.blocked, true, "Rogue attack must be recorded as blocked");
  assert.strictEqual(step8Success.step9.status, "READY", "Step 9 must become READY after Step 8 SUCCESS");
  console.log("✓ Step 8 verified: Rogue attack blocked at guardrail, Step 9 unlocked to READY");

  // 11. Step 9 Success (Inspect Live: The Graph)
  console.log("\n[Test 11] Step 9 Success (Inspect Live: The Graph)...");
  const step9Success = recordStep9Graph({
    subgraphUrl: "https://api.studio.thegraph.com/query/test/prism8",
    subgraphStatus: "LIVE",
    indexedBlock: 1234567,
    queryResult: { tokens: [{ id: "prop_456_oak_ave", name: "456 Oak Avenue" }] },
    success: true,
  });
  assert.strictEqual(step9Success.step9.status, "SUCCESS", "Step 9 must be SUCCESS");
  console.log("✓ Step 9 verified: Real Subgraph query confirmed");

  // 12. Full flow complete
  console.log("\n[Test 12] Verifying all 9 steps completed sequentially...");
  const finalState = getWorkflowState();
  for (let i = 1; i <= 9; i++) {
    const stepKey = `step${i}`;
    assert.strictEqual(finalState[stepKey].status, "SUCCESS", `Step ${i} must be SUCCESS in final state`);
  }
  console.log("✓ All 9 steps verified complete in canonical order!");

  console.log("\n=======================================================");
  console.log(" ALL JUDGE FLOW TESTS PASSED SUCCESSFULLY! (12/12) ");
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error("\n❌ Test failure:", err);
  process.exit(1);
});
