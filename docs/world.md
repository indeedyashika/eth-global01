# World

## Why we use it

- Selfie Check confirms that a fresh, live person is present before a holder can receive a gated token.
- Identity Check proves only required attributes such as minimum age or nationality without exposing document data.
- Verified World results control native Hedera KYC approval and treasury distribution rather than acting as a generic login.
- Hermes reviews queued proofs through a dedicated World MCP while raw proofs and RP secrets remain in the trusted backend.
- Recurring Selfie Check restarts a holder-specific deadline only after Hermes verifies a fresh proof with World.

## Implementation files

- `apps/platform/src/components/HolderWorldIdCheck.tsx` — Selfie and Identity Check holder flows.
- `apps/platform/src/app/api/worldid/rp-signature/route.ts` — short-lived RP request signatures.
- `apps/platform/src/app/api/worldid/verifications/` — agent-authenticated verification queue API.
- `apps/platform/src/app/api/tokens/[tokenId]/holders/[accountId]/worldid-verify/route.ts` — wallet- and token-bound proof submission.
- `apps/platform/src/lib/worldid/verification.ts` — trusted World API verification and credential checks.
- `apps/platform/src/lib/worldid/pendingVerification.ts` — queued proof execution and holder state update.
- `apps/platform/src/lib/liveness.ts` — verified-selfie renewal deadlines and expired-holder processing.
- `apps/platform/src/lib/hermes/livenessWebhook.ts` — constrained Hermes trigger for recurring proofs.
- `apps/platform/src/lib/worldid/policy.ts` — Selfie/Identity eligibility policy.
- `apps/platform/src/lib/worldid/proof.ts` — canonical proof replay digest.
- `apps/platform/src/lib/db/schema.ts` and `apps/platform/src/lib/db/repo.ts` — proof queue, nullifier scope, timestamps, and replay protection.
- `apps/agent/mcps/worldid/server.py` — sanitized World verification tools used by Hermes.
- `apps/agent/mcps/hedera/write_server.py` — recurring-liveness token policy and deterministic expiry sweep tool (`process_liveness_expirations`, state-mutating).
- `apps/agent/agent-identity/AGENTS.md` — agent instructions for World-gated token requests.

World AgentKit is not currently integrated. The project uses IDKit, World verification APIs, and a dedicated Hermes MCP. The implemented sponsor tracks are **Selfie Check Beta** and **Identity Check Beta Test**.

See `feedbacks/world.md` for sponsor feedback.
