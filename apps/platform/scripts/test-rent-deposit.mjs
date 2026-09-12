import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Wallet, ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const platformRoot = path.resolve(__dirname, "..");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-rent-deposit.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

// Set up dedicated test database
const testDbPath = path.join(platformRoot, "data", "test-rent-deposit.db");
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch {}
process.env.DATABASE_PATH = testDbPath;
process.env.HEDERA_OPERATOR_ID = "0.0.98765";

// Import platform modules
const { NextRequest } = await import("next/server");

const {
  POST: rentSimulateHandler,
  setProviderForTesting,
} = await import(pathToFileURL(path.join(platformRoot, "src/app/api/rent/simulate/route.ts")).href);

const {
  SESSION_KEY_EIP712_DOMAIN,
  SESSION_KEY_EIP712_TYPES,
  DEFAULT_ALLOWED_TARGETS,
  DEFAULT_ALLOWED_SELECTORS,
  HERMES_AGENT_ADDRESS,
  createSessionGrant,
} = await import(pathToFileURL(path.join(platformRoot, "src/lib/hermes/sessionPolicy.ts")).href);

const {
  getWorkflowState,
  resetWorkflowState,
  recordStep1Oracle,
} = await import(pathToFileURL(path.join(platformRoot, "src/lib/workflow/judgeWorkflow.ts")).href);

const { getDb } = await import(pathToFileURL(path.join(platformRoot, "src/lib/db/index.ts")).href);
const YieldVaultArtifact = (await import(pathToFileURL(path.join(platformRoot, "src/lib/evm/generated/YieldVault.json")).href, { with: { type: "json" } })).default;

const iface = new ethers.Interface(YieldVaultArtifact.abi);

// Test wallets
const operatorWallet = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const nonOperatorWallet = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

process.env.PRISM_OPERATOR_ADDRESSES = operatorWallet.address.toLowerCase();

async function createAuthHeaders(signerWallet) {
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = BigInt(Math.floor(Math.random() * 1000000) + 100);
  const policy = {
    grantor: signerWallet.address,
    agent: HERMES_AGENT_ADDRESS,
    allowedTargets: DEFAULT_ALLOWED_TARGETS,
    allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
    maxSpend: BigInt(5 * 1e18),
    maxFlow: 5000n,
    validAfter: BigInt(nowSec - 60),
    validUntil: BigInt(nowSec + 86400),
    nonce,
  };
  const signature = await signerWallet.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, policy);
  const session = createSessionGrant(
    policy.grantor,
    signature,
    { maxSpend: 5, maxFlow: 5000 },
    Number(policy.nonce),
    undefined,
    { validAfter: Number(policy.validAfter) * 1000, validUntil: Number(policy.validUntil) * 1000 }
  );
  return {
    authorization: `Bearer ${session.sessionId}`,
    "Content-Type": "application/json",
  };
}

