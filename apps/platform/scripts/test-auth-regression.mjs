import { Wallet } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const platformRoot = fs.existsSync(path.join(process.cwd(), "public"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "platform");

if (!process.env.__TSX_RUNNING__ && !process.execArgv.some((a) => a.includes("tsx"))) {
  const scriptPath = path.join(platformRoot, "scripts", "test-auth-regression.mjs");
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
const sessionRoute = await import(pathToFileURL(path.join(platformRoot, "src", "app", "api", "agent", "session", "route.ts")).href);
const executeRoute = await import(pathToFileURL(path.join(platformRoot, "src", "app", "api", "agent", "execute", "route.ts")).href);

const PORT = process.env.PORT || "3088";
const BASE_URL = `http://127.0.0.1:${PORT}`;

let isServerUp = false;
try {
  const probe = await fetch(`${BASE_URL}/api/subgraph`, { signal: AbortSignal.timeout(600) });
  if (probe.status < 500) isServerUp = true;
} catch (e) {
  isServerUp = false;
}

if (isServerUp) {
  console.log(`[HTTP Mode] Live server detected on ${BASE_URL}. Running over HTTP.`);
} else {
  console.log(`[In-Process Mode] No running server detected on ${BASE_URL}. Dispatching directly to Next.js route handlers.`);
}

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

async function runTests() {
  console.log("=== Running Authentication Regression Tests ===");
  const grantor = Wallet.createRandom();
  console.log("Grantor Address:", grantor.address);

  // Helper to create and sign a policy
  async function createSession(overrides = {}) {
    const validAfter = overrides.validAfter !== undefined ? overrides.validAfter : Date.now();
    const durationHours = overrides.durationHours !== undefined ? overrides.durationHours : 1;
    const validUntilMs = validAfter + durationHours * 3600000;
    const validUntilSec = Math.floor(validUntilMs / 1000);
    
    const policyValue = {
      grantor: grantor.address,
      agent: HERMES_AGENT_ADDRESS,
      maxSpendHbar: 5,
      maxFlowMonthlyUsd: 5000,
      validUntil: validUntilSec,
      nonce: overrides.nonce !== undefined ? overrides.nonce : Date.now(),
      ...overrides
    };

    let signature = overrides.signature;
    const allowedTargets = overrides.allowedTargets || DEFAULT_ALLOWED_TARGETS;
    const allowedSelectors = overrides.allowedSelectors || DEFAULT_ALLOWED_SELECTORS;
    if (signature === undefined) {
      const validAfterSec = Math.floor(validAfter / 1000);
      const toSign = {
        grantor: grantor.address,
        agent: policyValue.agent,
        allowedTargets,
        allowedSelectors,
        maxSpend: BigInt(Math.floor(policyValue.maxSpendHbar * 1e18)),
        maxFlow: BigInt(policyValue.maxFlowMonthlyUsd),
        validAfter: BigInt(validAfterSec),
        validUntil: BigInt(policyValue.validUntil),
        nonce: BigInt(policyValue.nonce),
      };
      signature = await grantor.signTypedData(domain, types, toSign);
    }
    
    return {
      grantor: grantor.address,
      agent: overrides.agent !== undefined ? overrides.agent : HERMES_AGENT_ADDRESS,
      nonce: policyValue.nonce,
      validAfter: validAfter,
      allowedTargets,
      allowedSelectors,
      signature: signature,
      constraints: {
        maxSpendHbar: policyValue.maxSpendHbar,
        maxFlowRateMonthlyUsd: policyValue.maxFlowMonthlyUsd,
        durationHours: durationHours,
        allowedTargets,
        allowedSelectors,
      }
    };
  }

  let passed = 0;
  let total = 0;

  function assert(condition, testName, context) {
    total++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`, context || "");
    }
  }

  // 1. Unauthenticated /api/agent/execute -> 401
  let res = await postJSON("/api/agent/execute", { action: "TEST" });
  assert(res.status === 401, "unauthenticated /api/agent/execute -> 401", { status: res.status, data: res.data });

  // 2. Fake long signature -> rejected
  const fakeLongSig = "0x" + "1".repeat(130);
  const fakeSessionPayload = await createSession({ signature: fakeLongSig });
  res = await postJSON("/api/agent/session", fakeSessionPayload);
  assert(res.status === 401, "fake long signature -> rejected (401)", { status: res.status, data: res.data });

  // 3. Invalid signature -> rejected by /session
  // We'll sign with a different wallet
  const otherWallet = Wallet.createRandom();
  const invalidSigPayload = await createSession();
  const toSignForInvalid = {
    grantor: invalidSigPayload.grantor,
    agent: invalidSigPayload.agent,
    allowedTargets: DEFAULT_ALLOWED_TARGETS,
    allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
    maxSpend: BigInt(Math.floor(invalidSigPayload.constraints.maxSpendHbar * 1e18)),
    maxFlow: BigInt(invalidSigPayload.constraints.maxFlowRateMonthlyUsd),
    validAfter: BigInt(Math.floor(invalidSigPayload.validAfter / 1000)),
    validUntil: BigInt(Math.floor((invalidSigPayload.validAfter + invalidSigPayload.constraints.durationHours * 3600000) / 1000)),
    nonce: BigInt(invalidSigPayload.nonce),
  };
  invalidSigPayload.signature = await otherWallet.signTypedData(domain, types, toSignForInvalid);
  
  res = await postJSON("/api/agent/session", invalidSigPayload);
  assert(res.status === 401, "invalid signature -> rejected (401)", { status: res.status, data: res.data });

  // 4. Expired session -> rejected by /execute
  const expiredPayload = await createSession({ validAfter: Date.now() - 3600000 * 3, durationHours: 1 });
  let sessionRes = await postJSON("/api/agent/session", expiredPayload);
  res = await postJSON("/api/agent/execute", { sessionId: sessionRes.data?.session?.sessionId });
  assert(res.status === 401, "expired session -> rejected (401)", { status: res.status, data: res.data });

  // 5. Wrong agent -> rejected by /execute
  const wrongAgentPayload = await createSession({ agent: Wallet.createRandom().address });
  sessionRes = await postJSON("/api/agent/session", wrongAgentPayload);
  res = await postJSON("/api/agent/execute", { sessionId: sessionRes.data?.session?.sessionId });
  assert(res.status === 403, "wrong agent -> rejected (403)", { status: res.status, data: res.data });

  // 6. Valid session -> accepted by /session and /execute
  const validPayload = await createSession();
  res = await postJSON("/api/agent/session", validPayload);
  assert(res.status === 200, "valid session -> accepted (200)", { status: res.status, data: res.data });
  const sessionId = res.data?.session?.sessionId;
  assert(!!sessionId, "valid session returns sessionId", { status: res.status, data: res.data });

  // Replay nonce -> rejected by /execute
  // Wait, the nonce on /execute is passed directly to the route!
  res = await postJSON("/api/agent/execute", { sessionId, nonce: 1234 }); // Execute once
  res = await postJSON("/api/agent/execute", { sessionId, nonce: 1234 }); // Replay same nonce
  assert(res.status === 409, "replayed nonce -> rejected (409)", { status: res.status, data: res.data });

  // Try execution with valid session
  res = await postJSON("/api/agent/execute", { sessionId, nonce: 5678 });
  assert(res.status === 403 || res.status === 200, "authenticated /api/agent/execute -> NOT 401", { status: res.status, data: res.data });

  console.log(`\nResults: ${passed}/${total} tests passed.`);
  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
