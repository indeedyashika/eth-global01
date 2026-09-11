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
  // TODO(real integration): replace with IDKit's verifyCloudProof(proof, app_id, action)
  // and persist the returned nullifier_hash to prevent a single human from verifying twice.
  await new Promise((resolve) => setTimeout(resolve, 300)); // pretend we called out to World ID

  return {
    verified: true,
    verifiedAt: new Date().toISOString(),
    nullifierHash: `stub_${Buffer.from(accountId).toString("hex").slice(0, 24)}`,
    note: "MOCKED — replace lib/worldid/mock.ts with a real IDKit verifyCloudProof() call before demoing compliance to judges as production-ready.",
  };
}
