import { createHash } from "node:crypto";

/** Canonical JSON keeps the replay digest stable even if an attacker reorders object keys. */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded ?? "null";
}

export function serializeWorldIdProof(value: unknown): {
  proofJson: string;
  proofHash: string;
} {
  const proofJson = JSON.stringify(value);
  if (!proofJson) throw new TypeError("The World ID proof could not be serialized.");
  return {
    proofJson,
    proofHash: createHash("sha256").update(canonicalJson(value)).digest("hex"),
  };
}
