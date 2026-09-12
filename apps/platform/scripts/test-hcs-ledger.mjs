import assert from "node:assert";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const platformRoot = path.resolve(__dirname, "..");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-hcs-ledger.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

console.log("=== PRISM 8: Real Hedera HCS Audit Ledger Behavioral Tests ===\n");

// 1. Import HCS audit and ledger services
const {
  isValidTopicId,
  getAuditTopicId,
  requireLiveAuditTopic,
  logHcsAuditEvent,
  _resetAuditTopicCacheForTesting,
} = await import("../src/lib/hedera/hcsAudit.ts");

const {
  persistHcsAuditRecord,
  getAuthoritativeHcsLedger,
  getHcsSequenceCount,
} = await import("../src/lib/hedera/hcsLedgerService.ts");

const { getDb } = await import("../src/lib/db/index.ts");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.HEDERA_AUDIT_TOPIC_ID;
  delete process.env.HEDERA_OPERATOR_ID;
  delete process.env.HEDERA_OPERATOR_KEY;
  _resetAuditTopicCacheForTesting();
}

const db = getDb();

try {
  // -------------------------------------------------------------
  // Test 1: Missing Topic Configuration
  // -------------------------------------------------------------
  console.log("[Test 1] Testing missing HEDERA_AUDIT_TOPIC_ID configuration...");
  resetEnv();

  assert.strictEqual(getAuditTopicId(), null, "getAuditTopicId must return null when unset");

  assert.throws(
    () => requireLiveAuditTopic(),
    /HEDERA_AUDIT_TOPIC_ID is not configured in environment/,
    "requireLiveAuditTopic must throw when HEDERA_AUDIT_TOPIC_ID is unset"
  );

  await assert.rejects(
    async () => {
      await logHcsAuditEvent(
        { event: "TEST_MISSING_TOPIC" },
        { throwOnFailure: true }
      );
    },
    /HEDERA_AUDIT_TOPIC_ID is not configured in environment/,
    "logHcsAuditEvent must throw when throwOnFailure is true and topic is missing"
  );

  await assert.rejects(
    async () => {
      await logHcsAuditEvent(
        { event: "TEST_LIVE_MISSING" },
        { requireLive: true }
      );
    },
    /Live HCS audit failed/,
    "logHcsAuditEvent must throw when requireLive is true and topic is missing"
  );

  // Soft failure mode returns FAILED status without synthetic IDs
  const softReceipt = await logHcsAuditEvent({ event: "TEST_SOFT_FAIL" });
  assert.strictEqual(softReceipt.status, "FAILED");
  assert.strictEqual(softReceipt.topicId, null);
  assert.strictEqual(softReceipt.sequenceNumber, null);
  assert.strictEqual(softReceipt.txId, null);
  assert.strictEqual(softReceipt.hashscanUrl, null);

  console.log("  ✓ Test 1 Passed: Missing topic configuration is strictly rejected (no silent fallbacks).");

  // -------------------------------------------------------------
  // Test 2: Invalid Topic ID Format
  // -------------------------------------------------------------
  console.log("\n[Test 2] Testing invalid HEDERA_AUDIT_TOPIC_ID format rejection...");
  resetEnv();

  const invalidTopics = ["not-a-topic", "0.0.0", "0.0.-1", "0.0.abc"];
  for (const invalid of invalidTopics) {
    assert.strictEqual(isValidTopicId(invalid), false, `isValidTopicId must reject "${invalid}"`);

    process.env.HEDERA_AUDIT_TOPIC_ID = invalid;
    _resetAuditTopicCacheForTesting();

    assert.throws(
      () => getAuditTopicId(),
      /Invalid HEDERA_AUDIT_TOPIC_ID format/,
      `getAuditTopicId must throw on invalid topic: "${invalid}"`
    );

    assert.throws(
      () => requireLiveAuditTopic(),
      /Invalid HEDERA_AUDIT_TOPIC_ID format/,
      `requireLiveAuditTopic must throw on invalid topic: "${invalid}"`
    );

    await assert.rejects(
      async () => {
        await logHcsAuditEvent({ event: "TEST_INVALID" }, { throwOnFailure: true });
      },
      /Invalid HEDERA_AUDIT_TOPIC_ID format/,
      `logHcsAuditEvent must reject invalid topic: "${invalid}"`
    );
  }

  // Blank or whitespace strings
  for (const blank of ["", "   "]) {
    assert.strictEqual(isValidTopicId(blank), false);
    process.env.HEDERA_AUDIT_TOPIC_ID = blank;
    _resetAuditTopicCacheForTesting();
    assert.strictEqual(getAuditTopicId(), null);
    assert.throws(() => requireLiveAuditTopic(), /HEDERA_AUDIT_TOPIC_ID/);
  }
  console.log("  ✓ Test 2 Passed: Invalid topic ID formats are strictly rejected.");

  // -------------------------------------------------------------
  // Test 3: Operator and Topic Separation
  // -------------------------------------------------------------
  console.log("\n[Test 3] Testing strict separation of operator account and audit topic...");
  resetEnv();

  process.env.HEDERA_OPERATOR_ID = "0.0.55555";
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.55555"; // Identical IDs: dangerous collision
  _resetAuditTopicCacheForTesting();

  assert.throws(
    () => getAuditTopicId(),
    /identical to HEDERA_OPERATOR_ID/,
    "Reusing operator ID as audit topic must be rejected"
  );

  assert.throws(
    () => requireLiveAuditTopic(),
    /cannot match HEDERA_OPERATOR_ID/,
    "requireLiveAuditTopic must reject operator/topic collision"
  );

  // Valid distinct configuration
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.99999";
  _resetAuditTopicCacheForTesting();
  assert.strictEqual(getAuditTopicId(), "0.0.99999");
  assert.strictEqual(requireLiveAuditTopic(), "0.0.99999");
  console.log("  ✓ Test 3 Passed: Operator account and audit topic must be configured distinctly.");

  // -------------------------------------------------------------
  // Test 4: Failed HCS Transaction Handling
  // -------------------------------------------------------------
  console.log("\n[Test 4] Testing failed HCS transaction handling without synthetic fallback...");
  resetEnv();
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.77777";
  process.env.HEDERA_OPERATOR_ID = "0.0.11111";
  _resetAuditTopicCacheForTesting();

  // Mock client that simulates an on-chain network rejection or timeout
  const mockFailingClient = {
    _isMock: true,
  };

  await assert.rejects(
    async () => {
      await logHcsAuditEvent(
        {
          event: "TEST_FAILED_TX",
          propertyId: "prop_456_oak_ave",
        },
        { throwOnFailure: true, client: mockFailingClient }
      );
    },
    /Live HCS audit message submission failed/,
    "Failed HCS transaction must throw error and not invent synthetic receipt"
  );

  // Verify that failure did not write an unconfirmed entry to SQLite
  const failedCheck = db
    .prepare("SELECT * FROM hcs_audit_records WHERE event_type = 'TEST_FAILED_TX'")
    .all();
  assert.strictEqual(failedCheck.length, 0, "No unconfirmed record should be persisted on failure");
  console.log("  ✓ Test 4 Passed: Failed HCS transactions fail closed without local replacements.");

  // -------------------------------------------------------------
  // Test 5: Successful HCS Message Submission & Record Extraction
  // -------------------------------------------------------------
  console.log("\n[Test 5] Testing successful HCS message lifecycle with verified consensus...");
  resetEnv();
  const testTopicId = "0.0.77777";
  process.env.HEDERA_AUDIT_TOPIC_ID = testTopicId;
  process.env.HEDERA_OPERATOR_ID = "0.0.11111";
  _resetAuditTopicCacheForTesting();

  // Test persistence service directly with authentic consensus data
  const canonicalTxId = "0.0.11111@1726164000.123456789";
  const canonicalConsensusTimestamp = "2026-09-12T18:40:00.123Z";
  const canonicalSequence = 88;

  const persisted = persistHcsAuditRecord({
    topicId: testTopicId,
    sequenceNumber: canonicalSequence,
    consensusTimestamp: canonicalConsensusTimestamp,
    txId: canonicalTxId,
    type: "X402_PROPERTY_DPV_VERIFIED",
    propertyId: "prop_456_oak_ave",
    actor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    token: "OAK-RWA",
    network: "Hedera Testnet",
    txLink: `https://hashscan.io/testnet/transaction/${canonicalTxId}`,
    memo: "USPS DPV Deliverability Confirmed (0.5 HBAR micropayment)",
    metadata: { dpvConfirmation: "Y", invoiceId: "inv_live_001" },
  });

  assert.strictEqual(persisted.topicId, testTopicId);
  assert.strictEqual(persisted.sequenceNumber, canonicalSequence);
  assert.strictEqual(persisted.consensusTimestamp, canonicalConsensusTimestamp);
  assert.strictEqual(persisted.txId, canonicalTxId);
  assert.strictEqual(persisted.type, "X402_PROPERTY_DPV_VERIFIED");
  console.log("  ✓ Test 5 Passed: Successful HCS consensus record persisted and returned.");

  // -------------------------------------------------------------
  // Test 6: Actual Sequence Number Persistence
  // -------------------------------------------------------------
  console.log("\n[Test 6] Verifying actual sequence number persistence in SQLite database...");
  const seqRow = db
    .prepare("SELECT * FROM hcs_audit_records WHERE topic_id = ? AND sequence_number = ?")
    .get(testTopicId, canonicalSequence);

  assert.ok(seqRow, "Persisted row must exist in SQLite");
  assert.strictEqual(Number(seqRow.sequence_number), canonicalSequence, "Sequence number must match exactly");
  assert.notStrictEqual(seqRow.sequence_number, 0, "Sequence number must never be zero");
  assert.notStrictEqual(seqRow.sequence_number, 1, "Must not be hardcoded default sequence");
  console.log(`  ✓ Test 6 Passed: Actual sequence number (#${seqRow.sequence_number}) verified in database.`);

  // -------------------------------------------------------------
  // Test 7: Actual Transaction ID Persistence
  // -------------------------------------------------------------
  console.log("\n[Test 7] Verifying actual transaction ID persistence in SQLite database...");
  assert.strictEqual(seqRow.tx_id, canonicalTxId, "Transaction ID must match exact Hedera tx format");
  assert.ok(seqRow.tx_id.includes("@"), "Hedera tx ID must follow account@seconds.nanos standard");
  console.log(`  ✓ Test 7 Passed: Actual transaction ID (${seqRow.tx_id}) verified in database.`);

  // -------------------------------------------------------------
  // Test 8: All 10 Required Protocol Fields Present & Non-Empty
  // -------------------------------------------------------------
  console.log("\n[Test 8] Verifying all 10 required protocol fields in HCS audit record...");
  const requiredFields = [
    ["topic_id", seqRow.topic_id],
    ["sequence_number", seqRow.sequence_number],
    ["consensus_timestamp", seqRow.consensus_timestamp],
    ["tx_id", seqRow.tx_id],
    ["event_type", seqRow.event_type],
    ["property_id", seqRow.property_id],
    ["actor", seqRow.actor],
    ["token_id", seqRow.token_id],
    ["network", seqRow.network],
    ["tx_link", seqRow.tx_link],
  ];

  for (const [fieldName, val] of requiredFields) {
    assert.ok(val !== null && val !== undefined && String(val).trim().length > 0, `Field ${fieldName} must be present and non-empty`);
  }
  console.log("  ✓ Test 8 Passed: All 10 required fields present and non-empty in authoritative record:");
  for (const [k, v] of requiredFields) {
    console.log(`    - ${k}: ${v}`);
  }

  // -------------------------------------------------------------
  // Test 9: Absence of Hardcoded / Synthetic Sequence Numbers
  // -------------------------------------------------------------
  console.log("\n[Test 9] Verifying absence of synthetic sequence fallbacks...");
  // Querying for an unknown property must return exactly 0, never hardcoded 4
  const unknownCount = getHcsSequenceCount({ propertyId: "prop_non_existent_address_hash" });
  assert.strictEqual(unknownCount, 0, "Sequence count for unknown property must strictly be 0 (no hardcoded 4)");

  const oakCount = getHcsSequenceCount({ propertyId: "prop_456_oak_ave" });
  assert.ok(oakCount >= 1, "Real Oak Avenue sequence count must reflect real rows");
  console.log("  ✓ Test 9 Passed: No hardcoded sequence counts or synthetic minimums exist.");

  // -------------------------------------------------------------
  // Test 10: GET /api/tokens/[tokenId]/ledger API Route Verification
  // -------------------------------------------------------------
  console.log("\n[Test 10] Testing GET /api/tokens/[tokenId]/ledger endpoint...");
  const { GET: getLedgerRoute } = await import("../src/app/api/tokens/[tokenId]/ledger/route.ts");

  const req = new Request("http://localhost:3000/api/tokens/prop_456_oak_ave/ledger");
  const params = Promise.resolve({ tokenId: "prop_456_oak_ave" });
  const response = await getLedgerRoute(req, { params });

  assert.strictEqual(response.status, 200, "API route must return HTTP 200");
  const body = await response.json();

  assert.strictEqual(body.success, true);
  assert.strictEqual(body.topicId, testTopicId);
  assert.ok(Array.isArray(body.records), "Records must be an array");
  assert.ok(body.records.length >= 1, "Records must contain persisted events");
  assert.strictEqual(body.records[0].sequenceNumber, canonicalSequence);
  assert.strictEqual(body.records[0].consensusTimestamp, canonicalConsensusTimestamp);
  assert.strictEqual(body.records[0].txId, canonicalTxId);
  assert.strictEqual(body.records[0].propertyId, "prop_456_oak_ave");
  assert.strictEqual(body.records[0].token, "OAK-RWA");
  assert.strictEqual(body.records[0].network, "Hedera Testnet");
  console.log("  ✓ Test 10 Passed: GET /api/tokens/[tokenId]/ledger returns verified 10-field records.");

  console.log("\n==================================================================");
  console.log("✓ ALL 10 HEDERA HCS CONSENSUS LEDGER BEHAVIORAL TESTS PASSED!");
  console.log("==================================================================");
  process.exit(0);
} finally {
  process.env = ORIGINAL_ENV;
}
