import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const platformRoot = fs.existsSync(path.join(process.cwd(), "public"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "platform");

if (!process.env.__TSX_RUNNING__ && !process.execArgv.some((a) => a.includes("tsx"))) {
  const scriptPath = path.join(platformRoot, "scripts", "test-x402-oracle.mjs");
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

const PORT = process.env.PORT || "3088";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function runTests() {
  console.log("=== Testing Truthful x402 USPS Property Oracle & Payment Implementation ===");

  // Step 1: Agent Services Discovery Directory
  console.log("\n[Test 1] Verifying Agent Services Discovery Schema...");
  const wellKnownPath = path.join(platformRoot, "public", ".well-known", "agent-services.json");
  assert(fs.existsSync(wellKnownPath), "Agent services discovery file must exist");
  const directory = JSON.parse(fs.readFileSync(wellKnownPath, "utf8"));
  assert(directory.services && Array.isArray(directory.services), "Services must be an array");
  const oracleService = directory.services.find((s) => s.id === "property-address-validation");
  assert(oracleService, "property-address-validation service must be registered");
  assert.strictEqual(oracleService.pricing.model, "metered_per_call");
  assert.strictEqual(oracleService.pricing.network, "hedera-testnet");
  console.log("✓ Test 1 Passed: Agent discovery directory meets specification.");

  // Step 2: Unpaid Request -> HTTP 402 with Blocky402 Facilitator
  console.log("\n[Test 2] Verifying unpaid request returns HTTP 402 with Blocky402 challenge...");
  const unpaidRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });

  assert.strictEqual(unpaidRes.status, 402, "Expected HTTP 402 Payment Required");
  const unpaid = await unpaidRes.json();
  assert(unpaid.x402, "Expected x402 challenge payload");
  assert.strictEqual(unpaid.x402.facilitator, "blocky402");
  assert.strictEqual(unpaid.x402.network, "hedera-testnet");
  assert(unpaid.x402.invoiceId, "Expected unique invoiceId in x402 challenge");
  assert(unpaid.x402.amount, "Expected payment amount in tinybars");
  assert.strictEqual(unpaid.x402.displayAmount, "0.5 HBAR");
  const invoiceId = unpaid.x402.invoiceId;
  console.log(`✓ Test 2 Passed: 402 challenge received with invoice ${invoiceId} (${unpaid.x402.displayAmount}).`);

  // Step 3: Unpaid Request with Invoice ID cannot proceed as paid
  console.log("\n[Test 3] Verifying unpaid request with unsettled invoice cannot proceed as paid...");
  const unpaidRetryRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Invoice": invoiceId,
    },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });

  assert.strictEqual(unpaidRetryRes.status, 402, "Expected HTTP 402 because invoice is unsettled");
  const unpaidRetry = await unpaidRetryRes.json();
  assert(unpaidRetry.error.includes("Invoice has not been settled"), "Error must state invoice has not been settled");
  console.log("✓ Test 3 Passed: Unpaid request cannot proceed as paid.");

  // Step 4: Fake Transaction ID cannot be returned as live
  console.log("\n[Test 4] Verifying fake transaction IDs cannot be accepted as live payment proof...");
  const fakeTxRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Invoice": invoiceId,
      "X-Payment-Tx": "0.0.99999@1741234567.890000000", // fabricated txId
    },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });

  assert.strictEqual(fakeTxRes.status, 402, "Fake txId must be rejected with 402");
  const fakeTxData = await fakeTxRes.json();
  assert(
    fakeTxData.error.includes("Payment verification failed"),
    "Fake transaction must trigger on-chain verification failure"
  );
  console.log(`✓ Test 4 Passed: Fake transaction ID correctly rejected: "${fakeTxData.error}".`);

  // Step 5: Server-side Settlement Validation (invalid recipient, invalid amount)
  console.log("\n[Test 5] Verifying server-side settlement validation (recipient, amount)...");
  
  // 5a. Invalid recipient format
  const badRecipientRes = await fetch(`${BASE_URL}/api/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invoiceId,
      payee: "invalid-account-format",
      amount: "50000000",
    }),
  });
  assert.strictEqual(badRecipientRes.status, 400, "Invalid recipient format must return 400");
  const badRecipientData = await badRecipientRes.json();
  assert.strictEqual(badRecipientData.code, "INVALID_RECIPIENT");
  console.log("  ✓ 5a: Invalid recipient rejected with code INVALID_RECIPIENT.");

  // 5b. Invalid amount (negative or zero)
  const badAmountRes = await fetch(`${BASE_URL}/api/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invoiceId,
      payee: "0.0.4491823",
      amount: "-100000",
    }),
  });
  assert.strictEqual(badAmountRes.status, 400, "Invalid amount must return 400");
  const badAmountData = await badAmountRes.json();
  assert.strictEqual(badAmountData.code, "INVALID_AMOUNT");
  console.log("  ✓ 5b: Invalid amount rejected with code INVALID_AMOUNT.");

  // Step 6: Server-side Settlement Execution (simulation environment)
  console.log("\n[Test 6] Verifying truthful settlement execution in simulation environment...");
  const settleRes = await fetch(`${BASE_URL}/api/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invoiceId,
      payee: "0.0.4491823",
      amount: "50000000",
      simulation: true,
    }),
  });

  assert.strictEqual(settleRes.status, 200, "Settlement must succeed");
  const settleData = await settleRes.json();
  assert.strictEqual(settleData.success, true);
  assert.strictEqual(settleData.provenance, "SIMULATED", "Simulation must be explicitly marked");
  assert.strictEqual(settleData.txId, null, "txId must strictly be null in simulation (no fake ID)");
  assert.strictEqual(settleData.hashscanUrl, null, "hashscanUrl must strictly be null in simulation");
  assert(settleData.simulationNotice, "Expected simulation notice");
  console.log("✓ Test 6 Passed: Settlement executed truthfully with provenance SIMULATED and txId: null.");

  // Step 7: Settle and Query registered demo fixture
  console.log("\n[Test 7] Verifying settled demo fixture returns DPV 'Y' with truthful simulated provenance...");
  const fixtureRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Invoice": invoiceId,
    },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });

  assert.strictEqual(fixtureRes.status, 200, "Expected HTTP 200 OK for settled demo fixture");
  const fixtureData = await fixtureRes.json();
  assert.strictEqual(fixtureData.isValid, true, "Registered demo fixture must be marked valid");
  assert.strictEqual(fixtureData.dpvConfirmation, "Y", "DPV Confirmation must be 'Y'");
  assert.strictEqual(fixtureData.verificationMode, "SIMULATED_USPS", "Verification mode must be SIMULATED_USPS");
  assert.strictEqual(fixtureData.provenance, "SIMULATED", "Provenance must be SIMULATED");
  assert.strictEqual(fixtureData.paymentProvenance, "SIMULATED", "Payment provenance must be SIMULATED");
  assert.strictEqual(fixtureData.paymentTxId, null, "Payment txId must be null for simulated settlement");
  assert.strictEqual(fixtureData.isSimulated, true, "isSimulated must be true");
  assert(fixtureData.simulationNotice, "Expected simulationNotice explaining fixture simulation");
  assert(fixtureData.addressHash, "Expected addressHash to be present");
  assert(fixtureData.hcsAudit, "Expected HCS audit receipt");
  assert.strictEqual(fixtureData.hcsAudit.event, "X402_PAYMENT_VERIFIED");
  console.log(`✓ Test 7 Passed: Demo fixture verified with DPV 'Y', paymentTxId: null, and explicit SIMULATED provenance.`);

  // Step 8: Settle and Query arbitrary 5-digit ZIP -> MUST NOT return DPV Y
  console.log("\n[Test 8] Verifying arbitrary 5-digit ZIP does NOT return DPV 'Y' in simulation mode...");
  // Obtain invoice and settle for arbitrary address test
  const inv2Res = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      street: "123 Elm Street",
      city: "Dallas",
      state: "TX",
      zip: "75201",
    }),
  });
  assert.strictEqual(inv2Res.status, 402);
  const inv2 = await inv2Res.json();
  const invoice2 = inv2.x402.invoiceId;

  // Settle invoice 2
  await fetch(`${BASE_URL}/api/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceId: invoice2, simulation: true }),
  });

  const arbitraryRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Invoice": invoice2,
    },
    body: JSON.stringify({
      street: "123 Elm Street",
      city: "Dallas",
      state: "TX",
      zip: "75201",
    }),
  });

  assert.strictEqual(arbitraryRes.status, 200, "Expected HTTP 200 OK with rejected delivery status");
  const arbitraryData = await arbitraryRes.json();
  assert.strictEqual(arbitraryData.isValid, false, "Arbitrary non-fixture address must NOT be valid in simulation mode");
  assert.strictEqual(arbitraryData.dpvConfirmation, "N", "DPV Confirmation must be 'N' for unverified arbitrary address");
  assert(arbitraryData.error, "Expected error explaining address is not in demo fixture catalog");
  assert(arbitraryData.error.includes("not in simulated demo fixture catalog"), "Error must explain fixture requirement");
  assert.strictEqual(arbitraryData.verificationMode, "SIMULATED_USPS");
  assert.strictEqual(arbitraryData.provenance, "SIMULATED");
  console.log(`✓ Test 8 Passed: Arbitrary 5-digit ZIP was rejected with DPV 'N' as required.`);

  // Step 9: Settle and Query explicitly invalid address -> DPV N
  console.log("\n[Test 9] Verifying invalid address ('00000' / 'Fake St') is rejected...");
  const inv3Res = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      street: "999 Fake Street",
      city: "Nowhere",
      state: "FL",
      zip: "00000",
    }),
  });
  const inv3 = await inv3Res.json();
  const invoice3 = inv3.x402.invoiceId;

  await fetch(`${BASE_URL}/api/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceId: invoice3, simulation: true }),
  });

  const invalidRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Invoice": invoice3,
    },
    body: JSON.stringify({
      street: "999 Fake Street",
      city: "Nowhere",
      state: "FL",
      zip: "00000",
    }),
  });

  assert.strictEqual(invalidRes.status, 200);
  const invalidData = await invalidRes.json();
  assert.strictEqual(invalidData.isValid, false, "Invalid address must be marked invalid");
  assert.strictEqual(invalidData.dpvConfirmation, "N", "DPV Confirmation must be 'N'");
  console.log("✓ Test 9 Passed: Invalid test address rejected with DPV 'N'.");

  // Step 10: LIVE_USPS mode without credentials -> Returns HTTP 503
  console.log("\n[Test 10] Verifying explicit LIVE_USPS mode fails cleanly when credentials are absent...");
  const inv4Res = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });
  const inv4 = await inv4Res.json();
  const invoice4 = inv4.x402.invoiceId;

  await fetch(`${BASE_URL}/api/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceId: invoice4, simulation: true }),
  });

  const liveRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Invoice": invoice4,
      "X-Verification-Mode": "LIVE_USPS",
    },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });

  assert.strictEqual(liveRes.status, 503, "Expected HTTP 503 Service Unavailable when credentials missing");
  const liveData = await liveRes.json();
  assert(liveData.error, "Expected error message");
  assert(liveData.error.includes("USPS_USER_ID"), "Error must mention missing USPS_USER_ID credentials");
  console.log(`✓ Test 10 Passed: LIVE_USPS mode correctly returned 503: "${liveData.error}".`);

  // Step 11: Live USPS XML Parser Unit Testing
  console.log("\n[Test 11] Verifying USPS Web Tools XML response parser...");
  const { parseUspsXmlResponse } = await import("../src/lib/x402/oracleService.ts");

  // 11a. Valid USPS XML response (DPV Y)
  const validXml = `
    <AddressValidateResponse>
      <Address ID="0">
        <Address2>456 OAK AVE</Address2>
        <City>MIAMI</City>
        <State>FL</State>
        <Zip5>33101</Zip5>
        <Zip4>1234</Zip4>
        <DPVConfirmation>Y</DPVConfirmation>
        <DPVFootnotes>AABB</DPVFootnotes>
      </Address>
    </AddressValidateResponse>
  `;
  const parsedValid = parseUspsXmlResponse(validXml);
  assert.strictEqual(parsedValid.isValid, true);
  assert.strictEqual(parsedValid.dpvConfirmation, "Y");
  assert.strictEqual(parsedValid.standardizedAddress.street, "456 OAK AVE");
  assert.strictEqual(parsedValid.standardizedAddress.city, "MIAMI");
  assert.strictEqual(parsedValid.standardizedAddress.state, "FL");
  assert.strictEqual(parsedValid.standardizedAddress.zip, "33101-1234");
  console.log("  ✓ 11a: Valid XML parsed correctly (DPV Y, standardized address extracted).");

  // 11b. Invalid USPS XML response (DPV N)
  const invalidXml = `
    <AddressValidateResponse>
      <Address ID="0">
        <Address2>999 UNKNOWN RD</Address2>
        <City>NOWHERE</City>
        <State>FL</State>
        <Zip5>33101</Zip5>
        <DPVConfirmation>N</DPVConfirmation>
        <ReturnText>Address Not Deliverable</ReturnText>
      </Address>
    </AddressValidateResponse>
  `;
  const parsedInvalid = parseUspsXmlResponse(invalidXml);
  assert.strictEqual(parsedInvalid.isValid, false);
  assert.strictEqual(parsedInvalid.dpvConfirmation, "N");
  assert(parsedInvalid.error.toLowerCase().includes("deliverable"));
  console.log("  ✓ 11b: Undeliverable address parsed correctly (DPV N, isValid=false).");

  // 11c. Missing Secondary Unit (DPV D)
  const missingUnitXml = `
    <AddressValidateResponse>
      <Address ID="0">
        <Address2>100 MAIN ST</Address2>
        <City>MIAMI</City>
        <State>FL</State>
        <Zip5>33101</Zip5>
        <DPVConfirmation>D</DPVConfirmation>
        <ReturnText>Default address: missing apartment or suite number</ReturnText>
      </Address>
    </AddressValidateResponse>
  `;
  const parsedMissingUnit = parseUspsXmlResponse(missingUnitXml);
  assert.strictEqual(parsedMissingUnit.isValid, false);
  assert.strictEqual(parsedMissingUnit.dpvConfirmation, "D");
  console.log("  ✓ 11c: Missing secondary unit parsed correctly (DPV D, isValid=false).");

  // 11d. USPS Error Response
  const errorXml = `
    <Error>
      <Number>-2147219401</Number>
      <Source>clsWSAddressValidate:ValidateAddress</Source>
      <Description>Address Not Found.</Description>
    </Error>
  `;
  const parsedError = parseUspsXmlResponse(errorXml);
  assert.strictEqual(parsedError.isValid, false);
  assert.strictEqual(parsedError.dpvConfirmation, "N");
  assert(parsedError.error.includes("Address Not Found"));
  console.log("  ✓ 11d: USPS API Error parsed correctly with error description.");

  console.log("\n=======================================================");
  console.log("All Truthful x402 Oracle & Payment Tests PASSED! 🚀");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
