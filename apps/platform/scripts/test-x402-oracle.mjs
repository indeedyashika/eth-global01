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
  console.log("=== Testing Truthful x402 USPS Property Oracle Implementation ===");

  // Step 1: Agent Services Discovery Directory
  console.log("\n[Test 1] Verifying Agent Services Discovery Schema...");
  const platformRoot = fs.existsSync(path.join(process.cwd(), "public"))
    ? process.cwd()
    : path.join(process.cwd(), "apps", "platform");
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
  console.log(`✓ Test 2 Passed: 402 challenge received with invoice ${unpaid.x402.invoiceId} (${unpaid.x402.displayAmount}).`);

  // Step 3: Paid Request with registered demo fixture in SIMULATED mode -> DPV Y
  console.log("\n[Test 3] Verifying registered demo fixture in SIMULATED mode returns DPV 'Y' with simulated provenance...");
  const fixtureRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Tx": "simulated_test_payment_proof",
      "X-Payment-Invoice": unpaid.x402.invoiceId,
    },
    body: JSON.stringify({
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101",
    }),
  });

  assert.strictEqual(fixtureRes.status, 200, "Expected HTTP 200 OK for demo fixture");
  const fixtureData = await fixtureRes.json();
  assert.strictEqual(fixtureData.isValid, true, "Registered demo fixture must be marked valid");
  assert.strictEqual(fixtureData.dpvConfirmation, "Y", "DPV Confirmation must be 'Y'");
  assert.strictEqual(fixtureData.verificationMode, "SIMULATED_USPS", "Verification mode must be SIMULATED_USPS");
  assert.strictEqual(fixtureData.provenance, "SIMULATED", "Provenance must be SIMULATED");
  assert.strictEqual(fixtureData.isSimulated, true, "isSimulated must be true");
  assert(fixtureData.simulationNotice, "Expected simulationNotice explaining fixture simulation");
  assert(fixtureData.addressHash, "Expected addressHash to be present");
  assert(fixtureData.hcsAudit, "Expected HCS audit receipt");
  assert.strictEqual(fixtureData.hcsAudit.event, "X402_PAYMENT_VERIFIED");
  console.log(`✓ Test 3 Passed: Demo fixture verified with DPV 'Y' and explicit SIMULATED_USPS provenance.`);

  // Step 4: Paid Request with arbitrary 5-digit ZIP in SIMULATED mode -> MUST NOT return DPV Y!
  console.log("\n[Test 4] Verifying arbitrary 5-digit ZIP does NOT automatically return DPV 'Y'...");
  const arbitraryRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Tx": "simulated_test_payment_proof",
      "X-Payment-Invoice": "inv_arb_test",
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
  console.log(`✓ Test 4 Passed: Arbitrary 5-digit ZIP was rejected with DPV 'N' as required.`);

  // Step 5: Explicitly invalid address -> DPV N
  console.log("\n[Test 5] Verifying invalid address ('00000' / 'Fake St') is rejected...");
  const invalidRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Tx": "simulated_test_payment_proof",
      "X-Payment-Invoice": "inv_inv_test",
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
  console.log("✓ Test 5 Passed: Invalid test address rejected with DPV 'N'.");

  // Step 6: LIVE_USPS mode without credentials -> Returns HTTP 503
  console.log("\n[Test 6] Verifying explicit LIVE_USPS mode fails cleanly when credentials are absent...");
  const liveRes = await fetch(`${BASE_URL}/api/x402/property-oracle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Tx": "simulated_test_payment_proof",
      "X-Payment-Invoice": "inv_live_test",
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
  console.log(`✓ Test 6 Passed: LIVE_USPS mode correctly returned 503: "${liveData.error}".`);

  // Step 7: Live USPS XML Parser Unit Testing
  console.log("\n[Test 7] Verifying USPS Web Tools XML response parser...");
  const { parseUspsXmlResponse } = await import("../src/lib/x402/oracleService.ts");

  // 7a. Valid USPS XML response (DPV Y)
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
  console.log("  ✓ 7a: Valid XML parsed correctly (DPV Y, standardized address extracted).");

  // 7b. Invalid USPS XML response (DPV N)
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
  console.log("  ✓ 7b: Undeliverable address parsed correctly (DPV N, isValid=false).");

  // 7c. Missing Secondary Unit (DPV D)
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
  console.log("  ✓ 7c: Missing secondary unit parsed correctly (DPV D, isValid=false).");

  // 7d. USPS Error Response
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
  console.log("  ✓ 7d: USPS API Error parsed correctly with error description.");

  console.log("\n=======================================================");
  console.log("All Truthful USPS Oracle Tests PASSED successfully! 🚀");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
