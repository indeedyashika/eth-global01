import { hashSignal } from "@worldcoin/idkit-core/hashing";

export type WorldVerificationResponse = {
  success?: boolean;
  action?: string;
  nullifier?: string;
  code?: string;
  detail?: string;
  message?: string;
  results?: Array<{
    identifier?: string;
    success?: boolean;
    nullifier?: string;
    signal_hash?: string;
    code?: string;
    detail?: string;
  }>;
};

type WorldIdResult = {
  action?: string;
  environment?: string;
  protocol_version?: string;
  user_presence_completed?: boolean;
  identity_attested?: boolean;
  responses?: Array<{
    identifier?: string;
    nullifier?: string;
    signal_hash?: string;
  }>;
};

export class WorldProofError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: string
  ) {
    super(message);
    this.name = "WorldProofError";
  }
}

export function expectedWorldAction(check: "selfie" | "identity"): string {
  return check === "selfie"
    ? process.env.WORLD_ACTION ?? "selfie-check-demo"
    : process.env.WORLD_IDENTITY_ACTION ?? "identity-check-demo";
}

export function getWorldError(payload: WorldVerificationResponse) {
  const failedResult = payload.results?.find((result) => !result.success);
  return {
    code: payload.code ?? failedResult?.code ?? "world_verification_failed",
    details:
      payload.detail ??
      failedResult?.detail ??
      payload.message ??
      "World did not accept the verification proof.",
  };
}

export async function verifyWithWorld(rpId: string, idkitResult: unknown) {
  const response = await fetch(
    `https://developer.world.org/api/v4/verify/${encodeURIComponent(rpId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResult),
      cache: "no-store",
    },
  );
  const payload = (await response.json()) as WorldVerificationResponse;
  return { response, payload };
}

function readResult(value: unknown): WorldIdResult {
  if (!value || typeof value !== "object") {
    throw new WorldProofError("Missing IDKit verification result.", 400, "missing_result");
  }
  return value as WorldIdResult;
}

function requireConfiguration() {
  const rpId = process.env.WORLD_RP_ID;
  if (!rpId) {
    throw new WorldProofError("WORLD_RP_ID is not configured.", 503, "world_not_configured");
  }
  return rpId;
}

function assertExpectedSignal(
  result: WorldIdResult,
  expectedSignal: string | undefined,
  identifiers: string[]
) {
  if (!expectedSignal) return;
  const credential = result.responses?.find((response) =>
    identifiers.includes(response.identifier ?? "")
  );
  const expectedHash = hashSignal(expectedSignal).toLowerCase();
  if (!credential?.signal_hash || credential.signal_hash.toLowerCase() !== expectedHash) {
    throw new WorldProofError(
      "This World ID proof is not bound to the connected Hedera wallet.",
      400,
      "signal_mismatch"
    );
  }
}

async function exchangeVerifiedProof(rpId: string, result: WorldIdResult) {
  try {
    return await verifyWithWorld(rpId, result);
  } catch (error) {
    throw new WorldProofError(
      "The World verification service could not be reached.",
      502,
      "world_unavailable",
      error instanceof Error ? error.message : undefined
    );
  }
}

export async function verifySelfieCredential(
  value: unknown,
  expectedSignal?: string
): Promise<{ nullifier: string; credential: string }> {
  const rpId = requireConfiguration();
  const action = expectedWorldAction("selfie");
  const result = readResult(value);

  if (result.environment !== "production") {
    throw new WorldProofError(
      "Selfie Check must run in the production World App.",
      400,
      "selfie_environment_mismatch",
      `Received environment: ${result.environment ?? "missing"}.`
    );
  }
  if (result.user_presence_completed !== true) {
    throw new WorldProofError(
      "World did not confirm fresh user presence.",
      400,
      "user_presence_required"
    );
  }
  if (result.action && result.action !== action) {
    throw new WorldProofError(
      "This proof belongs to another World ID action.",
      400,
      "action_mismatch"
    );
  }
  assertExpectedSignal(result, expectedSignal, ["face", "selfie"]);

  const { response, payload } = await exchangeVerifiedProof(rpId, result);
  if (!response.ok) {
    const worldError = getWorldError(payload);
    throw new WorldProofError(
      "World rejected the Selfie Check proof.",
      response.status >= 500 ? 502 : 400,
      worldError.code,
      worldError.details
    );
  }
  if (payload.action && payload.action !== action) {
    throw new WorldProofError(
      "World verified another action.",
      400,
      "verified_action_mismatch"
    );
  }

  const credential = payload.results?.find(
    (candidate) =>
      candidate.success && ["face", "selfie"].includes(candidate.identifier ?? "")
  );
  if (!credential) {
    throw new WorldProofError(
      "World verified the proof without a Selfie Check credential.",
      400,
      "wrong_credential"
    );
  }
  if (!credential.nullifier) {
    throw new WorldProofError(
      "World accepted the Selfie Check without returning a nullifier.",
      502,
      "missing_nullifier"
    );
  }

  return {
    nullifier: credential.nullifier,
    credential: credential.identifier ?? "selfie",
  };
}

export async function verifyIdentityCredential(
  value: unknown,
  expectedSignal?: string
): Promise<{ nullifier: string; credential: string }> {
  const rpId = requireConfiguration();
  const action = expectedWorldAction("identity");
  const result = readResult(value);

  if (result.action !== action) {
    throw new WorldProofError(
      "This proof belongs to another World ID action.",
      400,
      "action_mismatch"
    );
  }
  if (result.environment !== "staging") {
    throw new WorldProofError(
      "Identity Check must run in the staging World Simulator.",
      400,
      "identity_environment_mismatch",
      `Received environment: ${result.environment ?? "missing"}.`
    );
  }
  if (result.protocol_version !== "4.0") {
    throw new WorldProofError(
      "Identity Check requires a World ID 4.0 proof.",
      400,
      "identity_check_requires_v4"
    );
  }
  if (result.identity_attested !== true) {
    throw new WorldProofError(
      "The requested identity attributes were not matched.",
      400,
      "identity_attributes_not_matched"
    );
  }
  assertExpectedSignal(result, expectedSignal, ["passport", "mnc"]);

  const { response, payload } = await exchangeVerifiedProof(rpId, result);
  if (!response.ok) {
    const worldError = getWorldError(payload);
    throw new WorldProofError(
      "World rejected the Identity Check proof.",
      response.status >= 500 ? 502 : 400,
      worldError.code,
      worldError.details
    );
  }
  if (payload.action && payload.action !== action) {
    throw new WorldProofError(
      "World verified another action.",
      400,
      "verified_action_mismatch"
    );
  }

  const credential = payload.results?.find(
    (candidate) =>
      candidate.success && ["passport", "mnc"].includes(candidate.identifier ?? "")
  );
  if (!credential) {
    throw new WorldProofError(
      "World verified no compatible NFC identity credential.",
      400,
      "wrong_identity_credential"
    );
  }
  if (!credential.nullifier) {
    throw new WorldProofError(
      "World accepted the Identity Check without returning a nullifier.",
      502,
      "missing_nullifier"
    );
  }

  return {
    nullifier: credential.nullifier,
    credential: credential.identifier ?? "identity",
  };
}
