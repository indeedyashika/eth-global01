import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Wallet, verifyTypedData, getAddress, Interface, keccak256, toUtf8Bytes, AbiCoder } from "ethers";

const platformRoot = fs.existsSync(path.join(process.cwd(), "public"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "platform");

if (!process.env.__TSX_RUNNING__ && !process.execArgv.some((a) => a.includes("tsx"))) {
  const scriptPath = path.join(platformRoot, "scripts", "test-erc7579-security.mjs");
  const result = spawnSync(
    "npx",
    ["tsx", "--tsconfig", path.join(platformRoot, "tsconfig.json"), scriptPath],
    {
      stdio: "inherit",
      env: { ...process.env, __TSX_RUNNING__: "1" },
      shell: true,
    }
  );
  process.exit(result.status ?? 0);
}

const { NextRequest } = await import("next/server");
const sessionPolicyMod = await import(pathToFileURL(path.join(platformRoot, "src", "lib", "hermes", "sessionPolicy.ts")).href);
const sessionRoute = await import(pathToFileURL(path.join(platformRoot, "src", "app", "api", "agent", "session", "route.ts")).href);
const executeRoute = await import(pathToFileURL(path.join(platformRoot, "src", "app", "api", "agent", "execute", "route.ts")).href);

const {
  SESSION_KEY_EIP712_DOMAIN,
  SESSION_KEY_EIP712_TYPES,
  VALIDATOR_CONTRACT_ADDRESS,
  HERMES_AGENT_ADDRESS,
  DEFAULT_ALLOWED_TARGETS,
  DEFAULT_ALLOWED_SELECTORS,
  createSessionGrant,
  validateSessionPolicy,
  verifySessionSignature,
  validateUserOp,
  resetSessionRegistryForTesting,
  NonceReplayError,
  AuthenticationError,
} = sessionPolicyMod;

// Load compiled SessionKeyValidator artifact
const validatorArtifact = JSON.parse(
  fs.readFileSync(path.join(platformRoot, "src", "lib", "evm", "generated", "SessionKeyValidator.json"), "utf8")
);
const validatorIface = new Interface(validatorArtifact.abi);

const PORT = process.env.PORT || "3088";
const BASE_URL = `http://127.0.0.1:${PORT}`;

let isServerUp = false;
try {
  const probe = await fetch(`${BASE_URL}/api/subgraph`, { signal: AbortSignal.timeout(600) });
  if (probe.status < 500) isServerUp = true;
} catch {
  isServerUp = false;
}

async function postJSON(endpoint, body, headers = {}) {
  if (isServerUp) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  const url = `${BASE_URL}${endpoint}`;
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  let res;
  if (endpoint === "/api/agent/session") {
    res = await sessionRoute.POST(req);
  } else if (endpoint === "/api/agent/execute") {
    res = await executeRoute.POST(req);
  } else {
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function runAdversarialSecurityAudit() {
  console.log("==================================================================");
  console.log("    Prism 8 ERC-7579 Security Audit & Adversarial Test Suite      ");
  console.log("==================================================================");

  resetSessionRegistryForTesting();

  const alice = Wallet.createRandom(); // Legitimate Grantor
  const bob = Wallet.createRandom();   // Unauthorized Signer
  const mallory = Wallet.createRandom(); // Malicious Agent
  const unauthorizedTarget = "0x9999999999999999999999999999999999999999";
  const unauthorizedSelector = "0xa9059cbb"; // transfer(address,uint256)

  let passed = 0;
  let total = 0;

  function recordPass(name) {
    total++;
    passed++;
    console.log(`✓ [PASS ${passed}] ${name}`);
  }

  // Helper to build canonical policy
  function buildCanonicalPolicy(overrides = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      grantor: alice.address,
      agent: HERMES_AGENT_ADDRESS,
      allowedTargets: DEFAULT_ALLOWED_TARGETS,
      allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
      maxSpend: BigInt(5 * 1e18), // 5 HBAR
      maxFlow: 5000n, // $5,000 / mo
      validAfter: BigInt(nowSec - 60), // Active 1 min ago
      validUntil: BigInt(nowSec + 86400), // Valid for 24h
      nonce: BigInt(overrides.nonce ?? Date.now()),
      ...overrides,
    };
  }

  // --- ATTACK 1: Fake / Malformed Signature ---
  console.log("\n[Attack 1] Testing Fake / Malformed Signature Rejection...");
  const fakeSig = "0x" + "deadbeef".repeat(16) + "00";
  const p1 = buildCanonicalPolicy({ nonce: 1001n });
  const v1 = verifySessionSignature(p1.grantor, fakeSig, p1);
  assert.strictEqual(v1.verified, false, "Fake signature must fail verification");
  assert.strictEqual(v1.signatureType, "INVALID");

  const r1 = await postJSON("/api/agent/session", {
    grantor: p1.grantor,
    signature: fakeSig,
    nonce: Number(p1.nonce),
    constraints: { maxSpend: 5, maxFlow: 5000 },
  });
  assert.strictEqual(r1.status, 401, "API must reject fake signature with HTTP 401");
  recordPass("Fake / malformed signature rejected cryptographically and at API gateway");

  // --- ATTACK 2: Wrong Signer (Impersonation) ---
  console.log("\n[Attack 2] Testing Wrong Signer (Impersonation Attack)...");
  const p2 = buildCanonicalPolicy({ nonce: 1002n });
  const bobSig = await bob.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p2);
  const v2 = verifySessionSignature(p2.grantor, bobSig, p2);
  assert.strictEqual(v2.verified, false, "Signature by Bob cannot authenticate Alice's policy");

  const r2 = await postJSON("/api/agent/session", {
    grantor: p2.grantor,
    signature: bobSig,
    nonce: Number(p2.nonce),
    constraints: { maxSpend: 5, maxFlow: 5000 },
  });
  assert.strictEqual(r2.status, 401, "API must reject unauthorized signer with HTTP 401");
  recordPass("Wrong signer (impersonation) rejected cryptographically");

  // --- ATTACK 3: Wrong Agent Execution ---
  console.log("\n[Attack 3] Testing Wrong Agent Execution Rejection...");
  const p3 = buildCanonicalPolicy({ agent: mallory.address, nonce: 1003n });
  const sig3 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p3);
  const session3 = createSessionGrant(
    p3.grantor,
    sig3,
    { maxSpend: 5, maxFlow: 5000 },
    Number(p3.nonce),
    undefined,
    {
      agent: mallory.address,
      validAfter: Number(p3.validAfter) * 1000,
      validUntil: Number(p3.validUntil) * 1000,
    }
  );

  const v3 = validateSessionPolicy(session3.sessionId, "ORACLE_USPS_X402", 0.5, 3000);
  assert.strictEqual(v3.allowed, false, "Session granted to Mallory must not be permitted for Hermes");
  assert.strictEqual(v3.status, 403);
  assert(v3.reason?.includes("not granted to Hermes agent"));

  const r3 = await postJSON("/api/agent/execute", { sessionId: session3.sessionId });
  assert.strictEqual(r3.status, 403, "API must reject execution for unauthorized agent with HTTP 403");
  recordPass("Wrong agent execution rejected with HTTP 403 policy violation");

  // --- ATTACK 4: Target Restriction Violation ---
  console.log("\n[Attack 4] Testing Target Restriction (Target Allowlist)...");
  const p4 = buildCanonicalPolicy({
    allowedTargets: [VALIDATOR_CONTRACT_ADDRESS],
    nonce: 1004n,
  });
  const sig4 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p4);
  const session4 = createSessionGrant(
    p4.grantor,
    sig4,
    { maxSpend: 5, maxFlow: 5000, allowedTargets: [VALIDATOR_CONTRACT_ADDRESS] },
    Number(p4.nonce),
    undefined,
    {
      allowedTargets: [VALIDATOR_CONTRACT_ADDRESS],
      validAfter: Number(p4.validAfter) * 1000,
      validUntil: Number(p4.validUntil) * 1000,
    }
  );

  const v4 = validateSessionPolicy(session4.sessionId, {
    target: unauthorizedTarget,
    selector: "0xb4b46617",
    spend: 1.0,
  });
  assert.strictEqual(v4.allowed, false, "Call to unauthorized target must be rejected");
  assert.strictEqual(v4.status, 403);
  assert(v4.reason?.includes("Target"));
  recordPass("Target allowlist enforced: unapproved destination target rejected (403)");

  // --- ATTACK 5: Function Selector Restriction Violation ---
  console.log("\n[Attack 5] Testing Function Selector Restriction (Selector Allowlist)...");
  const p5 = buildCanonicalPolicy({
    allowedSelectors: ["0xb4b46617"], // Only registerProperty
    nonce: 1005n,
  });
  const sig5 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p5);
  const session5 = createSessionGrant(
    p5.grantor,
    sig5,
    { maxSpend: 5, maxFlow: 5000, allowedSelectors: ["0xb4b46617"] },
    Number(p5.nonce),
    undefined,
    {
      allowedSelectors: ["0xb4b46617"],
      validAfter: Number(p5.validAfter) * 1000,
      validUntil: Number(p5.validUntil) * 1000,
    }
  );

  const v5 = validateSessionPolicy(session5.sessionId, {
    target: VALIDATOR_CONTRACT_ADDRESS,
    selector: unauthorizedSelector, // 0xa9059cbb transfer
    spend: 1.0,
  });
  assert.strictEqual(v5.allowed, false, "Invocation of unauthorized selector must be rejected");
  assert.strictEqual(v5.status, 403);
  assert(v5.reason?.includes("Selector"));
  recordPass("Selector allowlist enforced: unapproved function selector rejected (403)");

  // --- ATTACK 6: Expired Policy ---
  console.log("\n[Attack 6] Testing Expired Policy Rejection...");
  const pastSec = Math.floor(Date.now() / 1000) - 3600;
  const p6 = buildCanonicalPolicy({
    validAfter: BigInt(pastSec - 7200),
    validUntil: BigInt(pastSec), // Expired 1 hr ago
    nonce: 1006n,
  });
  const sig6 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p6);
  const session6 = createSessionGrant(
    p6.grantor,
    sig6,
    { maxSpend: 5, maxFlow: 5000 },
    Number(p6.nonce),
    undefined,
    {
      validAfter: Number(p6.validAfter) * 1000,
      validUntil: Number(p6.validUntil) * 1000,
    }
  );

  const v6 = validateSessionPolicy(session6.sessionId, "ORACLE_USPS_X402", 0.5, 3000);
  assert.strictEqual(v6.allowed, false, "Expired session policy must be rejected");
  assert.strictEqual(v6.status, 401);
  assert(v6.reason?.includes("expired"));
  recordPass("Expiration enforced: expired session policy rejected with HTTP 401");

  // --- ATTACK 7: Not-Yet-Valid Policy (Pre-activation) ---
  console.log("\n[Attack 7] Testing Not-Yet-Valid Policy Rejection...");
  const futureSec = Math.floor(Date.now() / 1000) + 3600; // Starts in 1 hr
  const p7 = buildCanonicalPolicy({
    validAfter: BigInt(futureSec),
    validUntil: BigInt(futureSec + 86400),
    nonce: 1007n,
  });
  const sig7 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p7);
  const session7 = createSessionGrant(
    p7.grantor,
    sig7,
    { maxSpend: 5, maxFlow: 5000 },
    Number(p7.nonce),
    undefined,
    {
      validAfter: Number(p7.validAfter) * 1000,
      validUntil: Number(p7.validUntil) * 1000,
    }
  );

  const v7 = validateSessionPolicy(session7.sessionId, "ORACLE_USPS_X402", 0.5, 3000);
  assert.strictEqual(v7.allowed, false, "Not-yet-valid session policy must be rejected");
  assert.strictEqual(v7.status, 401);
  assert(v7.reason?.includes("not yet valid"));
  recordPass("validAfter enforced: pre-activation policy rejected with HTTP 401");

  // --- ATTACK 8: Wrong Chain Binding (Cross-chain Replay) ---
  console.log("\n[Attack 8] Testing Wrong Chain Binding Rejection...");
  const mainnetDomain = { ...SESSION_KEY_EIP712_DOMAIN, chainId: 1 }; // Mainnet
  const p8 = buildCanonicalPolicy({ nonce: 1008n });
  const mainnetSig = await alice.signTypedData(mainnetDomain, SESSION_KEY_EIP712_TYPES, p8);
  const v8 = verifySessionSignature(p8.grantor, mainnetSig, p8);
  assert.strictEqual(v8.verified, false, "Signature for ChainId 1 must not verify on Sepolia (11155111)");
  recordPass("Chain binding enforced: cross-chain signature rejected cryptographically");

  // --- ATTACK 9: Replayed Nonce ---
  console.log("\n[Attack 9] Testing Nonce Replay Protection...");
  const p9 = buildCanonicalPolicy({ nonce: 1009n });
  const sig9 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p9);
  createSessionGrant(
    p9.grantor,
    sig9,
    { maxSpend: 5, maxFlow: 5000 },
    Number(p9.nonce),
    undefined,
    {
      validAfter: Number(p9.validAfter) * 1000,
      validUntil: Number(p9.validUntil) * 1000,
    }
  );

  // Attempt to register same nonce again
  let replayBlocked = false;
  try {
    createSessionGrant(
      p9.grantor,
      sig9,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p9.nonce),
      undefined,
      {
        validAfter: Number(p9.validAfter) * 1000,
        validUntil: Number(p9.validUntil) * 1000,
      }
    );
  } catch (err) {
    if (err instanceof NonceReplayError) replayBlocked = true;
  }
  assert.strictEqual(replayBlocked, true, "Replayed nonce must throw NonceReplayError");

  const r9 = await postJSON("/api/agent/session", {
    grantor: p9.grantor,
    signature: sig9,
    nonce: Number(p9.nonce),
    constraints: { maxSpend: 5, maxFlow: 5000 },
    validAfter: Number(p9.validAfter) * 1000,
    validUntil: Number(p9.validUntil) * 1000,
  });
  assert.strictEqual(r9.status, 409, "API must reject replayed nonce with HTTP 409");
  recordPass("Nonce replay protection enforced: duplicate registration rejected (409)");

  // --- ATTACK 10: Overspend (Spending Limit Violation) ---
  console.log("\n[Attack 10] Testing Overspend (Budget Cap Violation)...");
  const p10 = buildCanonicalPolicy({ maxSpend: BigInt(5 * 1e18), nonce: 1010n });
  const sig10 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p10);
  const session10 = createSessionGrant(
    p10.grantor,
    sig10,
    { maxSpend: 5, maxFlow: 5000 },
    Number(p10.nonce),
    undefined,
    {
      validAfter: Number(p10.validAfter) * 1000,
      validUntil: Number(p10.validUntil) * 1000,
    }
  );

  const v10 = validateSessionPolicy(session10.sessionId, "ORACLE_USPS_X402", 10.0, 3000); // 10 HBAR > 5 HBAR
  assert.strictEqual(v10.allowed, false, "Spend of 10 HBAR must exceed 5 HBAR allowance");
  assert.strictEqual(v10.status, 403);
  assert(v10.reason?.includes("Budget Cap Exceeded"));
  recordPass("Spending limit enforced: attempt to overspend rejected (403)");

  // --- ATTACK 11: Excessive Flow (Flow Limit Violation) ---
  console.log("\n[Attack 11] Testing Excessive Flow (Yield Ceiling Violation)...");
  const p11 = buildCanonicalPolicy({ maxFlow: 5000n, nonce: 1011n });
  const sig11 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p11);
  const session11 = createSessionGrant(
    p11.grantor,
    sig11,
    { maxSpend: 5, maxFlow: 5000 },
    Number(p11.nonce),
    undefined,
    {
      validAfter: Number(p11.validAfter) * 1000,
      validUntil: Number(p11.validUntil) * 1000,
    }
  );

  const v11 = validateSessionPolicy(session11.sessionId, "CFA_YIELD_STREAM_START", 0.5, 10000); // $10,000 > $5,000
  assert.strictEqual(v11.allowed, false, "Flow of $10,000/mo must exceed $5,000/mo ceiling");
  assert.strictEqual(v11.status, 403);
  assert(v11.reason?.includes("Yield Ceiling Violation"));
  recordPass("Flow ceiling enforced: attempt to exceed continuous yield stream rate rejected (403)");

  // --- ATTACK 12: Modified Signed Policy (Parameter Tampering) ---
  console.log("\n[Attack 12] Testing Tampered / Modified Signed Policy...");
  const p12 = buildCanonicalPolicy({ maxSpend: BigInt(5 * 1e18), nonce: 1012n });
  const sig12 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p12);

  // Mallory tampers with policy parameters (bumps budget from 5 to 500 HBAR)
  const tamperedPolicy = { ...p12, maxSpend: BigInt(500 * 1e18) };
  const v12 = verifySessionSignature(tamperedPolicy.grantor, sig12, tamperedPolicy);
  assert.strictEqual(v12.verified, false, "Tampered maxSpend must break cryptographic verification");

  // Mallory tampers with allowedTargets (injects attacker address)
  const tamperedTargetsPolicy = { ...p12, allowedTargets: [...p12.allowedTargets, unauthorizedTarget] };
  const v12b = verifySessionSignature(tamperedTargetsPolicy.grantor, sig12, tamperedTargetsPolicy);
  assert.strictEqual(v12b.verified, false, "Tampered allowedTargets must break cryptographic verification");
  recordPass("Policy integrity enforced: parameter tampering breaks cryptographic signature");

  // --- BONUS: ERC-4337 / ERC-7579 UserOperation Validation ---
  console.log("\n[Test 13] Testing ERC-7579 UserOperation Validation with Session Key...");
  const abiCoder = AbiCoder.defaultAbiCoder();
  const p13 = buildCanonicalPolicy({ nonce: 1013n });
  const grantorSig13 = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p13);

  const hermesWallet = new Wallet("0x" + "7".repeat(64)); // Mock Hermes signer for agent key
  const p13AgentPolicy = { ...p13, agent: hermesWallet.address };
  const grantorSig13Agent = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p13AgentPolicy);

  const dummyUserOpHash = keccak256(toUtf8Bytes("user_op_hash_001"));
  const agentSig13 = hermesWallet.signingKey.sign(dummyUserOpHash).serialized;

  const policyTuple = [
    p13AgentPolicy.grantor,
    p13AgentPolicy.agent,
    p13AgentPolicy.allowedTargets,
    p13AgentPolicy.allowedSelectors,
    p13AgentPolicy.maxSpend,
    p13AgentPolicy.maxFlow,
    p13AgentPolicy.validAfter,
    p13AgentPolicy.validUntil,
    p13AgentPolicy.nonce,
  ];

  const userOpSig = abiCoder.encode(
    [
      "tuple(address,address,address[],bytes4[],uint256,uint256,uint256,uint256,uint256)",
      "bytes",
      "bytes"
    ],
    [policyTuple, grantorSig13Agent, agentSig13]
  );

  // 13a. Valid UserOp
  const validExecCallData = "0xb61d27f6" + abiCoder.encode(
    ["address", "uint256", "bytes"],
    [p13AgentPolicy.allowedTargets[0], 100000000000000000n, "0xb4b4661700000000"]
  ).slice(2);

  const userOpResult = validateUserOp({
    sender: alice.address,
    nonce: 1n,
    callData: validExecCallData,
    signature: userOpSig,
  }, dummyUserOpHash);
  assert.strictEqual(userOpResult.valid, true, "Valid UserOp must pass validation");
  assert.strictEqual(userOpResult.validationData, 0);

  // 13b. UserOp with unauthorized target
  const invalidTargetCallData = "0xb61d27f6" + abiCoder.encode(
    ["address", "uint256", "bytes"],
    [unauthorizedTarget, 100000000000000000n, "0xb4b4661700000000"]
  ).slice(2);

  const badTargetResult = validateUserOp({
    sender: alice.address,
    nonce: 1n,
    callData: invalidTargetCallData,
    signature: userOpSig,
  }, dummyUserOpHash);
  assert.strictEqual(badTargetResult.valid, false, "UserOp with unapproved target must fail");

  // 13c. UserOp with unauthorized selector
  const invalidSelectorCallData = "0xb61d27f6" + abiCoder.encode(
    ["address", "uint256", "bytes"],
    [p13AgentPolicy.allowedTargets[0], 100000000000000000n, "0xa9059cbb00000000"]
  ).slice(2);

  const badSelectorResult = validateUserOp({
    sender: alice.address,
    nonce: 1n,
    callData: invalidSelectorCallData,
    signature: userOpSig,
  }, dummyUserOpHash);
  assert.strictEqual(badSelectorResult.valid, false, "UserOp with unapproved selector must fail");

  recordPass("ERC-7579 UserOperation validation verified across targets, selectors, and signatures");

  console.log("\n==================================================================");
  console.log(`All ${passed}/${total} Adversarial ERC-7579 Security Tests PASSED! 🛡️🚀`);
  console.log("==================================================================");
}

runAdversarialSecurityAudit().catch((err) => {
  console.error("Adversarial security test failed:", err);
  process.exit(1);
});
