import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

// Server-only singleton: one operator/treasury account backs every token this app creates.
// This is a deliberate hackathon simplification (see README "Security model") — a production
// version would generate per-token keys and/or move signing behind an HSM/KMS.

declare global {
  var __hederaClient: Client | undefined;
  var __hederaOperatorKey: PrivateKey | undefined;
  var __hederaOperatorId: AccountId | undefined;
}

function network(): "mainnet" | "testnet" | "previewnet" {
  const n = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase();
  if (n === "mainnet" || n === "previewnet") return n;
  return "testnet";
}

export function isOperatorConfigured(): boolean {
  return Boolean(process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY);
}

function init(): void {
  const idStr = process.env.HEDERA_OPERATOR_ID;
  const keyStr = process.env.HEDERA_OPERATOR_KEY;
  const net = network();
  const client =
    net === "mainnet" ? Client.forMainnet() : net === "previewnet" ? Client.forPreviewnet() : Client.forTestnet();

  if (idStr && keyStr) {
    const operatorId = AccountId.fromString(idStr);
    const operatorKey = PrivateKey.isDerKey(keyStr) ? PrivateKey.fromStringDer(keyStr) : PrivateKey.fromStringECDSA(keyStr);
    client.setOperator(operatorId, operatorKey);
    globalThis.__hederaOperatorKey = operatorKey;
    globalThis.__hederaOperatorId = operatorId;
  } else {
    globalThis.__hederaOperatorId = AccountId.fromString(idStr || "0.0.4491823");
  }

  globalThis.__hederaClient = client;
}

export function getOperatorClient(): Client {
  if (!globalThis.__hederaClient) init();
  return globalThis.__hederaClient!;
}

export function getOperatorKey(): PrivateKey {
  if (!globalThis.__hederaOperatorKey) init();
  if (!globalThis.__hederaOperatorKey) {
    throw new Error("HEDERA_OPERATOR_KEY is not configured in environment.");
  }
  return globalThis.__hederaOperatorKey;
}

export function getOperatorId(): AccountId {
  if (!globalThis.__hederaOperatorId) init();
  return globalThis.__hederaOperatorId || AccountId.fromString("0.0.4491823");
}
