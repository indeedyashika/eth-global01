import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Wallet } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../..");
const platformRoot = path.resolve(projectRoot, "apps/platform");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-superfluid-provenance.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

const PORT = process.env.PORT || "3088";
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
    { name: "allowedTargets", type: "address[]" },
    { name: "allowedSelectors", type: "bytes4[]" },
    { name: "maxSpend", type: "uint256" },
    { name: "maxFlow", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

const DEFAULT_ALLOWED_TARGETS = [
  VALIDATOR_CONTRACT_ADDRESS,
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];

const DEFAULT_ALLOWED_SELECTORS = [
  "0xb4b46617",
  "0x401826f6",
  "0x19273c68",
  "0xd4116492",
  "0x7a83d73a",
  "0x90f5c9ef",
  "0x38ba6156",
  "0x12345678",
];

const { NextRequest } = await import("next/server");

const { GET: getStreamsHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/yield/streams/route.ts")).href
);
const { POST: sessionHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/agent/session/route.ts")).href
);
const { POST: executeHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/agent/execute/route.ts")).href
);
const { POST: yieldClaimHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/yield/claim/route.ts")).href
);
const { POST: rentSimulateHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/rent/simulate/route.ts")).href
);

let liveServerAvailable = null;

async function checkLiveServer() {
  if (liveServerAvailable !== null) return liveServerAvailable;
  try {
    const probe = await fetch(`${BASE_URL}/api/yield/streams`, {
      method: "GET",
      signal: AbortSignal.timeout(600),
    });
    liveServerAvailable = probe.status !== undefined;
  } catch {
    liveServerAvailable = false;
  }
  return liveServerAvailable;
}

async function dispatchInProcess(endpoint, method, body, headers = {}) {
  const urlObj = new URL(endpoint, BASE_URL);
  const pathname = urlObj.pathname;
  const reqHeaders = new Headers(headers);
  if (body) reqHeaders.set("Content-Type", "application/json");

  const req = new NextRequest(urlObj.toString(), {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  let res;
  if (pathname === "/api/yield/streams") {
    res = await getStreamsHandler(req);
  } else if (pathname === "/api/agent/session") {
    res = await sessionHandler(req);
  } else if (pathname === "/api/agent/execute") {
    res = await executeHandler(req);
  } else if (pathname === "/api/yield/claim") {
    res = await yieldClaimHandler(req);
  } else if (pathname === "/api/rent/simulate") {
    res = await rentSimulateHandler(req);
  } else {
    throw new Error(`Unmapped endpoint for in-process dispatch: ${pathname}`);
  }

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function postJSON(endpoint, body, headers = {}) {
  const isLive = await checkLiveServer();
  if (isLive) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return dispatchInProcess(endpoint, "POST", body, headers);
}

async function getJSON(endpoint, headers = {}) {
  const isLive = await checkLiveServer();
  if (isLive) {
    const res = await fetch(`${BASE_URL}${endpoint}`, { headers });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return dispatchInProcess(endpoint, "GET", null, headers);
}

async function runTests() {
  console.log("=== Running Superfluid & Provenance Validation Tests (Behavioral) ===");
  let passed = 0;

  // 1. Behavioral: Check yield streams endpoint (never returns fake FIXTURE streams)
  const streamsRes = await getJSON("/api/yield/streams");
  assert.strictEqual(streamsRes.status, 200, "Streams endpoint must return 200");
  const streams = streamsRes.data?.streams || [];
  assert.strictEqual(
    streams.some((s) => s.provenance === "FIXTURE"),
    false,
    "Streams must never return fabricated FIXTURE streams"
  );
  console.log("[PASS] /api/yield/streams does not fabricate fixture streams");
  passed++;

  // 2. Behavioral: Grant cryptographic session for agent execution
  const grantor = Wallet.createRandom();
  const validAfter = Date.now();
  const durationHours = 1;
  const validAfterSec = Math.floor(validAfter / 1000);
  const validUntilMs = validAfter + durationHours * 3600000;
  const validUntilSec = Math.floor(validUntilMs / 1000);
  const nonce = Date.now();

  const toSign = {
    grantor: grantor.address,
    agent: HERMES_AGENT_ADDRESS,
    allowedTargets: DEFAULT_ALLOWED_TARGETS,
    allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
    maxSpend: BigInt(Math.floor(5 * 1e18)),
    maxFlow: BigInt(5000),
    validAfter: BigInt(validAfterSec),
    validUntil: BigInt(validUntilSec),
    nonce: BigInt(nonce),
  };
  const signature = await grantor.signTypedData(domain, types, toSign);

  const sessionPayload = {
    grantor: grantor.address,
    agent: HERMES_AGENT_ADDRESS,
    allowedTargets: DEFAULT_ALLOWED_TARGETS,
    allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
    nonce,
    validAfter,
    signature,
    constraints: {
      maxSpend: 5,
      maxFlow: 5000,
      maxSpendHbar: 5,
      maxFlowRateMonthlyUsd: 5000,
      durationHours,
      allowedTargets: DEFAULT_ALLOWED_TARGETS,
      allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
    },
  };

  const sessionRes = await postJSON("/api/agent/session", sessionPayload);
  assert.strictEqual(sessionRes.status, 200, `Session grant must succeed: ${JSON.stringify(sessionRes.data)}`);
  const sessionId = sessionRes.data?.session?.sessionId;
  assert(sessionId, "Session ID must be issued");
  console.log("[PASS] Issued valid EIP-712 session for agent execution");
  passed++;

  // 3. Behavioral: Execute agent mission pipeline (fail-closed when unconfigured, no fake execution)
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
  assert.strictEqual(execRes.data?.missionStatus, "FAILED", "Mission status must be FAILED when unconfigured");

  const steps = execRes.data?.steps || [];
  assert.strictEqual(steps.length, 4, "Must contain 4 pipeline steps");

  for (const step of steps) {
    assert.strictEqual(step.txId, null, `Step ${step.name} txId must be null (never fabricate txId)`);
    assert.strictEqual(step.explorerUrl, null, `Step ${step.name} explorerUrl must be null (never fabricate explorerUrl)`);
    assert.strictEqual(step.status, "FAILED", `Step ${step.name} status must be FAILED when unconfigured`);
  }
  console.log("[PASS] /api/agent/execute fails closed with status FAILED and all step txIds/explorerUrls are null");
  passed++;

  // 4. Behavioral: Test Superfluid CFA Step specifics
  const superfluidStep = steps.find((s) => s.name.includes("Superfluid CFA"));
  assert(superfluidStep, "Superfluid CFA step must be in execution");
  assert.strictEqual(superfluidStep.txId, null, "Superfluid step txId must be null");
  assert.strictEqual(superfluidStep.explorerUrl, null, "Superfluid step explorerUrl must be null");
  assert.strictEqual(superfluidStep.status, "FAILED", "Superfluid step must be FAILED when unconfigured");
  console.log("[PASS] Superfluid CFA step verified: status FAILED, txId null, explorerUrl null");
  passed++;

  // 5. Behavioral: Test Yield Claim route authentication & fail-closed behavior
  const claimRes = await postJSON("/api/yield/claim", {
    // Legitimate fixture value used only by tests
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

  // 6. Behavioral: Test Rent Simulation route authentication & fail-closed behavior
  const rentRes = await postJSON("/api/rent/simulate", {
    // Legitimate fixture value used only by tests
    propertyId: "0.0.4491823",
    rentAmountUsd: 3800,
  });
  assert.strictEqual(rentRes.status, 401, "Unauthenticated rent simulation must be rejected");
  assert(rentRes.data?.error, "Unauthenticated rent simulation must return error message");
  assert.strictEqual(rentRes.data?.success ?? false, false, "Unauthenticated rent simulation cannot succeed");
  assert.strictEqual(rentRes.data?.txId ?? null, null, "Rent simulate txId must be null");
  assert.strictEqual(rentRes.data?.hashscanUrl ?? null, null, "Rent simulate hashscanUrl must be null");
  console.log("[PASS] /api/rent/simulate rejects unauthenticated deposit attempts without a receipt");
  passed++;

  console.log(`\nResults: ${passed}/${passed} tests passed successfully.`);
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