async function callRentSimulate(body, headers = {}) {
  const req = new NextRequest("http://127.0.0.1:3000/api/rent/simulate", {
    method: "POST",
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await rentSimulateHandler(req);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runTests() {
  console.log("=== PRISM 8: Real $5,000 Rent Deposit Behavioral Test Suite ===\n");

  const validVaultAddress = "0x000000000000000000000000000000000000BEEF";
  const canonicalProperty = "prop_456_oak_ave";
  const propertyBytes32 = ethers.keccak256(ethers.toUtf8Bytes(canonicalProperty));
  const amount5000Wei = ethers.parseUnits("5000", 18);

  // 1. Behavioral Test: Unauthorized Depositor
  console.log("[Test 1] Testing Unauthorized Depositor...");
  {
    // 1a: Unauthenticated (no session)
    const resNoAuth = await callRentSimulate({ propertyId: canonicalProperty, amount: 5000 });
    assert.strictEqual(resNoAuth.status, 401, "Unauthenticated deposit must return HTTP 401");
    console.log("  ✓ 1a: Unauthenticated request rejected (401)");

    // 1b: Unauthorized (non-operator session)
    const nonOpHeaders = await createAuthHeaders(nonOperatorWallet);
    const resNonOp = await callRentSimulate({ propertyId: canonicalProperty, amount: 5000 }, nonOpHeaders);
    assert.strictEqual(resNonOp.status, 403, "Non-operator deposit must return HTTP 403");
    console.log("  ✓ 1b: Non-operator session rejected (403)");
  }

  // 2. Behavioral Test: Missing Vault
  console.log("\n[Test 2] Testing Missing Vault (YIELD_VAULT_ADDRESS unconfigured)...");
  {
    delete process.env.YIELD_VAULT_ADDRESS;
    const opHeaders = await createAuthHeaders(operatorWallet);
    const res = await callRentSimulate({ propertyId: canonicalProperty, amount: 5000 }, opHeaders);
    assert.strictEqual(res.status, 503, "Unconfigured YieldVault must return HTTP 503");
    assert.strictEqual(res.data?.code, "YIELD_VAULT_UNCONFIGURED");
    console.log("  ✓ Missing vault fails closed with 503 YIELD_VAULT_UNCONFIGURED");
  }

  // Set valid vault address for remaining tests
  process.env.YIELD_VAULT_ADDRESS = validVaultAddress;
  const opHeaders = await createAuthHeaders(operatorWallet);

  // 3. Behavioral Test: Step 1 Oracle Precondition Required
  console.log("\n[Test 3] Testing Step 1 Oracle Verification Precondition...");
  {
    resetWorkflowState();
    const res = await callRentSimulate({ propertyId: canonicalProperty, amount: 5000 }, opHeaders);
    assert.strictEqual(res.status, 400, "Deposit without Step 1 SUCCESS must return HTTP 400");
    assert.strictEqual(res.data?.code, "STEP1_ORACLE_REQUIRED");
    console.log("  ✓ Deposit blocked when Step 1 is not SUCCESS (400 STEP1_ORACLE_REQUIRED)");
  }

  // Complete Step 1 Oracle Verification
  recordStep1Oracle({
    propertyId: canonicalProperty,
    propertyAddress: "456 Oak Avenue, Miami FL 33101",
    dpvConfirmation: "Y",
    paymentTxId: "0.0.12345@1700000000.000000000",
    hcsTopicId: "0.0.5698421",
    hcsSequenceNumber: 1,
    isValid: true,
  });

  // 4. Behavioral Test: Wrong Amount
  console.log("\n[Test 4] Testing Wrong Amount rejection...");
  {
    // Test 4a: Legacy $3,800 default must be rejected
    const res3800 = await callRentSimulate({ propertyId: canonicalProperty, amount: 3800 }, opHeaders);
    assert.strictEqual(res3800.status, 400, "Amount != 5000 ($3,800) must return HTTP 400");
    assert.strictEqual(res3800.data?.code, "INVALID_RENT_AMOUNT");
    console.log("  ✓ Legacy $3,800 amount strictly rejected with 400 INVALID_RENT_AMOUNT");

    // Test 4b: Negative or zero amount
    const resZero = await callRentSimulate({ propertyId: canonicalProperty, amount: 0 }, opHeaders);
    assert.strictEqual(resZero.status, 400, "Zero amount must return HTTP 400");
    assert.strictEqual(resZero.data?.code, "INVALID_RENT_AMOUNT");
    console.log("  ✓ Zero amount rejected with 400 INVALID_RENT_AMOUNT");

    // Test 4c: Arbitrary amount
    const resOther = await callRentSimulate({ propertyId: canonicalProperty, amount: 7500 }, opHeaders);
    assert.strictEqual(resOther.status, 400, "Arbitrary amount must return HTTP 400");
    assert.strictEqual(resOther.data?.code, "INVALID_RENT_AMOUNT");
    console.log("  ✓ Non-canonical $7,500 rejected with 400 INVALID_RENT_AMOUNT");
  }

  // 5. Behavioral Test: Wrong Property
  console.log("\n[Test 5] Testing Wrong Property rejection...");
  {
    const resWrongProp = await callRentSimulate(
      { propertyId: "wrong_property_id", amount: 5000 },
      opHeaders
    );
    assert.strictEqual(resWrongProp.status, 400, "Property mismatch must return HTTP 400");
    assert.strictEqual(resWrongProp.data?.code, "PROPERTY_MISMATCH");
    console.log("  ✓ Client-supplied mismatch property rejected with 400 PROPERTY_MISMATCH");
  }

  // 6. Behavioral Test: Wrong Network
  console.log("\n[Test 6] Testing Wrong Network rejection...");
  {
    // 6a: Client provides wrong chainId (e.g. 1 = Ethereum Mainnet)
    const resWrongChain = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000, chainId: 1 },
      opHeaders
    );
    assert.strictEqual(resWrongChain.status, 400, "Wrong chainId (1) must return HTTP 400");
    assert.strictEqual(resWrongChain.data?.code, "WRONG_NETWORK");
    console.log("  ✓ Client chainId 1 rejected with 400 WRONG_NETWORK");

    // 6b: Client provides wrong network name
    const resWrongNet = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000, network: "Arbitrum" },
      opHeaders
    );
    assert.strictEqual(resWrongNet.status, 400, "Wrong network string must return HTTP 400");
    assert.strictEqual(resWrongNet.data?.code, "WRONG_NETWORK");
    console.log("  ✓ Client network 'Arbitrum' rejected with 400 WRONG_NETWORK");

    // 6c: Provider network mismatch (e.g. provider connected to Sepolia 11155111 instead of Base Sepolia 84532)
    const wrongProvider = {
      async getNetwork() {
        return { chainId: 11155111n, name: "sepolia" };
      },
    };
    setProviderForTesting(wrongProvider);
    const resProviderWrong = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000 },
      opHeaders
    );
    assert.strictEqual(resProviderWrong.status, 400, "Provider chainId != 84532 must return HTTP 400");
    assert.strictEqual(resProviderWrong.data?.code, "WRONG_NETWORK");
    console.log("  ✓ Provider chainId != 84532 rejected with 400 WRONG_NETWORK");
  }

  // 7. Behavioral Test: Failed Transaction (Reverted on-chain)
  console.log("\n[Test 7] Testing Failed Transaction (receipt.status === 0)...");
  {
    const revertedTxHash = "0xreverted_tx_00000000000000000000000000000000000000000000000000000001";
    const revertedProvider = {
      async getNetwork() {
        return { chainId: 84532n, name: "base-sepolia" };
      },
      async getTransactionReceipt(hash) {
        return {
          hash,
          status: 0, // REVERTED
          blockNumber: 10001,
          to: validVaultAddress,
          from: operatorWallet.address,
        };
      },
      async getTransaction(hash) {
        return {
          hash,
          to: validVaultAddress,
          data: iface.encodeFunctionData("depositRent", [propertyBytes32, amount5000Wei]),
          value: 0n,
        };
      },
    };
    setProviderForTesting(revertedProvider);
    const resFailed = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000, txHash: revertedTxHash },
      opHeaders
    );
    assert.strictEqual(resFailed.status, 422, "Reverted transaction must return HTTP 422");
    assert.strictEqual(resFailed.data?.code, "TRANSACTION_FAILED");
    console.log("  ✓ Reverted transaction rejected with 422 TRANSACTION_FAILED");
  }

  // 8. Behavioral Test: Successful $5,000 Transaction
  console.log("\n[Test 8] Testing Successful $5,000 Rent Deposit & Settlement...");
  const validTxHash = "0xsuccessful_5000_rent_tx_000000000000000000000000000000000000000000000002";
  {
    const successProvider = {
      async getNetwork() {
        return { chainId: 84532n, name: "base-sepolia" };
      },
      async getTransactionReceipt(hash) {
        return {
          hash,
          status: 1, // SUCCESS
          blockNumber: 10002,
          to: validVaultAddress,
          from: operatorWallet.address,
        };
      },
      async getTransaction(hash) {
        return {
          hash,
          to: validVaultAddress,
          data: iface.encodeFunctionData("depositRent", [propertyBytes32, amount5000Wei]),
          value: 0n,
        };
      },
    };
    setProviderForTesting(successProvider);

    const resSuccess = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000, txHash: validTxHash },
      opHeaders
    );
    assert.strictEqual(resSuccess.status, 200, "Valid $5,000 deposit must return HTTP 200");
    assert.strictEqual(resSuccess.data?.success, true);
    assert.strictEqual(resSuccess.data?.amountDeposited, 5000, "amountDeposited must be 5000");
    assert.strictEqual(resSuccess.data?.txHash, validTxHash);
    assert.strictEqual(resSuccess.data?.network, "Base Sepolia");
    assert.strictEqual(resSuccess.data?.chainId, 84532);

    // Verify Authoritative Accounting in rent_deposits table
    const db = getDb();
    const depositRow = db.prepare("SELECT * FROM rent_deposits WHERE tx_hash = ?").get(validTxHash);
    assert(depositRow, "Deposit must be recorded in rent_deposits table");
    assert.strictEqual(depositRow.amount_usd, 5000);
    assert.strictEqual(depositRow.property_id, canonicalProperty);
    assert.strictEqual(depositRow.status, "CONFIRMED");
    assert.strictEqual(depositRow.chain_id, 84532);

    // Verify workflow state progression (Step 2 SUCCESS, Step 3 READY)
    const wf = getWorkflowState();
    assert.strictEqual(wf.step2.status, "SUCCESS", "Step 2 status must be SUCCESS");
    assert.strictEqual(wf.step2.rentAmount, 5000, "Step 2 rent amount must be 5000");
    assert.strictEqual(wf.step2.depositTx, validTxHash, "Step 2 depositTx must match txHash");
    assert.strictEqual(wf.step3.status, "READY", "Step 3 must be unlocked to READY");
    console.log("  ✓ Successful $5,000 deposit settled on-chain and recorded in authoritative accounting");
    console.log("  ✓ Step 3 successfully unlocked to READY");
  }

  // 9. Behavioral Test: Replay Protection
  console.log("\n[Test 9] Testing Replay Protection...");
  {
    // Attempting to reuse the exact same settled txHash
    const resReplay = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000, txHash: validTxHash },
      opHeaders
    );
    assert.strictEqual(resReplay.status, 409, "Replayed txHash must return HTTP 409");
    assert(
      resReplay.data?.code === "TRANSACTION_REPLAYED" || resReplay.data?.code === "DUPLICATE_DEPOSIT",
      `Expected TRANSACTION_REPLAYED or DUPLICATE_DEPOSIT, got ${resReplay.data?.code}`
    );
    console.log(`  ✓ Replayed transaction rejected with HTTP 409 (${resReplay.data?.code})`);
  }

  // 10. Behavioral Test: Duplicate Deposit Protection
  console.log("\n[Test 10] Testing Duplicate Deposit Protection...");
  {
    // A different txHash, but step2 is already completed for this session/property
    const anotherTxHash = "0xanother_tx_000000000000000000000000000000000000000000000000000000000003";
    const resDuplicate = await callRentSimulate(
      { propertyId: canonicalProperty, amount: 5000, txHash: anotherTxHash },
      opHeaders
    );
    assert.strictEqual(resDuplicate.status, 409, "Duplicate deposit when Step 2 SUCCESS must return HTTP 409");
    assert.strictEqual(resDuplicate.data?.code, "DUPLICATE_DEPOSIT");
    console.log("  ✓ Duplicate deposit rejected with 409 DUPLICATE_DEPOSIT");
  }

  // Clean up test provider
  setProviderForTesting(null);

  console.log("\n========================================================");
  console.log("✓ ALL 10 BEHAVIORAL TESTS PASSED FOR REAL $5,000 RENT DEPOSIT");
  console.log("========================================================\n");
}

runTests().catch((err) => {
  console.error("Test Suite Failure:", err);
  process.exit(1);
});
