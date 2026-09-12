import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const platformRoot = fs.existsSync(path.join(process.cwd(), "public"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "platform");

// Execute via tsx if not already running under tsx
if (!process.env.__TSX_RUNNING__) {
  const result = spawnSync("npx", ["tsx", "scripts/test-hedera-audit-topic-config.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

console.log("=== Hedera Audit Topic Configuration & Operator Separation Tests ===\n");

const {
  isValidTopicId,
  getAuditTopicId,
  requireLiveAuditTopic,
  getOrCreateAuditTopic,
  logHcsAuditEvent,
  _resetAuditTopicCacheForTesting,
  _setCachedTopicIdForTesting,
} = await import("../src/lib/hedera/hcsAudit.ts");

const {
  getOperatorId,
  getOptionalOperatorId,
  _resetHederaClientForTesting,
} = await import("../src/lib/hedera/client.ts");

const ORIGINAL_ENV = { ...process.env };

function resetEnvironment() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.HEDERA_AUDIT_TOPIC_ID;
  delete process.env.HEDERA_OPERATOR_ID;
  delete process.env.HEDERA_OPERATOR_KEY;
  delete process.env.PRISM_CONTRACT_MODE;
  _resetAuditTopicCacheForTesting();
  _resetHederaClientForTesting();
}

try {
  // Test 1: Topic ID Format Validation
  console.log("[Test 1] Validating Hedera topic ID format validator...");
  assert.strictEqual(isValidTopicId("0.0.12345"), true, "0.0.12345 must be valid");
  assert.strictEqual(isValidTopicId("0.0.592819"), true, "0.0.592819 must be valid");
  assert.strictEqual(isValidTopicId("0.0.0"), false, "0.0.0 must be rejected");
  assert.strictEqual(isValidTopicId("0.0.-5"), false, "Negative entity ID must be rejected");
  assert.strictEqual(isValidTopicId("0.0.abc"), false, "Non-numeric entity ID must be rejected");
  assert.strictEqual(isValidTopicId(""), false, "Empty string must be rejected");
  assert.strictEqual(isValidTopicId(null), false, "Null must be rejected");
  assert.strictEqual(isValidTopicId(undefined), false, "Undefined must be rejected");
  console.log("  ✓ Test 1 Passed: Topic ID format validation correct.");

  // Test 2: Operator Account ID Fallback Elimination
  console.log("\n[Test 2] Verifying operator account does not silently fall back to 0.0.4491823...");
  resetEnvironment();
  assert.throws(
    () => getOperatorId(),
    /HEDERA_OPERATOR_ID is not configured in environment/,
    "getOperatorId() must throw when HEDERA_OPERATOR_ID is unset"
  );
  assert.strictEqual(getOptionalOperatorId(), null, "getOptionalOperatorId() must return null when unset");

  process.env.HEDERA_OPERATOR_ID = "0.0.778899";
  _resetHederaClientForTesting();
  assert.strictEqual(getOperatorId().toString(), "0.0.778899");
  assert.strictEqual(getOptionalOperatorId()?.toString(), "0.0.778899");
  console.log("  ✓ Test 2 Passed: Operator account ID requires explicit configuration without unsafe fallbacks.");

  // Test 3: Separation of Operator Account and Audit Topic Configuration
  console.log("\n[Test 3] Verifying operator account and audit topic must be strictly separate...");
  resetEnvironment();
  // Legitimate distinct test values
  process.env.HEDERA_OPERATOR_ID = "0.0.111111";
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.111111"; // Unsafe: same ID used for both
  assert.throws(
    () => getAuditTopicId(),
    /identical to HEDERA_OPERATOR_ID/,
    "Reusing operator account as audit topic must be rejected"
  );

  _resetAuditTopicCacheForTesting();
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.222222"; // Distinct topic ID
  assert.strictEqual(getAuditTopicId(), "0.0.222222");
  console.log("  ✓ Test 3 Passed: Operator and audit topic separation strictly enforced.");

  // Test 4: LIVE Mode Startup Validation
  console.log("\n[Test 4] Verifying LIVE mode startup/configuration validation...");
  resetEnvironment();
  process.env.PRISM_CONTRACT_MODE = "LIVE";

  // 4a. Missing topic ID in LIVE mode
  assert.throws(
    () => requireLiveAuditTopic(),
    /LIVE mode requires HEDERA_AUDIT_TOPIC_ID/,
    "LIVE mode must throw if HEDERA_AUDIT_TOPIC_ID is missing"
  );

  // 4b. Malformed topic ID in LIVE mode
  process.env.HEDERA_AUDIT_TOPIC_ID = "invalid_topic";
  _resetAuditTopicCacheForTesting();
  assert.throws(
    () => requireLiveAuditTopic(),
    /Invalid HEDERA_AUDIT_TOPIC_ID format for LIVE mode/,
    "LIVE mode must throw if HEDERA_AUDIT_TOPIC_ID is malformed"
  );

  // 4c. Same operator and topic in LIVE mode
  process.env.HEDERA_OPERATOR_ID = "0.0.333333";
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.333333";
  _resetAuditTopicCacheForTesting();
  assert.throws(
    () => requireLiveAuditTopic(),
    /cannot match HEDERA_OPERATOR_ID/,
    "LIVE mode must reject matching operator and topic IDs"
  );

  // 4d. Valid distinct topic ID in LIVE mode
  process.env.HEDERA_AUDIT_TOPIC_ID = "0.0.444444";
  _resetAuditTopicCacheForTesting();
  assert.strictEqual(requireLiveAuditTopic(), "0.0.444444");
  console.log("  ✓ Test 4 Passed: LIVE mode validates topic presence, format, and operator decoupling.");

  // Test 5: Fail-Closed Behavior When Unconfigured
  console.log("\n[Test 5] Verifying truthful fail-closed behavior when no audit topic exists...");
  resetEnvironment();

  const topicResult = await getOrCreateAuditTopic();
  assert.strictEqual(topicResult, null, "getOrCreateAuditTopic must return null when no topic or operator exists");

  const receipt = await logHcsAuditEvent({
    event: "TEST_PROPERTY_VERIFIED",
    addressHash: "0x1234",
  });

  assert.strictEqual(receipt.status, "FAILED", "Must report FAILED status when unconfigured");
  assert.strictEqual(receipt.topicId, null, "topicId must strictly be null when unconfigured");
  assert.strictEqual(receipt.txId, null, "txId must strictly be null (no fake transaction ID)");
  assert.strictEqual(receipt.sequenceNumber, null, "sequenceNumber must strictly be null (no fake sequence)");
  assert.strictEqual(receipt.hashscanUrl, null, "hashscanUrl must strictly be null (no fake explorer URL)");
  assert.notStrictEqual(receipt.topicId, "0.0.4491823", "Must NEVER silently use hardcoded topic 0.0.4491823");
  console.log("  ✓ Test 5 Passed: Truthful fail-closed behavior without hardcoded topic fallbacks.");

  // Test 6: LIVE HCS Audit Fails Clearly When Topic is Missing
  console.log("\n[Test 6] Verifying live HCS audit fails clearly when topic is missing...");
  resetEnvironment();
  await assert.rejects(
    async () => {
      await logHcsAuditEvent(
        { event: "TEST_LIVE_EVENT" },
        { requireLive: true }
      );
    },
    /Live HCS audit failed: HEDERA_AUDIT_TOPIC_ID is not configured/,
    "Live audit must throw clear error when topic ID is missing"
  );
  console.log("  ✓ Test 6 Passed: Live HCS audit fails clearly when topic is missing.");

  console.log("\n==================================================================");
  console.log("All Hedera audit topic configuration tests passed successfully!");
  console.log("==================================================================");
  process.exit(0);
} finally {
  process.env = ORIGINAL_ENV;
}
