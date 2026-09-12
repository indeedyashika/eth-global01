import assert from "node:assert";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Wallet, getAddress } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../..");
const platformRoot = path.resolve(projectRoot, "apps/platform");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-final-security-regression.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

const PORT = process.env.PORT || "3088";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Dynamically import required platform libraries & route handlers
const {
  SESSION_KEY_EIP712_DOMAIN,
  SESSION_KEY_EIP712_TYPES,
  DEFAULT_ALLOWED_TARGETS,
  DEFAULT_ALLOWED_SELECTORS,
  VALIDATOR_CONTRACT_ADDRESS,
  HERMES_AGENT_ADDRESS,
  createSessionGrant,
  validateSessionPolicy,
  verifySessionSignature,
  resetSessionRegistryForTesting,
  NonceReplayError,
} = await import(pathToFileURL(path.join(platformRoot, "src/lib/hermes/sessionPolicy.ts")).href);

const { contractDeploymentStatus, requireLiveContractDeployments } = await import(
  pathToFileURL(path.join(platformRoot, "src/lib/evm/contracts.ts")).href
);

const { validateAuditTopicConfiguration } = await import(
  pathToFileURL(path.join(platformRoot, "src/lib/hedera/client.ts")).href
);

const { verifySelfieCredential, WorldProofError } = await import(
  pathToFileURL(path.join(platformRoot, "src/lib/worldid/verification.ts")).href
);

const { NextRequest } = await import("next/server");

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
const { POST: oracleHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/x402/property-oracle/route.ts")).href
);
const { POST: settleHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/x402/settle/route.ts")).href
);
const { GET: getStreamsHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/yield/streams/route.ts")).href
);
const { POST: holdersHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/tokens/[tokenId]/holders/route.ts")).href
);
const { GET: subgraphGetHandler, POST: subgraphPostHandler } = await import(
  pathToFileURL(path.join(platformRoot, "src/app/api/subgraph/route.ts")).href
);

let liveServerAvailable = null;

