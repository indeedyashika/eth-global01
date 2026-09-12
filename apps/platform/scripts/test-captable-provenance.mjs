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
  const result = spawnSync("npx", ["tsx", "scripts/test-captable-provenance.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

// Set up isolated test database
const testDbPath = path.join(platformRoot, "data", "test-captable-provenance.db");
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch {}
process.env.DATABASE_PATH = testDbPath;

const { pathToFileURL } = await import("node:url");
const { ethers } = await import("ethers");

const { getDb } = await import(pathToFileURL(path.join(platformRoot, "src/lib/db/index.ts")).href);
const { getAuthoritativeCapTable } = await import(pathToFileURL(path.join(platformRoot, "src/lib/captable/capTableService.ts")).href);
const { sessionRegistry } = await import(pathToFileURL(path.join(platformRoot, "src/lib/hermes/sessionPolicy.ts")).href);
const { NextRequest } = await import("next/server");

// Import Route Handlers
const captableRoute = await import(pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/captable/route.ts")).href);
const whitelistRoute = await import(pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/holders/[accountId]/whitelist/route.ts")).href);
const revokeRoute = await import(pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/holders/[accountId]/revoke/route.ts")).href);
const reclaimRoute = await import(pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/holders/[accountId]/reclaim-now/route.ts")).href);
const cancelScheduleRoute = await import(pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/holders/[accountId]/cancel-schedule/route.ts")).href);
const registerHolderRoute = await import(pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/holders/route.ts")).href);

console.log("=== PRISM 8: Authoritative Cap Table & Real Holder State Tests ===\n");

async function runTests() {
  const db = getDb();

  // Test setup: Insert canonical tokens
  const evmTokenId = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";
  const hederaTokenId = "0.0.5698421";
  const treasuryAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const operatorAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  process.env.PRISM_OPERATOR_ADDRESSES = operatorAddress;

  // Insert tokens into database
  db.prepare(`
    INSERT INTO tokens (
      id, blockchain, network, name, symbol, token_type, decimals,
      initial_supply, supply_type, max_supply, treasury_account_id,
      asset_category, memo, kyc_required, wipe_enabled, pause_enabled, world_id_required
    ) VALUES (
      ?, 'EVM', 'sepolia', '456 Oak Avenue Fractional Token', 'OAK-RWA', 'FUNGIBLE', 0,
      '1000', 'FINITE', '1000', ?, 'real-estate', 'Oak Avenue', 1, 1, 1, 1
    )
  `).run(evmTokenId, treasuryAddress);

  db.prepare(`
    INSERT INTO tokens (
      id, blockchain, network, name, symbol, token_type, decimals,
      initial_supply, supply_type, max_supply, treasury_account_id,
      asset_category, memo, kyc_required, wipe_enabled, pause_enabled, world_id_required
    ) VALUES (
      ?, 'HEDERA', 'testnet', 'Hedera Commercial Token', 'HBAR-RWA', 'FUNGIBLE', 0,
      '5000', 'FINITE', '5000', '0.0.99999', 'commercial', 'Hedera Property', 1, 1, 1, 1
    )
  `).run(hederaTokenId);

  // Configure rent deposit in SQLite ($5,000 canonical rent from Step 2)
  db.prepare(`
    INSERT INTO rent_deposits (
      property_id, vault_address, depositor_address, amount_usd, amount_wei, flow_rate_per_sec, tx_hash, network, chain_id, status, created_at
    ) VALUES (
      ?, '0xYieldVaultAddress', '0xTenantAddress', 5000, '5000000000000000000000', 0.001929, '0xRentDepositTx1234567890abcdef', 'Base Sepolia', 84532, 'CONFIRMED', datetime('now')
    )
  `).run(evmTokenId);

  // Setup valid operator session in sessionRegistry
  const operatorSessionId = "session_operator_valid_123";
  const nonOperatorSessionId = "session_unauthorized_user_456";
  const now = Date.now();

  sessionRegistry.set(operatorSessionId, {
    sessionId: operatorSessionId,
    policyIdentifier: "policy_op_1",
    grantor: operatorAddress,
    agent: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    agentId: "hermes-agent",
    agentAddress: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    nonce: 1,
    validAfter: now - 60000,
    validUntil: now + 3600000,
    createdAt: now - 60000,
    expiresAt: now + 3600000,
    allowedTargets: [],
    allowedSelectors: [],
    allowedActions: ["WHITELIST", "REVOKE", "RECLAIM"],
    constraints: { maxSpend: 1000, maxFlow: 1000, allowedTargets: [], allowedSelectors: [], validAfter: now - 60000, validUntil: now + 3600000 },
    spendingLimits: { maxSpendHbar: 1000, maxFlowRateMonthlyUsd: 1000 },
    spentHbar: 0,
    totalFlowHbar: 0,
    status: "ACTIVE",
    lastUsedAt: now,
  });

  sessionRegistry.set(nonOperatorSessionId, {
    sessionId: nonOperatorSessionId,
    policyIdentifier: "policy_user_1",
    grantor: "0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E", // Non-operator
    agent: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    agentId: "hermes-agent",
    agentAddress: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    nonce: 2,
    validAfter: now - 60000,
    validUntil: now + 3600000,
    createdAt: now - 60000,
    expiresAt: now + 3600000,
    allowedTargets: [],
    allowedSelectors: [],
    allowedActions: [],
    constraints: { maxSpend: 100, maxFlow: 100, allowedTargets: [], allowedSelectors: [], validAfter: now - 60000, validUntil: now + 3600000 },
    spendingLimits: { maxSpendHbar: 100, maxFlowRateMonthlyUsd: 100 },
    spentHbar: 0,
    totalFlowHbar: 0,
    status: "ACTIVE",
    lastUsedAt: now,
  });

  // -------------------------------------------------------------------------
  // Test 1: Initial Cap Table (Unallocated Treasury = 1000, Ownership = 100%)
  // -------------------------------------------------------------------------
  console.log("[Test 1] Testing initial cap table state before investor allocations...");
  const initialCapTable = await getAuthoritativeCapTable(evmTokenId);
  assert.strictEqual(initialCapTable.totalSupply, 1000, "Total supply must be 1,000");
  assert.strictEqual(initialCapTable.totalSharesAllocated, 0, "Initially 0 shares allocated to investors");
  assert.strictEqual(initialCapTable.unallocatedShares, 1000, "Initially 1,000 unallocated treasury shares");
  assert.strictEqual(initialCapTable.holders.length, 1, "Only treasury exists initially");
  assert.strictEqual(initialCapTable.holders[0].isTreasury, true, "First row is treasury");
  assert.strictEqual(initialCapTable.holders[0].ownershipPercentage, 100.0, "Treasury ownership must be 100%");
  assert.strictEqual(initialCapTable.holders[0].claimableYieldUsd, 5000, "Treasury claimable yield must be $5,000");
  console.log("✓ Initial cap table verified: 100% Treasury (1,000 shares, $5,000 yield)");

  // -------------------------------------------------------------------------
  // Test 2: Dynamic Holder Balance Change After Real Share Allocation
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Testing holder balance changes after real share allocation...");
  const investor1 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const claimTxHash = "0x7a8f342918bcde01458923471029482739485728394857283948572839485728";

  // Register holder and allocate 100 shares via real transfer event
  db.prepare(`
    INSERT INTO holders (token_id, account_id, evm_address, associated, kyc_granted, world_id_verified_at, status)
    VALUES (?, ?, ?, 1, 1, datetime('now'), 'WHITELISTED')
  `).run(evmTokenId, investor1, investor1);

  db.prepare(`
    INSERT INTO events (token_id, account_id, type, detail, tx_id, provenance)
    VALUES (?, ?, 'TRANSFER', ?, ?, 'LIVE_ONCHAIN')
  `).run(
    evmTokenId,
    investor1,
    JSON.stringify({ from: treasuryAddress, to: investor1, amount: 100, txHash: claimTxHash }),
    claimTxHash
  );

  db.prepare(`
    INSERT INTO world_id_verifications (
      token_id, account_id, check_kind, status, action, expected_signal, nullifier_hash, credential, verified_at
    ) VALUES (?, ?, 'orb', 'VERIFIED', 'oak-fractional-claim', 'signal_123', '0xnullifier1', 'orb', datetime('now'))
  `).run(evmTokenId, investor1);

  const updatedCapTable = await getAuthoritativeCapTable(evmTokenId);
  assert.strictEqual(updatedCapTable.totalSharesAllocated, 100, "Total allocated shares must now be 100");
  assert.strictEqual(updatedCapTable.unallocatedShares, 900, "Treasury shares must dynamically decrease to 900");
  assert.strictEqual(updatedCapTable.holders.length, 2, "Must contain Treasury + Investor 1");

  const inv1Row = updatedCapTable.holders.find((h) => h.walletAccount.toLowerCase() === investor1.toLowerCase());
  assert(inv1Row, "Investor 1 must exist in cap table");
  assert.strictEqual(inv1Row.shares, 100, "Investor 1 must hold 100 shares");
  assert.strictEqual(inv1Row.lastTransaction, claimTxHash, "Investor 1 last transaction must match the allocation tx");
  assert(inv1Row.verificationStatus.includes("World ID"), "Investor 1 must be World ID Verified");
  console.log("✓ Holder balance changed dynamically: Investor 1 = 100 shares, Treasury = 900 shares");

  // -------------------------------------------------------------------------
  // Test 3: Dynamic Ownership Percentage (No Hardcoded Percentages)
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] Testing dynamic ownership percentages and absence of hardcoded values...");
  assert.strictEqual(inv1Row.ownershipPercentage, 10.0, "Investor 1 ownership must be 10.0%");
  assert.strictEqual(inv1Row.ownershipPercentageFormatted, "10.00%", "Formatted ownership must be 10.00%");
  
  const treasuryRow = updatedCapTable.holders.find((h) => h.isTreasury);
  assert.strictEqual(treasuryRow.ownershipPercentage, 90.0, "Treasury ownership must be 90.0%");
  assert.strictEqual(treasuryRow.ownershipPercentageFormatted, "90.00%", "Formatted treasury ownership must be 90.00%");

  // Add an arbitrary non-standard allocation (e.g. 137 shares) to prove calculation is truly dynamic
  const investor2 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  const txHash2 = "0x8b9c456123456789012345678901234567890123456789012345678901234567";

  db.prepare(`
    INSERT INTO holders (token_id, account_id, evm_address, associated, kyc_granted, status)
    VALUES (?, ?, ?, 1, 1, 'WHITELISTED')
  `).run(evmTokenId, investor2, investor2);

  db.prepare(`
    INSERT INTO events (token_id, account_id, type, detail, tx_id, provenance)
    VALUES (?, ?, 'TRANSFER', ?, ?, 'LIVE_ONCHAIN')
  `).run(
    evmTokenId,
    investor2,
    JSON.stringify({ from: treasuryAddress, to: investor2, amount: 137, txHash: txHash2 }),
    txHash2
  );

  const multiCapTable = await getAuthoritativeCapTable(evmTokenId);
  const inv2Row = multiCapTable.holders.find((h) => h.walletAccount.toLowerCase() === investor2.toLowerCase());
  assert(inv2Row, "Investor 2 must exist");
  assert.strictEqual(inv2Row.shares, 137, "Investor 2 shares must be 137");
  // 137 / 1000 * 100 = 13.7%
  assert.strictEqual(inv2Row.ownershipPercentage, 13.7, "Investor 2 ownership must be 13.7%");
  assert.strictEqual(inv2Row.ownershipPercentageFormatted, "13.70%", "Formatted must be 13.70%");

  const updatedTreasury = multiCapTable.holders.find((h) => h.isTreasury);
  // 1000 - 100 - 137 = 763 shares (76.3%)
  assert.strictEqual(updatedTreasury.shares, 763, "Treasury shares must be 763");
  assert.strictEqual(updatedTreasury.ownershipPercentage, 76.3, "Treasury ownership must be 76.3%");
  assert.strictEqual(updatedTreasury.ownershipPercentageFormatted, "76.30%", "Treasury ownership must be 76.30%");

  // Sum of percentages must strictly equal 100.0%
  const totalPercent = multiCapTable.holders.reduce((sum, h) => sum + h.ownershipPercentage, 0);
  assert.strictEqual(Math.round(totalPercent * 100) / 100, 100.0, "Sum of ownership percentages must be 100%");
  console.log("✓ Dynamic ownership percentages verified: Inv1=10.0%, Inv2=13.7%, Treasury=76.3%, Total=100.0%");

  // -------------------------------------------------------------------------
  // Test 4: Dynamic Yield Calculation from Real Rent Deposit
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] Testing dynamic claimable yield proportional to deposited rent ($5,000)...");
  // Total rent = $5,000
  // Inv 1: 10% * 5000 = $500.00
  // Inv 2: 13.7% * 5000 = $685.00
  // Treasury: 76.3% * 5000 = $3,815.00
  assert.strictEqual(inv1Row.claimableYieldUsd, 500, "Investor 1 yield must be $500.00");
  assert.strictEqual(inv1Row.claimableYieldFormatted, "$500.00 / mo");
  assert.strictEqual(inv2Row.claimableYieldUsd, 685, "Investor 2 yield must be $685.00");
  assert.strictEqual(inv2Row.claimableYieldFormatted, "$685.00 / mo");
  assert.strictEqual(updatedTreasury.claimableYieldUsd, 3815, "Treasury yield must be $3,815.00");
  assert.strictEqual(updatedTreasury.claimableYieldFormatted, "$3,815.00 / mo");

  const totalYield = multiCapTable.holders.reduce((sum, h) => sum + h.claimableYieldUsd, 0);
  assert.strictEqual(totalYield, 5000, "Total claimable yield must exactly sum to deposited rent ($5,000)");
  console.log("✓ Dynamic claimable yield verified: $500 + $685 + $3,815 = $5,000 rent pool");

  // -------------------------------------------------------------------------
  // Test 5: Unauthorized Users Cannot Mutate the Table (401 / 403)
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] Testing that unauthorized callers cannot mutate cap table...");
  const targetHolder = investor1;

  // 5a. Whitelist without session -> 401
  const unauthWhitelistReq = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders/${targetHolder}/whitelist`, {
    method: "POST",
  });
  const res1 = await whitelistRoute.POST(unauthWhitelistReq, { params: Promise.resolve({ tokenId: evmTokenId, accountId: targetHolder }) });
  assert.strictEqual(res1.status, 401, "Unauthenticated whitelist mutation must return 401");

  // 5b. Whitelist with non-operator session -> 403
  const forbiddenWhitelistReq = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders/${targetHolder}/whitelist`, {
    method: "POST",
    headers: { authorization: `Bearer ${nonOperatorSessionId}` },
  });
  const res2 = await whitelistRoute.POST(forbiddenWhitelistReq, { params: Promise.resolve({ tokenId: evmTokenId, accountId: targetHolder }) });
  assert.strictEqual(res2.status, 403, "Non-operator whitelist mutation must return 403");

  // 5c. Revoke without session -> 401
  const unauthRevokeReq = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders/${targetHolder}/revoke`, {
    method: "POST",
  });
  const res3 = await revokeRoute.POST(unauthRevokeReq, { params: Promise.resolve({ tokenId: evmTokenId, accountId: targetHolder }) });
  assert.strictEqual(res3.status, 401, "Unauthenticated revoke mutation must return 401");

  // 5d. Reclaim without session -> 401
  const unauthReclaimReq = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders/${targetHolder}/reclaim-now`, {
    method: "POST",
  });
  const res4 = await reclaimRoute.POST(unauthReclaimReq, { params: Promise.resolve({ tokenId: evmTokenId, accountId: targetHolder }) });
  assert.strictEqual(res4.status, 401, "Unauthenticated reclaim mutation must return 401");

  // 5e. Cancel-schedule without session -> 401
  const unauthCancelReq = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders/${targetHolder}/cancel-schedule`, {
    method: "POST",
  });
  const res5 = await cancelScheduleRoute.POST(unauthCancelReq, { params: Promise.resolve({ tokenId: evmTokenId, accountId: targetHolder }) });
  assert.strictEqual(res5.status, 401, "Unauthenticated cancel-schedule mutation must return 401");

  console.log("✓ Unauthorized mutations strictly blocked: 401 unauthenticated, 403 unauthorized");

  // -------------------------------------------------------------------------
  // Test 6: Token / Network Mismatch is Rejected (400)
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] Testing rejection of token / network mismatches...");
  const invalidHederaAccountForEvm = "0.0.78910";
  const invalidEvmAccountForHedera = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  // 6a. Register Hedera account on EVM token -> 400
  const mismatchReg1 = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: invalidHederaAccountForEvm }),
  });
  const regRes1 = await registerHolderRoute.POST(mismatchReg1, { params: Promise.resolve({ tokenId: evmTokenId }) });
  assert.strictEqual(regRes1.status, 400, "Hedera account on EVM token registration must be rejected with 400");

  // 6b. Register EVM account on Hedera token -> 400
  const mismatchReg2 = new NextRequest(`http://127.0.0.1:3000/api/tokens/${hederaTokenId}/holders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: invalidEvmAccountForHedera }),
  });
  const regRes2 = await registerHolderRoute.POST(mismatchReg2, { params: Promise.resolve({ tokenId: hederaTokenId }) });
  assert.strictEqual(regRes2.status, 400, "EVM account on Hedera token registration must be rejected with 400");

  // 6c. Whitelist Hedera account on EVM token -> 400 (even with operator session)
  const mismatchWhitelist = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/holders/${invalidHederaAccountForEvm}/whitelist`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorSessionId}` },
  });
  const wlRes = await whitelistRoute.POST(mismatchWhitelist, { params: Promise.resolve({ tokenId: evmTokenId, accountId: invalidHederaAccountForEvm }) });
  assert.strictEqual(wlRes.status, 400, "Hedera account on EVM token mutation must be rejected with 400");

  console.log("✓ Token / network mismatches strictly rejected with 400");

  // -------------------------------------------------------------------------
  // Test 7: Network Isolation (No Merging Without Verified Identity Mapping)
  // -------------------------------------------------------------------------
  console.log("\n[Test 7] Testing network isolation in cap table query...");
  // Insert an unmapped Hedera account into holders table under the EVM token
  db.prepare(`
    INSERT INTO holders (token_id, account_id, evm_address, associated, status)
    VALUES (?, '0.0.99999', NULL, 1, 'WHITELISTED')
  `).run(evmTokenId);

  // Insert an unmapped EVM account into holders table under the Hedera token
  db.prepare(`
    INSERT INTO holders (token_id, account_id, evm_address, associated, status)
    VALUES (?, '0x1111111111111111111111111111111111111111', '0x1111111111111111111111111111111111111111', 1, 'WHITELISTED')
  `).run(hederaTokenId);

  const evmTable = await getAuthoritativeCapTable(evmTokenId);
  const leakedHedera = evmTable.holders.find((h) => h.walletAccount.startsWith("0.0."));
  assert.strictEqual(leakedHedera, undefined, "Unmapped Hedera account must NOT be merged into EVM cap table");

  const hederaTable = await getAuthoritativeCapTable(hederaTokenId);
  const leakedEvm = hederaTable.holders.find((h) => h.walletAccount.startsWith("0x"));
  assert.strictEqual(leakedEvm, undefined, "Unmapped EVM address must NOT be merged into Hedera cap table");

  console.log("✓ Network isolation verified: No cross-chain merging without verified identity mapping");

  // -------------------------------------------------------------------------
  // Test 8: Cap Table Dedicated API Endpoint
  // -------------------------------------------------------------------------
  console.log("\n[Test 8] Testing GET /api/tokens/[tokenId]/captable endpoint...");
  const apiReq = new NextRequest(`http://127.0.0.1:3000/api/tokens/${evmTokenId}/captable`, { method: "GET" });
  const apiRes = await captableRoute.GET(apiReq, { params: Promise.resolve({ tokenId: evmTokenId }) });
  assert.strictEqual(apiRes.status, 200, "Endpoint must return 200");
  const apiJson = await apiRes.json();
  assert.strictEqual(apiJson.success, true, "Endpoint must return success: true");
  assert(apiJson.capTable, "Response must include capTable object");
  assert.strictEqual(apiJson.capTable.totalSupply, 1000);
  assert.strictEqual(apiJson.capTable.holders.length, 3, "Must return all 3 authoritative holders");

  // Verify all 10 required fields exist on each holder
  const firstHolder = apiJson.capTable.holders[0];
  const requiredFields = [
    "holder",
    "walletAccount",
    "shares",
    "ownershipPercentage",
    "claimableYieldUsd",
    "verificationStatus",
    "livenessStatus",
    "token",
    "network",
    "lastTransaction",
  ];
  for (const field of requiredFields) {
    assert(firstHolder[field] !== undefined, `Holder record must include '${field}'`);
  }
  console.log("✓ Dedicated API endpoint GET /api/tokens/[tokenId]/captable verified with all 10 fields");

  console.log("\n=======================================================");
  console.log("✓ ALL 8 BEHAVIORAL CAP TABLE PROVENANCE TESTS PASSED!");
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
