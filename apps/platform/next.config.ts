import type { NextConfig } from "next";

if ((process.env.PRISM_CONTRACT_MODE ?? "SIMULATED").toUpperCase() === "LIVE") {
  const required = ["PROPERTY_REGISTRY_ADDRESS", "YIELD_VAULT_ADDRESS"];
  const missing = required.filter((key) => !/^0x[0-9a-fA-F]{40}$/.test(process.env[key]?.trim() ?? ""));
  if (missing.length) {
    throw new Error(`PRISM_CONTRACT_MODE=LIVE requires valid contract addresses: ${missing.join(", ")}`);
  }

  const topicId = process.env.HEDERA_AUDIT_TOPIC_ID?.trim();
  if (!topicId || !/^\d+\.\d+\.[1-9]\d*$/.test(topicId)) {
    throw new Error("PRISM_CONTRACT_MODE=LIVE requires a valid HEDERA_AUDIT_TOPIC_ID (e.g. 0.0.xxxxx)");
  }

  const operatorId = process.env.HEDERA_OPERATOR_ID?.trim();
  if (operatorId && topicId === operatorId) {
    throw new Error(
      `HEDERA_AUDIT_TOPIC_ID (${topicId}) must not be identical to HEDERA_OPERATOR_ID. Operator account and HCS audit topic must be configured separately.`
    );
  }
}

const nextConfig: NextConfig = {
  // This app owns the public root — Hermes reverse-proxies its own admin
  // dashboard under /hermes instead. See src/lib/paths.ts.

  // Produce the minimal Node server embedded in the Hermes container.
  output: "standalone",
};

export default nextConfig;
