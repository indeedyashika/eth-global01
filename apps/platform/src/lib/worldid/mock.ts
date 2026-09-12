// -----------------------------------------------------------------------------------------
// World ID integration STUB.
//
// The real integration (deferred per the product brief — "that part comes later") should use
// World ID's MiniKit / IDKit (https://docs.world.org/world-id) to get a zero-knowledge proof
// that the connected wallet is controlled by a unique verified human, then verify that proof
// server-side against World ID's `/verify` endpoint before trusting it.
//
// For now this module fakes a successful verification so the rest of the compliance pipeline
// (the `worldIdRequired` checkbox gating whitelist approval, the UI badge, the event log) is
// fully wired up and demoable. Swap `verifyWorldId` below for a real IDKit `verifyCloudProof`
// call and nothing else in the app needs to change — every caller only depends on this
// function's signature.
// -----------------------------------------------------------------------------------------

export interface WorldIdProof {
  // Real shape (IDKit ISuccessResult): merkle_root, nullifier_hash, proof, verification_level.
  // Accepting `unknown` here since the stub doesn't inspect it.
  raw?: unknown;
}

export interface WorldIdVerifyResult {
  verified: boolean;
  verifiedAt: string;
  nullifierHash: string;
  note: string;
}

export async function verifyWorldId(
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  proof?: WorldIdProof
): Promise<WorldIdVerifyResult> {
  throw new Error(
    "WORLD_ID_INTEGRATION_REQUIRED: Real IDKit verification must be configured. Synthetic or mock verification is strictly disabled."
  );
}
