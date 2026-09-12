import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const platformRoot = path.resolve(__dirname, "..");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-worldid-share-claim.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

// Set up isolated test database
const testDbPath = path.join(platformRoot, "data", "test-worldid-share-claim.db");
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch {}
process.env.DATABASE_PATH = testDbPath;

import { pathToFileURL } from "node:url";

const { ethers } = await import("ethers");
const { getDb } = await import(pathToFileURL(path.join(platformRoot, "src/lib/db/index.ts")).href);
const {
  verifyWorldIdProofAndClaimShares,
  ShareClaimError,
  setProviderForTesting,
  setWorldVerifierForTesting,
} = await import(pathToFileURL(path.join(platformRoot, "src/lib/worldid/shareClaimService.ts")).href);

const CompliantRwaTokenArtifact = JSON.parse(
  fs.readFileSync(path.join(platformRoot, "src/lib/evm/generated/CompliantRwaToken.json"), "utf8")
);

console.log("=== PRISM 8: Real World ID Verification & Fractional Share Claim Tests ===\n");

async function runTests() {
  const db = getDb();
  const iface = new ethers.Interface(CompliantRwaTokenArtifact.abi);

  // Setup test environment variables
  const validTokenAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  process.env.WORLD_RP_ID = "rp_prism8_test_suite";
  process.env.WORLD_APP_ID = "app_prism8_test_suite";
  process.env.WORLD_ACTION = "oak-fractional-claim";
  process.env.COMPLIANT_RWA_TOKEN_ADDRESS = validTokenAddress;

  const testInvestor = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  // Helper to establish Step 1-4 prerequisite state in database
  function setupPrerequisites() {
    db.prepare(`
      INSERT OR IGNORE INTO tokens (id, blockchain, network, name, symbol, token_type, decimals, initial_supply, supply_type, treasury_account_id)
      VALUES ('prop_456_oak_ave', 'EVM', 'sepolia', '456 Oak Avenue Luxury Residences', 'OAK-RWA', 'FUNGIBLE', 0, '1000', 'FINITE', '0xYieldVault')
    `).run();

    db.prepare("DELETE FROM judge_workflow_state WHERE id = 'current'").run();
    db.prepare(`
      INSERT INTO judge_workflow_state (
        id, current_step,
        step1_status, oracle_dpv, oracle_hcs_seq, property_id,
        step2_status, rent_deposited_amount, rent_hcs_seq,
        step3_status, claim_amount, claim_hcs_seq,
        step4_status, step5_status
      ) VALUES (
        'current', 4,
        'SUCCESS', 'Y', 42, 'prop_456_oak_ave',
        'SUCCESS', 5000, 43,
        'SUCCESS', 14.8251, 44,
        'SUCCESS', 'READY'
      )
    `).run();
  }

  // Helper mock provider
  function createMockProvider(initialBal = 0n, newBal = 100n, status = 1) {
    let callCount = 0;
    return {
      async getCode(address) {
        return address.toLowerCase() === validTokenAddress.toLowerCase() ? "0x60806040..." : "0x";
      },
      async call({ to, data }) {
        if (data.startsWith(iface.getFunction("balanceOf").selector)) {
          callCount++;
          const bal = callCount === 1 ? initialBal : newBal;
          return iface.encodeFunctionResult("balanceOf", [bal]);
        }
        return "0x";
      },
      async getTransactionReceipt(hash) {
        return {
          hash,
          status,
          blockNumber: 54321,
          to: validTokenAddress,
          from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        };
      },
    };
  }

  // ----------------------------------------------------
  // Test 1: Missing World ID Credentials
  // ----------------------------------------------------
  console.log("[Test 1] Testing missing World ID credentials...");
  {
    setupPrerequisites();
    const savedRpId = process.env.WORLD_RP_ID;
    delete process.env.WORLD_RP_ID;

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        idkitResult: { proof: ["0x1"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "WORLD_ID_CREDENTIALS_REQUIRED");
      assert.strictEqual(err.status, 503);
    } finally {
      process.env.WORLD_RP_ID = savedRpId;
    }
    assert(threw, "Must fail closed if WORLD_RP_ID is not configured");
    console.log("  ✓ Missing World ID credentials fails closed with HTTP 503.");
  }

  // ----------------------------------------------------
  // Test 2: Missing Token Contract Address
  // ----------------------------------------------------
  console.log("\n[Test 2] Testing missing token contract address...");
  {
    setupPrerequisites();
    const savedTokenAddr = process.env.COMPLIANT_RWA_TOKEN_ADDRESS;
    delete process.env.COMPLIANT_RWA_TOKEN_ADDRESS;
    delete process.env.OAK_TOKEN_ADDRESS;
    delete process.env.TOKEN_CONTRACT_ADDRESS;

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        idkitResult: { proof: ["0x1"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "TOKEN_CONTRACT_NOT_DEPLOYED");
      assert.strictEqual(err.status, 503);
    } finally {
      process.env.COMPLIANT_RWA_TOKEN_ADDRESS = savedTokenAddr;
    }
    assert(threw, "Must fail closed if token contract is not configured");
    console.log("  ✓ Missing token contract fails closed with HTTP 503.");
  }

  // ----------------------------------------------------
  // Test 3: Step 4 Workspace Inspection Prerequisite
  // ----------------------------------------------------
  console.log("\n[Test 3] Testing Step 4 Workspace Inspection prerequisite...");
  {
    db.prepare("DELETE FROM judge_workflow_state WHERE id = 'current'").run();
    db.prepare(`
      INSERT INTO judge_workflow_state (id, current_step, step4_status, step5_status)
      VALUES ('current', 3, 'LOCKED', 'LOCKED')
    `).run();

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        idkitResult: { proof: ["0x1"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "STEP4_INSPECTION_REQUIRED");
      assert.strictEqual(err.status, 400);
    }
    assert(threw, "Must reject if Step 4 is not SUCCESS");
    console.log("  ✓ Step 4 prerequisite strictly enforced.");
  }

  // ----------------------------------------------------
  // Test 4: Client Asserting verified=true Rejected
  // ----------------------------------------------------
  console.log("\n[Test 4] Testing client asserting 'verified=true' without proof...");
  {
    setupPrerequisites();
    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        verified: true, // Fake client assertion
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "INVALID_PROOF_PAYLOAD");
      assert.strictEqual(err.status, 400);
    }
    assert(threw, "Client cannot assert verified=true without ZK proof");
    console.log("  ✓ Client asserted 'verified=true' strictly rejected.");
  }

  // ----------------------------------------------------
  // Test 5: Action Mismatch Rejected
  // ----------------------------------------------------
  console.log("\n[Test 5] Testing action mismatch rejection...");
  {
    setupPrerequisites();
    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        action: "rogue-action-spoof",
        idkitResult: { action: "rogue-action-spoof", proof: ["0x1"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "ACTION_MISMATCH");
      assert.strictEqual(err.status, 400);
    }
    assert(threw, "Action mismatch must be rejected");
    console.log("  ✓ Action mismatch rejected with HTTP 400.");
  }

  // ----------------------------------------------------
  // Test 6: World API Proof Verification Failure
  // ----------------------------------------------------
  console.log("\n[Test 6] Testing World API proof rejection...");
  {
    setupPrerequisites();
    setWorldVerifierForTesting(async () => {
      return { success: false, nullifier: "" };
    });

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        idkitResult: { action: "oak-fractional-claim", proof: ["0xbad_proof"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "WORLD_PROOF_REJECTED");
      assert.strictEqual(err.status, 422);
    } finally {
      setWorldVerifierForTesting(null);
    }
    assert(threw, "Failed World verification must fail closed");
    console.log("  ✓ Invalid ZK proof rejected with HTTP 422.");
  }

  // ----------------------------------------------------
  // Test 7: Accredited Status Decoupling from Uniqueness
  // ----------------------------------------------------
  console.log("\n[Test 7] Testing accredited investor / compliance status decoupling...");
  {
    setupPrerequisites();
    const frozenInvestor = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    db.prepare("INSERT OR REPLACE INTO holders (token_id, account_id, frozen) VALUES (?, ?, 1)").run(
      "prop_456_oak_ave",
      frozenInvestor
    );

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: frozenInvestor,
        idkitResult: { action: "oak-fractional-claim", proof: ["0x1"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "INVESTOR_ACCOUNT_FROZEN");
      assert.strictEqual(err.status, 403);
    }
    assert(threw, "Frozen investor must be blocked even if unique");
    console.log("  ✓ World ID uniqueness decoupled from accreditation/compliance: frozen investor rejected (403).");
  }

  // ----------------------------------------------------
  // Test 8: Successful Verification & Share Allocation
  // ----------------------------------------------------
  console.log("\n[Test 8] Testing successful verification and fractional share claim...");
  {
    setupPrerequisites();
    const canonicalNullifier = "0x9876543210abcdef0123456789abcdef9876543210abcdef0123456789abcdef";
    const testTxHash = "0x4a9b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b";

    // Set mock verifier returning authoritative nullifier
    setWorldVerifierForTesting(async () => {
      return { success: true, nullifier: canonicalNullifier, credential: "orb" };
    });

    // Mock provider with successful receipt and balance increase
    setProviderForTesting(createMockProvider(0n, 100n, 1));

    const result = await verifyWorldIdProofAndClaimShares({
      investorAddress: testInvestor,
      idkitResult: {
        action: "oak-fractional-claim",
        proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
        txHash: testTxHash,
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.sharesClaimed, 100);
    assert.strictEqual(result.txHash, testTxHash);
    assert.strictEqual(result.workflowState.step5.status, "SUCCESS");
    assert.strictEqual(result.workflowState.step6.status, "READY");

    // Verify database persistence in holders table
    const holderRow = db
      .prepare("SELECT * FROM holders WHERE token_id = ? AND account_id = ?")
      .get("prop_456_oak_ave", testInvestor);
    assert(holderRow, "Holder record must be persisted in database");
    assert(holderRow.world_id_verified_at, "world_id_verified_at must be set");
    assert.strictEqual(holderRow.kyc_granted, 1, "kyc_granted must be 1");

    // Verify world_id_verifications record
    const verRow = db
      .prepare("SELECT * FROM world_id_verifications WHERE nullifier_hash = ?")
      .get(result.nullifierHash);
    assert(verRow, "World ID verification record must exist");
    assert.strictEqual(verRow.status, "VERIFIED");

    console.log("  ✓ ZK proof verified, 100 shares allocated, holder persisted, Step 6 unlocked to READY.");
  }

  // ----------------------------------------------------
  // Test 9: Nullifier Reuse / Sybil Attack Rejection
  // ----------------------------------------------------
  console.log("\n[Test 9] Testing nullifier reuse (Sybil duplicate protection)...");
  {
    const canonicalNullifier = "0x9876543210abcdef0123456789abcdef9876543210abcdef0123456789abcdef";
    setWorldVerifierForTesting(async () => {
      return { success: true, nullifier: canonicalNullifier, credential: "orb" };
    });

    const secondInvestor = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: secondInvestor,
        idkitResult: { action: "oak-fractional-claim", proof: ["0x1"] },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "NULLIFIER_ALREADY_USED");
      assert.strictEqual(err.status, 409);
    }
    assert(threw, "Reused nullifier must be rejected with 409");
    console.log("  ✓ Replayed nullifier rejected with HTTP 409 NULLIFIER_ALREADY_USED.");
  }

  // ----------------------------------------------------
  // Test 10: Reverted On-Chain Transaction
  // ----------------------------------------------------
  console.log("\n[Test 10] Testing reverted on-chain transaction (receipt.status === 0)...");
  {
    setupPrerequisites();
    const freshNullifier = "0x1111111111111111111111111111111111111111111111111111111111111111";
    setWorldVerifierForTesting(async () => {
      return { success: true, nullifier: freshNullifier, credential: "orb" };
    });

    // Mock provider where receipt status is 0 (reverted)
    setProviderForTesting(createMockProvider(0n, 0n, 0));

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
        idkitResult: {
          action: "oak-fractional-claim",
          proof: ["0x1"],
          txHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "TRANSACTION_FAILED");
      assert.strictEqual(err.status, 422);
    }
    assert(threw, "Reverted transaction must fail with HTTP 422");
    console.log("  ✓ Reverted on-chain transaction rejected with HTTP 422 TRANSACTION_FAILED.");
  }

  // ----------------------------------------------------
  // Test 11: Investor Double-Claim Protection
  // ----------------------------------------------------
  console.log("\n[Test 11] Testing investor double claim on cap table...");
  {
    setupPrerequisites();
    // Pre-record investor as verified
    db.prepare(`
      INSERT OR REPLACE INTO holders (token_id, account_id, world_id_verified_at)
      VALUES ('prop_456_oak_ave', ?, datetime('now'))
    `).run(testInvestor);

    const freshNullifier2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
    setWorldVerifierForTesting(async () => {
      return { success: true, nullifier: freshNullifier2, credential: "orb" };
    });
    setProviderForTesting(createMockProvider(100n, 200n, 1));

    let threw = false;
    try {
      await verifyWorldIdProofAndClaimShares({
        investorAddress: testInvestor,
        idkitResult: {
          action: "oak-fractional-claim",
          proof: ["0x1"],
          txHash: "0x4a9b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
        },
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "ALREADY_CLAIMED");
      assert.strictEqual(err.status, 409);
    }
    assert(threw, "Double claim must be rejected with HTTP 409");
    console.log("  ✓ Investor double claim rejected with HTTP 409 ALREADY_CLAIMED.");
  }

  // Cleanup testing mocks
  setProviderForTesting(null);
  setWorldVerifierForTesting(null);

  console.log("\n========================================================");
  console.log("✓ ALL 11 WORLD ID & SHARE CLAIM TESTS PASSED!");
  console.log("========================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