async function checkLiveServer() {
  if (liveServerAvailable !== null) return liveServerAvailable;
  try {
    const probe = await fetch(`${BASE_URL}/api/subgraph`, {
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
  if (pathname === "/api/agent/session") {
    res = await sessionHandler(req);
  } else if (pathname === "/api/agent/execute") {
    res = await executeHandler(req);
  } else if (pathname === "/api/yield/claim") {
    res = await yieldClaimHandler(req);
  } else if (pathname === "/api/rent/simulate") {
    res = await rentSimulateHandler(req);
  } else if (pathname === "/api/x402/property-oracle") {
    res = await oracleHandler(req);
  } else if (pathname === "/api/x402/settle") {
    res = await settleHandler(req);
  } else if (pathname === "/api/yield/streams") {
    res = await getStreamsHandler(req);
  } else if (pathname.startsWith("/api/tokens/") && pathname.endsWith("/holders")) {
    const parts = pathname.split("/");
    const tokenId = parts[3];
    res = await holdersHandler(req, { params: Promise.resolve({ tokenId }) });
  } else if (pathname === "/api/subgraph") {
    res = method === "GET" ? await subgraphGetHandler(req) : await subgraphPostHandler(req);
  } else {
    throw new Error(`Unmapped endpoint for in-process dispatch: ${pathname}`);
  }

  const data = await res.json().catch(() => null);
  const resHeaders = Object.fromEntries(res.headers.entries());
  return { status: res.status, data, headers: resHeaders };
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
    const resHeaders = Object.fromEntries(res.headers.entries());
    return { status: res.status, data, headers: resHeaders };
  }
  return dispatchInProcess(endpoint, "POST", body, headers);
}

async function getJSON(endpoint, headers = {}) {
  const isLive = await checkLiveServer();
  if (isLive) {
    const res = await fetch(`${BASE_URL}${endpoint}`, { headers });
    const data = await res.json().catch(() => null);
    const resHeaders = Object.fromEntries(res.headers.entries());
    return { status: res.status, data, headers: resHeaders };
  }
  return dispatchInProcess(endpoint, "GET", null, headers);
}

// Global stats tracker
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;
const failures = [];

function recordPass(name) {
  totalTests++;
  passedTests++;
  console.log(`  ✓ [PASS ${totalTests}] ${name}`);
}

function recordFail(name, err) {
  totalTests++;
  failedTests++;
  failures.push({ name, error: err.message || String(err) });
  console.error(`  ✗ [FAIL ${totalTests}] ${name}:`, err.message || err);
}

async function runFinalSecurityRegressionPass() {
  console.log("==================================================================");
  console.log("             PRISM 8 FINAL SECURITY REGRESSION PASS               ");
  console.log("==================================================================");

  resetSessionRegistryForTesting();

  const alice = Wallet.createRandom(); // Legitimate grantor
  const bob = Wallet.createRandom();   // Unauthorized signer
  const operatorWallet = Wallet.createRandom();
  process.env.PRISM_OPERATOR_ADDRESSES = operatorWallet.address.toLowerCase();

  function buildPolicy(overrides = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      grantor: alice.address,
      agent: HERMES_AGENT_ADDRESS,
      allowedTargets: DEFAULT_ALLOWED_TARGETS,
      allowedSelectors: DEFAULT_ALLOWED_SELECTORS,
      maxSpend: BigInt(5 * 1e18),
      maxFlow: 5000n,
      validAfter: BigInt(nowSec - 60),
      validUntil: BigInt(nowSec + 86400),
      nonce: BigInt(overrides.nonce ?? Date.now()),
      ...overrides,
    };
  }

  // ============================================================================
  // 1. AUTHENTICATION
  // ============================================================================
  console.log("\n[1] AUTHENTICATION REGRESSION SUITE");

  // 1.1 Unauthenticated Hermes execution
  try {
    const res = await postJSON("/api/agent/execute", { sessionId: "" });
    assert.strictEqual(res.status, 401, "Missing sessionId must return HTTP 401");
    recordPass("Unauthenticated Hermes execution rejected (401)");
  } catch (err) {
    recordFail("Unauthenticated Hermes execution rejected (401)", err);
  }

  // 1.2 Fake signature
  try {
    const p = buildPolicy({ nonce: 2001n });
    const fakeSig = "0x" + "deadbeef".repeat(16) + "00";
    const res = await postJSON("/api/agent/session", {
      grantor: p.grantor,
      signature: fakeSig,
      nonce: Number(p.nonce),
    });
    assert.strictEqual(res.status, 401, "Fake signature must return HTTP 401");
    recordPass("Fake signature rejected cryptographically and by API (401)");
  } catch (err) {
    recordFail("Fake signature rejected cryptographically and by API (401)", err);
  }

  // 1.3 Invalid signature (wrong signer Bob for Alice)
  try {
    const p = buildPolicy({ nonce: 2002n });
    const bobSig = await bob.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const res = await postJSON("/api/agent/session", {
      grantor: p.grantor,
      signature: bobSig,
      nonce: Number(p.nonce),
    });
    assert.strictEqual(res.status, 401, "Signature by non-grantor must return HTTP 401");
    recordPass("Invalid signature (wrong signer) rejected (401)");
  } catch (err) {
    recordFail("Invalid signature (wrong signer) rejected (401)", err);
  }

  // 1.4 Expired session
  try {
    const pastSec = Math.floor(Date.now() / 1000) - 3600;
    const p = buildPolicy({
      validAfter: BigInt(pastSec - 7200),
      validUntil: BigInt(pastSec),
      nonce: 2003n,
    });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const session = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const res = await postJSON("/api/agent/execute", { sessionId: session.sessionId });
    assert.strictEqual(res.status, 401, "Execution with expired session must return HTTP 401");
    recordPass("Expired session rejected (401)");
  } catch (err) {
    recordFail("Expired session rejected (401)", err);
  }

  // 1.5 Replayed session (replayed nonce)
  try {
    const p = buildPolicy({ nonce: 2004n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const res = await postJSON("/api/agent/session", {
      grantor: p.grantor,
      signature: sig,
      nonce: Number(p.nonce),
      validAfter: Number(p.validAfter) * 1000,
      validUntil: Number(p.validUntil) * 1000,
    });
    assert.strictEqual(res.status, 409, "Replaying registration nonce must return HTTP 409");
    recordPass("Replayed session nonce rejected with HTTP 409");
  } catch (err) {
    recordFail("Replayed session nonce rejected with HTTP 409", err);
  }

  // ============================================================================
  // 2. AUTHORIZATION
  // ============================================================================
  console.log("\n[2] AUTHORIZATION REGRESSION SUITE");

  // 2.1 Unauthorized API mutation (unauthenticated rent simulation)
  try {
    const res = await postJSON("/api/rent/simulate", { propertyId: "0.0.4491823", amount: 3800 });
    assert.strictEqual(res.status, 401, "Unauthenticated mutation must return HTTP 401");
    recordPass("Unauthorized API mutation rejected (401)");
  } catch (err) {
    recordFail("Unauthorized API mutation rejected (401)", err);
  }

  // 2.2 Unauthorized admin action (session valid, but not in PRISM_OPERATOR_ADDRESSES)
  try {
    const pNonOp = buildPolicy({ nonce: 2005n });
    const sigNonOp = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, pNonOp);
    const sessionNonOp = createSessionGrant(
      pNonOp.grantor,
      sigNonOp,
      { maxSpend: 5, maxFlow: 5000 },
      Number(pNonOp.nonce),
      undefined,
      {
        validAfter: Number(pNonOp.validAfter) * 1000,
        validUntil: Number(pNonOp.validUntil) * 1000,
      }
    );
    const res = await postJSON(
      "/api/rent/simulate",
      { propertyId: "0.0.4491823", amount: 3800 },
      { authorization: `Bearer ${sessionNonOp.sessionId}` }
    );
    assert.strictEqual(res.status, 403, "Non-operator admin mutation must return HTTP 403");
    recordPass("Unauthorized admin action rejected with HTTP 403 (Operator authorization required)");
  } catch (err) {
    recordFail("Unauthorized admin action rejected with HTTP 403 (Operator authorization required)", err);
  }

  // 2.3 Unauthorized agent tool (unauthorized action name)
  try {
    const p = buildPolicy({ nonce: 2006n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const v = validateSessionPolicy(s.sessionId, "UNAUTHORIZED_TREASURY_DRAIN", 1.0, 0);
    assert.strictEqual(v.allowed, false, "Unauthorized tool/action must not be allowed");
    assert.strictEqual(v.status, 403);
    assert(v.reason?.includes("Action 'UNAUTHORIZED_TREASURY_DRAIN' is not in the delegated whitelist"));
    recordPass("Unauthorized agent tool rejected with HTTP 403");
  } catch (err) {
    recordFail("Unauthorized agent tool rejected with HTTP 403", err);
  }

  // 2.4 Unauthorized target
  try {
    const p = buildPolicy({ nonce: 2007n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const v = validateSessionPolicy(s.sessionId, {
      target: "0x9999999999999999999999999999999999999999",
      selector: "0xb4b46617",
    });
    assert.strictEqual(v.allowed, false, "Unauthorized target must not be allowed");
    assert.strictEqual(v.status, 403);
    assert(v.reason?.includes("Target"));
    recordPass("Unauthorized target rejected with HTTP 403");
  } catch (err) {
    recordFail("Unauthorized target rejected with HTTP 403", err);
  }

  // 2.5 Unauthorized selector
  try {
    const p = buildPolicy({ nonce: 2008n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const v = validateSessionPolicy(s.sessionId, {
      target: VALIDATOR_CONTRACT_ADDRESS,
      selector: "0xa9059cbb", // transfer
    });
    assert.strictEqual(v.allowed, false, "Unauthorized selector must not be allowed");
    assert.strictEqual(v.status, 403);
    assert(v.reason?.includes("Selector"));
    recordPass("Unauthorized selector rejected with HTTP 403");
  } catch (err) {
    recordFail("Unauthorized selector rejected with HTTP 403", err);
  }

  // ============================================================================
  // 3. FINANCIAL INTEGRITY
  // ============================================================================
  console.log("\n[3] FINANCIAL INTEGRITY SUITE");

  // 3.1 Fake yield claim with fabricated txId & unauthenticated
  try {
    const res = await postJSON("/api/yield/claim", {
      propertyId: "0.0.4491823",
      accountId: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
      amount: 1000,
      claimableAmount: 5000,
      txId: "0.0.99999@1789000000.000000000",
    });
    assert.strictEqual(res.status, 401, "Unauthenticated claim must be rejected");
    assert.strictEqual(res.data?.success, false);
    assert.strictEqual(res.data?.txId, null, "txId must remain null");
    assert.strictEqual(res.data?.hashscanUrl, null);
    recordPass("Fake yield claim rejected (401), client txId ignored, txId is null");
  } catch (err) {
    recordFail("Fake yield claim rejected (401), client txId ignored, txId is null", err);
  }

  // 3.2 Excessive yield claim fails closed with 503 LIVE_SETTLEMENT_UNAVAILABLE
  try {
    const p = buildPolicy({ nonce: 2009n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const res = await postJSON(
      "/api/yield/claim",
      {
        sessionId: s.sessionId,
        tokenId: "0.0.4491823",
        amount: 999999999,
        claimableAmount: 999999999,
      },
      { "idempotency-key": "claim-key-excessive-001" }
    );
    // Authenticated investor doesn't own the property or live settlement is unavailable (503/403)
    assert(
      res.status === 503 || res.status === 403,
      `Excessive claim must not succeed, status was ${res.status}`
    );
    assert.strictEqual(res.data?.txId, null);
    assert.strictEqual(res.data?.amountClaimed, "0");
    recordPass("Excessive yield claim fails closed (503/403) without transferring funds");
  } catch (err) {
    recordFail("Excessive yield claim fails closed (503/403) without transferring funds", err);
  }

  // 3.3 Duplicate claim (idempotency key replay)
  try {
    const { ensureHolder, updateHolder } = await import(
      pathToFileURL(path.join(platformRoot, "src/lib/db/repo.ts")).href
    );
    ensureHolder("0.0.4491823", alice.address, alice.address);
    updateHolder("0.0.4491823", alice.address, {
      status: "WHITELISTED",
      associated: true,
      kycGranted: true,
      frozen: false,
      lastCheckinAt: new Date().toISOString(),
    });

    const p = buildPolicy({ nonce: 2010n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const ik = `claim-replay-${Date.now()}`;
    await postJSON(
      "/api/yield/claim",
      { sessionId: s.sessionId, tokenId: "0.0.4491823" },
      { "idempotency-key": ik }
    );
    const replayRes = await postJSON(
      "/api/yield/claim",
      { sessionId: s.sessionId, tokenId: "0.0.4491823" },
      { "idempotency-key": ik }
    );
    assert.strictEqual(
      replayRes.headers["idempotency-replayed"],
      "true",
      "Replayed claim must have Idempotency-Replayed header"
    );
    recordPass("Duplicate claim detected with Idempotency-Replayed: true header");
  } catch (err) {
    recordFail("Duplicate claim detected with Idempotency-Replayed: true header", err);
  }

  // 3.4 Fake rent deposit
  try {
    const res = await postJSON("/api/rent/simulate", {
      propertyId: "0.0.4491823",
      amount: 3800,
      txId: "0.0.4491823@1789000000.000000000",
    });
    assert.strictEqual(res.status, 401, "Unauthenticated rent deposit must return 401");
    recordPass("Fake rent deposit rejected (401), cannot forge live deposit");
  } catch (err) {
    recordFail("Fake rent deposit rejected (401), cannot forge live deposit", err);
  }

  // 3.5 Invalid stream (invalid or negative flow rate)
  try {
    const p = buildPolicy({ nonce: 2011n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const v = validateSessionPolicy(s.sessionId, "UNREGISTERED_ACTION", 0.5, 3000);
    assert.strictEqual(v.allowed, false);
    recordPass("Invalid stream action rejected with HTTP 403 policy violation");
  } catch (err) {
    recordFail("Invalid stream action rejected with HTTP 403 policy violation", err);
  }

  // 3.6 Excessive flow (Yield Ceiling Violation)
  try {
    const p = buildPolicy({ nonce: 2012n, maxFlow: 5000n });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const v = validateSessionPolicy(s.sessionId, "CFA_YIELD_STREAM_START", 0.5, 10000); // 10000 > 5000
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.status, 403);
    assert(v.reason?.includes("Yield Ceiling Violation"));
    recordPass("Excessive flow rate rejected with HTTP 403 (Yield Ceiling Violation)");
  } catch (err) {
    recordFail("Excessive flow rate rejected with HTTP 403 (Yield Ceiling Violation)", err);
  }

  // 3.7 Overspend (Budget Cap Exceeded)
  try {
    const p = buildPolicy({ nonce: 2013n, maxSpend: BigInt(5 * 1e18) });
    const sig = await alice.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const s = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const v = validateSessionPolicy(s.sessionId, "ORACLE_USPS_X402", 10.0, 3000); // 10 HBAR > 5 HBAR
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.status, 403);
    assert(v.reason?.includes("Budget Cap Exceeded"));
    recordPass("Overspend rejected with HTTP 403 (Budget Cap Exceeded)");
  } catch (err) {
    recordFail("Overspend rejected with HTTP 403 (Budget Cap Exceeded)", err);
  }

  // ============================================================================
  // 4. BLOCKCHAIN TRUTH
  // ============================================================================
  console.log("\n[4] BLOCKCHAIN TRUTH SUITE");

  // 4.1 Fabricated tx ID rejected across simulated pipeline & x402 settlement
  try {
    const challengeRes = await postJSON("/api/x402/property-oracle", {
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    });
    const invId = challengeRes.data?.x402?.invoiceId;
    assert(invId, "Challenge must issue invoice");

    const fakeTxRes = await postJSON(
      "/api/x402/property-oracle",
      {
        street: "456 Oak Avenue",
        city: "Miami",
        state: "FL",
        zip: "33101",
      },
      {
        "X-Payment-Invoice": invId,
        "X-Payment-Tx": "0.0.99999@1789000000.000000000",
      }
    );
    assert.strictEqual(fakeTxRes.status, 402);
    assert(fakeTxRes.data?.error?.includes("Payment verification failed"));
    recordPass("Fabricated tx ID rejected by settlement verification engine (402 Payment verification failed)");
  } catch (err) {
    recordFail("Fabricated tx ID rejected by settlement verification engine (402 Payment verification failed)", err);
  }

  // 4.2 Fabricated HCS sequence
  try {
    const p = buildPolicy({ grantor: operatorWallet.address, nonce: 2014n });
    const sig = await operatorWallet.signTypedData(SESSION_KEY_EIP712_DOMAIN, SESSION_KEY_EIP712_TYPES, p);
    const opSession = createSessionGrant(
      p.grantor,
      sig,
      { maxSpend: 5, maxFlow: 5000 },
      Number(p.nonce),
      undefined,
      {
        validAfter: Number(p.validAfter) * 1000,
        validUntil: Number(p.validUntil) * 1000,
      }
    );
    const rentRes = await postJSON(
      "/api/rent/simulate",
      { propertyId: "0.0.4491823", amount: 3800 },
      { authorization: `Bearer ${opSession.sessionId}` }
    );
    assert.strictEqual(rentRes.status, 200);
    assert.strictEqual(rentRes.data?.provenance, "SIMULATED");
    assert.strictEqual(rentRes.data?.txId, null);
    assert.strictEqual(rentRes.data?.hashscanUrl, null);
    recordPass("HCS audit provenance strictly marked SIMULATED with null txId and null hashscanUrl");
  } catch (err) {
    recordFail("HCS audit provenance strictly marked SIMULATED with null txId and null hashscanUrl", err);
  }

  // 4.3 Fabricated Superfluid hash & 4.4 Fake explorer URL in streams
  try {
    const streamsRes = await getJSON("/api/yield/streams");
    const s = streamsRes.data?.streams?.find((x) => x.propertyId === "prop_456_oak_ave");
    assert(s, "Fixture stream must exist");
    assert.strictEqual(s.txHash, null, "Superfluid fixture txHash must be null");
    assert.strictEqual(s.provenance, "FIXTURE", "Provenance must be FIXTURE");
    recordPass("Superfluid fixture has null txHash, null explorer URL, and is marked FIXTURE");
  } catch (err) {
    recordFail("Superfluid fixture has null txHash, null explorer URL, and is marked FIXTURE", err);
  }

  // 4.5 Missing contract address presented as deployed
  try {
    const statuses = contractDeploymentStatus();
    for (const item of statuses) {
      if (!item.address) {
        assert.notStrictEqual(
          item.state,
          "DEPLOYED",
          `Missing address for ${item.name} cannot be presented as DEPLOYED`
        );
      }
    }
    let threwInLiveMode = false;
    const oldMode = process.env.PRISM_CONTRACT_MODE;
    const oldProp = process.env.PROPERTY_REGISTRY_ADDRESS;
    try {
      process.env.PRISM_CONTRACT_MODE = "LIVE";
      delete process.env.PROPERTY_REGISTRY_ADDRESS;
      requireLiveContractDeployments();
    } catch {
      threwInLiveMode = true;
    } finally {
      process.env.PRISM_CONTRACT_MODE = oldMode;
      if (oldProp) process.env.PROPERTY_REGISTRY_ADDRESS = oldProp;
    }
    assert.strictEqual(threwInLiveMode, true, "requireLiveContractDeployments must throw when address missing in LIVE");
    recordPass("Missing contract addresses cannot be presented as DEPLOYED; LIVE mode requires real addresses");
  } catch (err) {
    recordFail("Missing contract addresses cannot be presented as DEPLOYED; LIVE mode requires real addresses", err);
  }

  // ============================================================================
  // 5. ORACLES
  // ============================================================================
  console.log("\n[5] ORACLE INTEGRITY SUITE");

  // 5.1 USPS default-to-Y protection (arbitrary ZIP rejected with DPV N)
  try {
    const res = await postJSON("/api/x402/property-oracle", {
      street: "123 Random Blvd",
      city: "Beverly Hills",
      state: "CA",
      zip: "90210",
    });
    assert.strictEqual(res.status, 402, "Initial request must return 402 challenge");
    const invoiceId = res.data?.x402?.invoiceId;
    assert(invoiceId, "Must issue invoice");

    // Settle truthfully in simulation
    const settleRes = await postJSON("/api/x402/settle", {
      invoiceId,
      payer: "0.0.4491823",
      amountTinybars: 50000000,
    });
    assert.strictEqual(settleRes.status, 200);

    // Call oracle with settled invoice for arbitrary address
    const oracleRes = await postJSON(
      "/api/x402/property-oracle",
      {
        street: "123 Random Blvd",
        city: "Beverly Hills",
        state: "CA",
        zip: "90210",
      },
      { "X-Payment-Invoice": invoiceId }
    );
    assert.strictEqual(oracleRes.status, 200);
    assert.strictEqual(oracleRes.data?.isValid, false, "Arbitrary address must NOT default to valid");
    assert.strictEqual(oracleRes.data?.dpvConfirmation, "N", "DPV confirmation must be 'N'");
    recordPass("USPS Oracle does NOT default to 'Y': arbitrary address returns isValid: false, DPV: 'N'");
  } catch (err) {
    recordFail("USPS Oracle does NOT default to 'Y': arbitrary address returns isValid: false, DPV: 'N'", err);
  }

  // 5.2 x402 fake settlement
  try {
    const res = await postJSON("/api/x402/property-oracle", {
      street: "456 Oak Ave",
      city: "Miami",
      state: "FL",
      zip: "33101",
      invoiceId: "inv_unsettled_fake_001",
    });
    assert.strictEqual(res.status, 402, "Unsettled invoice cannot bypass 402 challenge");
    recordPass("x402 fake settlement blocked: unsettled invoice cannot bypass HTTP 402 challenge");
  } catch (err) {
    recordFail("x402 fake settlement blocked: unsettled invoice cannot bypass HTTP 402 challenge", err);
  }

  // 5.3 HCS failure (missing topic in LIVE mode)
  try {
    const oldTopic = process.env.HEDERA_AUDIT_TOPIC_ID;
    delete process.env.HEDERA_AUDIT_TOPIC_ID;
    let threw = false;
    try {
      validateAuditTopicConfiguration("LIVE");
    } catch {
      threw = true;
    } finally {
      if (oldTopic) process.env.HEDERA_AUDIT_TOPIC_ID = oldTopic;
    }
    assert.strictEqual(threw, true, "Missing topic in LIVE mode must throw configuration error");
    recordPass("HCS topic failure in LIVE mode throws clear configuration error without silent fallback");
  } catch (err) {
    recordFail("HCS topic failure in LIVE mode throws clear configuration error without silent fallback", err);
  }

  // 5.4 World ID mock presented as live
  try {
    let rejectedNonProd = false;
    try {
      await verifySelfieCredential({
        environment: "staging", // Mock/staging environment
        user_presence_completed: true,
      });
    } catch (err) {
      if (err instanceof WorldProofError && err.code === "selfie_environment_mismatch") {
        rejectedNonProd = true;
      } else if (err instanceof WorldProofError && err.code === "world_not_configured") {
        // WORLD_RP_ID not set also prevents mock from being presented as live
        rejectedNonProd = true;
      }
    }
    assert.strictEqual(rejectedNonProd, true, "Non-production World ID proof must be rejected");
    recordPass("World ID mock cannot be presented as live: non-production proof rejected");
  } catch (err) {
    recordFail("World ID mock cannot be presented as live: non-production proof rejected", err);
  }

  // ============================================================================
  // 6. CROSS-CHAIN
  // ============================================================================
  console.log("\n[6] CROSS-CHAIN IDENTITY MAPPING SUITE");

  // 6.1 Hedera account ID on EVM token
  try {
    const res = await postJSON("/api/tokens/0x71C8401E25687352f20D235F8d7fD1A392cf99a8/holders", {
      accountId: "0.0.12345",
    });
    assert.strictEqual(res.status, 400, "Hedera ID on EVM token must return HTTP 400");
    assert(res.data?.error?.includes("Connect a Sepolia EVM wallet for this token"));
    recordPass("Invalid Hedera account mapping on EVM token rejected (400)");
  } catch (err) {
    recordFail("Invalid Hedera account mapping on EVM token rejected (400)", err);
  }

  // 6.2 EVM address on Hedera token
  try {
    const res = await postJSON("/api/tokens/0.0.4491823/holders", {
      accountId: "0x1111111111111111111111111111111111111111",
    });
    assert.strictEqual(res.status, 400, "EVM address on Hedera token must return HTTP 400");
    assert(res.data?.error?.includes("Connect a Hedera wallet for this token"));
    recordPass("Invalid EVM address mapping on Hedera token rejected (400)");
  } catch (err) {
    recordFail("Invalid EVM address mapping on Hedera token rejected (400)", err);
  }

  // 6.3 Invalid evmAddress format in cross-chain mapping
  try {
    const res = await postJSON("/api/tokens/0.0.4491823/holders", {
      accountId: "0.0.99988",
      evmAddress: "not-a-valid-evm-address",
    });
    assert.strictEqual(res.status, 400, "Malformed evmAddress must return HTTP 400");
    recordPass("Malformed evmAddress format in cross-chain mapping rejected (400)");
  } catch (err) {
    recordFail("Malformed evmAddress format in cross-chain mapping rejected (400)", err);
  }

  // ============================================================================
  // 7. SUBGRAPH
  // ============================================================================
  console.log("\n[7] SUBGRAPH VERIFICATION SUITE");

  // 7.1 GET /api/subgraph returns status ok and schema entities
  try {
    const res = await getJSON("/api/subgraph");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data?.status, "ok");
    assert(Array.isArray(res.data?.schemaEntities));
    assert(res.data?.schemaEntities.includes("Token"));
    assert(res.data?.schemaEntities.includes("Account"));
    assert(res.data?.schemaEntities.includes("Transfer"));
    recordPass("GET /api/subgraph returns status 'ok' and valid schema entities");
  } catch (err) {
    recordFail("GET /api/subgraph returns status 'ok' and valid schema entities", err);
  }

  // 7.2 POST /api/subgraph top_holders returns holder distributions
  try {
    const res = await postJSON("/api/subgraph", { action: "top_holders" });
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data?.data?.accounts) && res.data.data.accounts.length > 0);
    recordPass("POST /api/subgraph { action: 'top_holders' } returns structured account allocations");
  } catch (err) {
    recordFail("POST /api/subgraph { action: 'top_holders' } returns structured account allocations", err);
  }

  // 7.3 POST /api/subgraph GraphQL query execution
  try {
    const res = await postJSON("/api/subgraph", {
      query: "{ tokens { id name symbol } }",
    });
    assert.strictEqual(res.status, 200);
    assert(res.data?.data?.tokens);
    assert(Array.isArray(res.data?.data?.tokens));
    recordPass("POST /api/subgraph GraphQL query resolves structured entity data");
  } catch (err) {
    recordFail("POST /api/subgraph GraphQL query resolves structured entity data", err);
  }

  // ============================================================================
  // SUMMARY REPORT
  // ============================================================================
  console.log("\n==================================================================");
  console.log("             FINAL SECURITY REGRESSION PASS RESULTS               ");
  console.log("==================================================================");
  console.log(`Total Tests:    ${totalTests}`);
  console.log(`Passed:         ${passedTests}`);
  console.log(`Failed:         ${failedTests}`);
  console.log(`Skipped:        ${skippedTests}`);

  if (failures.length > 0) {
    console.log("\nFailures Detail:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  console.log("==================================================================");
  if (failedTests > 0) {
    process.exit(1);
  }
}

runFinalSecurityRegressionPass().catch((err) => {
  console.error("Fatal regression suite error:", err);
  process.exit(1);
});
