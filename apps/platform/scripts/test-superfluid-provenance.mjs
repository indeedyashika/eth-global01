import assert from "node:assert";
import { Wallet } from "ethers";

const PORT = process.env.PORT || "3088";
const BASE_URL = `http://localhost:${PORT}`;

const VALIDATOR_CONTRACT_ADDRESS = "0x7579C0de00000000000000000000000000007579";
const HERMES_AGENT_ADDRESS = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";

const domain = {
  name: "Prism8SessionValidator",
  version: "1",
  chainId: 11155111,
  verifyingContract: VALIDATOR_CONTRACT_ADDRESS,
};

const types = {
  SessionPolicy: [
    { name: "grantor", type: "address" },
    { name: "agent", type: "address" },
    { name: "maxSpendHbar", type: "uint256" },
    { name: "maxFlowMonthlyUsd", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

async function postJSON(endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function getJSON(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function runTests() {
  console.log("=== Running Superfluid & Provenance Validation Tests ===");
  let passed = 0;

  // 1. Check yield streams fixture route
  const streamsRes = await getJSON("/api/yield/streams");
  assert.strictEqual(streamsRes.status, 200, "Streams endpoint must return 200");
  const streams = streamsRes.data?.streams || [];
  assert(streams.length > 0, "Streams fixture must be present");
  const fixtureStream = streams.find((s) => s.propertyId === "prop_456_oak_ave");
  assert(fixtureStream, "Default fixture stream must exist");
  assert.strictEqual(fixtureStream.txHash, null, "Fixture stream txHash must be null");
  assert.strictEqual(fixtureStream.provenance, "FIXTURE", "Fixture stream must be marked FIXTURE");
  console.log("[PASS] /api/yield/streams fixture is marked FIXTURE with null txHash");
  passed++;

  // 2. Grant session for agent execution
  const grantor = Wallet.createRandom();
  const validAfter = Date.now();
  const durationHours = 1;
  const validUntilMs = validAfter + durationHours * 3600000;
  const validUntilSec = Math.floor(validUntilMs / 1000);
  const nonce = Date.now();

  const toSign = {
    grantor: grantor.address,
    agent: HERMES_AGENT_ADDRESS,
    maxSpendHbar: BigInt(Math.floor(5 * 1e18)),
    maxFlowMonthlyUsd: BigInt(5000),
    validUntil: BigInt(validUntilSec),
    nonce: BigInt(nonce),
  };
  const signature = await grantor.signTypedData(domain, types, toSign);

  const sessionPayload = {
    grantor: grantor.address,
    agent: HERMES_AGENT_ADDRESS,
    nonce,
    validAfter,
    signature,
    constraints: {
      maxSpendHbar: 5,
      maxFlowRateMonthlyUsd: 5000,
      durationHours,
    },
  };

  const sessionRes = await postJSON("/api/agent/session", sessionPayload);
  assert.strictEqual(sessionRes.status, 200, `Session grant must succeed: ${JSON.stringify(sessionRes.data)}`);
  const sessionId = sessionRes.data?.session?.sessionId;
  assert(sessionId, "Session ID must be issued");
  console.log("[PASS] Issued valid EIP-712 session for agent execution");
  passed++;

  // 3. Execute agent mission
  const execRes = await postJSON("/api/agent/execute", {
    sessionId,
    action: "FULL_TOKENIZATION_AND_YIELD_PIPELINE",
    property: {
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
      monthlyRent: 3800,
      shares: 1000,
    },
  });
  assert.strictEqual(execRes.status, 200, `Agent execution must return 200: ${JSON.stringify(execRes.data)}`);
  assert.strictEqual(execRes.data?.missionStatus, "SIMULATED", "Mission status must be SIMULATED");

  const steps = execRes.data?.steps || [];
  assert.strictEqual(steps.length, 4, "Must contain 4 pipeline steps");

  for (const step of steps) {
    assert.strictEqual(step.txId, null, `Step ${step.name} txId must be null in simulation`);
    assert.strictEqual(step.explorerUrl, null, `Step ${step.name} explorerUrl must be null in simulation`);
    assert.strictEqual(step.status, "SIMULATED", `Step ${step.name} status must be SIMULATED`);
    assert.strictEqual(step.provenance, "SIMULATED", `Step ${step.name} provenance must be SIMULATED`);
  }
  console.log("[PASS] /api/agent/execute returns missionStatus SIMULATED and all step txIds/explorerUrls are null");
  passed++;

  // 4. Test Superfluid CFA Step specifics
  const superfluidStep = steps.find((s) => s.name.includes("Superfluid CFA"));
  assert(superfluidStep, "Superfluid CFA step must be in execution");
  assert.strictEqual(superfluidStep.provenance, "SIMULATED", "Superfluid step must be SIMULATED");
  assert.strictEqual(superfluidStep.txId, null, "Superfluid step txId must be null");
  assert.strictEqual(superfluidStep.explorerUrl, null, "Superfluid step explorerUrl must be null");
  console.log("[PASS] Superfluid CFA step verified: status SIMULATED, txId null, explorerUrl null");
  passed++;

  // 5. Test Yield Claim route
  const claimRes = await postJSON("/api/yield/claim", {
    propertyId: "0.0.4491823",
    accountId: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
    amount: 14.8251,
    claimableAmount: 999999,
    txId: "0.0.99999@1741234567.890000000",
  });
  assert.strictEqual(claimRes.status, 401, "Unauthenticated yield claim must be rejected");
  assert.strictEqual(claimRes.data?.success, false, "Unauthenticated claim cannot succeed");
  assert.strictEqual(claimRes.data?.txId, null, "Yield claim txId must be null");
  assert.strictEqual(claimRes.data?.hashscanUrl, null, "Yield claim hashscanUrl must be null");
  assert.strictEqual(claimRes.data?.code, "AUTH_REQUIRED");
  console.log("[PASS] /api/yield/claim rejects unauthenticated client-controlled claim fields without a receipt");
  passed++;

  // 6. Test Rent Simulation route
  const rentRes = await postJSON("/api/rent/simulate", {
    propertyId: "0.0.4491823",
    rentAmountUsd: 3800,
  });
  assert.strictEqual(rentRes.status, 200, "Rent simulation must return 200");
  assert.strictEqual(rentRes.data?.txId, null, "Rent simulate txId must be null");
  assert.strictEqual(rentRes.data?.hashscanUrl, null, "Rent simulate hashscanUrl must be null");
  assert.strictEqual(rentRes.data?.provenance, "SIMULATED", "Rent simulate provenance must be SIMULATED");
  console.log("[PASS] /api/rent/simulate verified: txId null, hashscanUrl null, provenance SIMULATED");
  passed++;

  console.log(`\nResults: ${passed}/${passed} tests passed successfully.`);
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
