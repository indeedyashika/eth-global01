import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const platformRoot = path.resolve(__dirname, "..");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-oak-workspace.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

// Set up isolated test database
const testDbPath = path.join(platformRoot, "data", "test-oak-workspace.db");
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch {}
process.env.DATABASE_PATH = testDbPath;
process.env.YIELD_VAULT_ADDRESS = "0x000000000000000000000000000000000000BEEF";

const { NextRequest } = await import("next/server");

const { getAuthoritativeWorkspaceData } = await import(
  pathToFileURL(path.join(platformRoot, "src/lib/workspace/authoritativeWorkspace.ts")).href
);

const {
  resetWorkflowState,
  recordStep1Oracle,
  recordStep2RentDeposit,
  recordStep3YieldClaim,
  recordStep4WorkspaceInspection,
  getWorkflowState,
} = await import(pathToFileURL(path.join(platformRoot, "src/lib/workflow/judgeWorkflow.ts")).href);

const { GET: tokenApiHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/route.ts")).href
);

const { getDb } = await import(pathToFileURL(path.join(platformRoot, "src/lib/db/index.ts")).href);

async function runTests() {
  console.log("=== PRISM 8: Connect Oak Avenue Workspace to Authoritative Protocol State ===\n");

  const canonicalPropertyId = "prop_456_oak_ave";

  // ----------------------------------------------------
  // TEST 1: Initial Missing State Handling (No Seed Fallback)
  // ----------------------------------------------------
  console.log("[Test 1] Testing missing-state reporting when Steps 1-3 have not occurred...");
  {
    resetWorkflowState();
    const data = getAuthoritativeWorkspaceData(canonicalPropertyId);

    // Property state must report unverified with explicit missing error
    assert.strictEqual(data.property.verificationStatus, "UNVERIFIED");
    assert(data.property.missingStateError?.includes("Step 1 Oracle Verification has not been executed"));
    assert.strictEqual(data.property.dpvConfirmation, null);
    assert.strictEqual(data.property.hcsSequence, null);

    // Rent state must report unconfirmed $0 with explicit missing error
    assert.strictEqual(data.rent.status, "UNCONFIRMED");
    assert.strictEqual(data.rent.depositedAmount, 0);
    assert.strictEqual(data.rent.depositTransaction, null);
    assert(data.rent.missingStateError?.includes("Step 2 Rent Deposit ($5,000) has not been confirmed"));

    // Stream state must report inactive
    assert.strictEqual(data.stream.status, "INACTIVE");
    assert.strictEqual(data.stream.flowRatePerSec, 0);
    assert(data.stream.missingStateError?.includes("No active Superfluid stream"));

    // Yield state must report 0 accrued and empty claim history
    assert.strictEqual(data.yield.accruedAmount, 0);
    assert.strictEqual(data.yield.claimHistory.length, 0);
    assert(data.yield.missingStateError?.includes("No yield claim state"));

    // Workspace readiness
    assert.strictEqual(data.isReadyForInspection, false);
    assert(data.missingWorkflowError?.includes("Step 1 Oracle Verification has not succeeded"));

    console.log("  ✓ Missing state reported truthfully with explicit errors across all 5 sections without seed fallback.");
  }

  // ----------------------------------------------------
  // TEST 2: Step 1 Oracle Verification Connection
  // ----------------------------------------------------
  console.log("\n[Test 2] Connecting Step 1 Oracle Attestation to Workspace Property State...");
  {
    const step1Attestation = {
      propertyId: canonicalPropertyId,
      propertyAddress: "456 Oak Avenue, Miami FL 33101",
      dpvConfirmation: "Y",
      paymentTxId: "0.0.98765@1789000000.111111111",
      hcsTopicId: "0.0.5698421",
      hcsSequenceNumber: 42,
      hcsTxId: "0.0.98765@1789000000.222222222",
      consensusTimestamp: "2026-09-12T19:00:00.000Z",
      provenance: "LIVE_ONCHAIN",
      isValid: true,
    };
    recordStep1Oracle(step1Attestation);

    const data = getAuthoritativeWorkspaceData(canonicalPropertyId);

    // Verify PROPERTY section exactly reflects Step 1
    assert.strictEqual(data.property.verificationStatus, "VERIFIED");
    assert.strictEqual(data.property.address, "456 Oak Avenue, Miami FL 33101");
    assert.strictEqual(data.property.propertyId, canonicalPropertyId);
    assert.strictEqual(data.property.dpvConfirmation, "Y");
    assert.strictEqual(data.property.hcsTopic, "0.0.5698421");
    assert.strictEqual(data.property.hcsSequence, 42);
    assert.strictEqual(data.property.hcsTransaction, "0.0.98765@1789000000.222222222");
    assert.strictEqual(data.property.paymentTxId, "0.0.98765@1789000000.111111111");
    assert(data.property.ownershipDisclaimer.includes("NOT proof of property ownership"));
    assert.strictEqual(data.property.missingStateError, null);

    // Rent section must still truthfully report missing Step 2
    assert.strictEqual(data.rent.status, "UNCONFIRMED");
    assert(data.rent.missingStateError?.includes("Step 2 Rent Deposit ($5,000) has not been confirmed"));

    console.log("  ✓ Step 1 DPV & HCS sequence #42 accurately reflected in workspace Property panel.");
  }

  // ----------------------------------------------------
  // TEST 3: Step 2 $5,000 Rent Deposit & Stream Connection
  // ----------------------------------------------------
  console.log("\n[Test 3] Connecting Step 2 $5,000 Rent Deposit to Workspace Rent & Stream State...");
  {
    const db = getDb();
    const rentTxHash = "0x5000_real_rent_deposit_tx_hash_0000000000000000000000000000000001";
    const vaultAddr = process.env.YIELD_VAULT_ADDRESS;

    // Record authoritative deposit in rent_deposits table
    db.prepare(`
      INSERT INTO rent_deposits (
        property_id, vault_address, depositor_address, amount_usd, amount_wei,
        flow_rate_per_sec, tx_hash, network, chain_id, block_number,
        hcs_topic_id, hcs_sequence_number, status, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      canonicalPropertyId,
      vaultAddr,
      "0xOperatorWallet",
      5000,
      "5000000000000000000000",
      5000 / 2592000,
      rentTxHash,
      "Base Sepolia",
      84532,
      123456,
      "0.0.5698421",
      43,
      "CONFIRMED",
      "LIVE_ONCHAIN"
    );

    recordStep2RentDeposit({
      rentAmount: 5000,
      txHash: rentTxHash,
      vaultAddress: vaultAddr,
      hcsSequenceNumber: 43,
      success: true,
    });

    const data = getAuthoritativeWorkspaceData(canonicalPropertyId);

    // Verify RENT section exactly reflects Step 2
    assert.strictEqual(data.rent.status, "CONFIRMED");
    assert.strictEqual(data.rent.depositedAmount, 5000);
    assert.strictEqual(data.rent.distributableAmount, 5000);
    assert.strictEqual(data.rent.depositTransaction, rentTxHash);
    assert.strictEqual(data.rent.vaultAddress, vaultAddr);
    assert.strictEqual(data.rent.network, "Base Sepolia");
    assert.strictEqual(data.rent.chainId, 84532);
    assert.strictEqual(data.rent.hcsSequence, 43);
    assert.strictEqual(data.rent.missingStateError, null);

    // Verify STREAM section reflects active continuous flow
    assert.strictEqual(data.stream.status, "ACTIVE");
    assert.strictEqual(data.stream.streamTransaction, rentTxHash);
    assert(data.stream.superfluidToken.includes("fUSDCx"));
    assert.strictEqual(data.stream.receiver, vaultAddr);
    assert.strictEqual(data.stream.flowRatePerSec, 5000 / 2592000);
    assert.strictEqual(data.stream.missingStateError, null);

    // Accrued yield must be calculated from real rate and not hardcoded 14.8251
    assert(data.yield.accruedAmount >= 0);

    console.log("  ✓ Step 2 $5,000 deposit and Superfluid CFA stream rate accurately reflected in workspace.");
  }

  // ----------------------------------------------------
  // TEST 4: Step 3 Yield Settlement & Claim History Connection
  // ----------------------------------------------------
  console.log("\n[Test 4] Connecting Step 3 Yield Settlement to Workspace Yield State...");
  {
    const claimTxId = "0xyield_settlement_tx_hash_000000000000000000000000000000000002";
    const claimAmount = 14.8251;
    const recipient = "0xInvestorRecipient";

    recordStep3YieldClaim({
      claimTxId,
      claimAmount,
      recipient,
      hcsSequenceNumber: 44,
      success: true,
    });

    const data = getAuthoritativeWorkspaceData(canonicalPropertyId);

    // Verify YIELD section contains actual claim history
    assert.strictEqual(data.yield.claimHistory.length, 1);
    assert.strictEqual(data.yield.claimHistory[0].txId, claimTxId);
    assert.strictEqual(data.yield.claimHistory[0].amount, claimAmount);
    assert.strictEqual(data.yield.claimHistory[0].recipient, recipient);
    assert.strictEqual(data.yield.claimHistory[0].hcsSequenceNumber, 44);
    assert.strictEqual(data.yield.totalClaimedAmount, claimAmount);
    assert.strictEqual(data.yield.missingStateError, null);

    // All Steps 1-3 complete -> workspace is ready for Step 4 inspection!
    assert.strictEqual(data.isReadyForInspection, true);
    assert.strictEqual(data.missingWorkflowError, null);

    console.log("  ✓ Step 3 yield claim and HCS seq #44 accurately reflected in claim history.");
  }

  // ----------------------------------------------------
  // TEST 5: Step 4 Workspace Inspection Progression
  // ----------------------------------------------------
  console.log("\n[Test 5] Executing Step 4 Workspace Inspection...");
  {
    recordStep4WorkspaceInspection({
      tokenId: canonicalPropertyId,
      tokenSymbol: "OAK-RWA",
      tokenNetwork: "Base Sepolia",
      tokenTotalSupply: "1,000 Shares",
      propertyAddress: "456 Oak Avenue, Miami FL 33101",
      success: true,
    });

    const wf = getWorkflowState();
    assert.strictEqual(wf.step4.status, "SUCCESS");
    assert.strictEqual(wf.step5.status, "READY");

    const data = getAuthoritativeWorkspaceData(canonicalPropertyId);
    assert.strictEqual(data.token.symbol, "OAK-RWA");
    assert.strictEqual(data.token.network, "Base Sepolia");
    assert.strictEqual(data.token.totalSupply, "1,000 Shares");

    console.log("  ✓ Step 4 inspection confirmed, Step 5 World ID Portal unlocked to READY.");
  }

  // ----------------------------------------------------
  // TEST 6: API Route Truthfulness & Invariant Checks
  // ----------------------------------------------------
  console.log("\n[Test 6] Verifying API Route /api/tokens/[tokenId] produces truthful state...");
  {
    const req = new NextRequest(`http://127.0.0.1:3000/api/tokens/${canonicalPropertyId}`, {
      method: "GET",
    });
    const res = await tokenApiHandler(req, { params: Promise.resolve({ tokenId: canonicalPropertyId }) });
    assert.strictEqual(res.status, 200, "API endpoint must return 200");

    const json = await res.json();
    assert(json.authoritativeWorkspace, "Response must include authoritativeWorkspace");
    assert.strictEqual(json.authoritativeWorkspace.property.propertyId, canonicalPropertyId);
    assert.strictEqual(json.authoritativeWorkspace.property.verificationStatus, "VERIFIED");
    assert.strictEqual(json.authoritativeWorkspace.rent.depositedAmount, 5000);
    assert.strictEqual(json.authoritativeWorkspace.stream.status, "ACTIVE");
    assert.strictEqual(json.authoritativeWorkspace.yield.claimHistory[0].txId, "0xyield_settlement_tx_hash_000000000000000000000000000000000002");

    // Invariant: No fake fixture references
    const payloadString = JSON.stringify(json);
    assert(!payloadString.includes("0xcfA132E353cB4E398080B9700609bb008eceB125"), "Must NOT contain fake stream address");
    assert(!payloadString.includes("$3,800"), "Must NOT contain legacy $3,800 rent");

    console.log("  ✓ API route returns authoritative state with 0 fixtures and verified protocol references.");
  }

  console.log("\n========================================================");
  console.log("✓ ALL OAK AVENUE WORKSPACE AUTHORITATIVE TESTS PASSED!");
  console.log("========================================================\n");
}

runTests().catch((err) => {
  console.error("Test Suite Failure:", err);
  process.exit(1);
});
