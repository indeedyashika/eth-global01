import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function runTests() {
  console.log("=== Testing x402 Property Oracle Protocol and Discovery ===");

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
  const oracleModulePath = path.join(platformRoot, "src", "lib", "x402", "oracleService.js");
  const { handlePropertyOracleRequest } = await import(pathToFileURL(oracleModulePath).href);
  const unpaid = await handlePropertyOracleRequest({
    street: "456 Oak Avenue",
    city: "Miami",
    state: "FL",
    zip: "33101"
  });
  assert.strictEqual(unpaid.status, 402, "Expected HTTP 402 Payment Required");
  assert(unpaid.x402, "Expected x402 challenge payload");
  assert.strictEqual(unpaid.x402.facilitator, "blocky402");
  assert.strictEqual(unpaid.x402.network, "hedera-testnet");
  assert(unpaid.x402.invoiceId, "Expected unique invoiceId in x402 challenge");
  assert(unpaid.x402.amount, "Expected payment amount in tinybars");
  console.log(`✓ Test 2 Passed: 402 received with invoice ${unpaid.x402.invoiceId} (${unpaid.x402.displayAmount}).`);

  // Step 3: Paid Request -> HTTP 200 with USPS DPV and HCS Audit Trail
  console.log("\n[Test 3] Verifying paid request returns HTTP 200 with USPS data and HCS audit...");
  const paid = await handlePropertyOracleRequest(
    {
      street: "456 Oak Avenue",
      city: "Miami",
      state: "FL",
      zip: "33101"
    },
    {
      paymentTx: "0.0.12345@1741234567.890000000",
      invoiceId: unpaid.x402.invoiceId
    }
  );
  assert.strictEqual(paid.status, 200, "Expected HTTP 200 OK");
  assert.strictEqual(paid.data.isValid, true, "Property should be marked valid");
  assert.strictEqual(paid.data.dpvConfirmation, "Y", "DPV Confirmation must be 'Y'");
  assert(paid.data.addressHash, "Expected addressHash to be present");
  assert(paid.data.hcsAudit, "Expected HCS audit receipt");
  assert.strictEqual(paid.data.hcsAudit.event, "X402_PAYMENT_VERIFIED");
  console.log(`✓ Test 3 Passed: 200 OK received with addressHash ${paid.data.addressHash.slice(0, 10)}... and HCS sequence #${paid.data.hcsAudit.sequenceNumber}.`);

  console.log("\n=======================================================");
  console.log("All x402 Property Oracle tests PASSED successfully! 🚀");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
