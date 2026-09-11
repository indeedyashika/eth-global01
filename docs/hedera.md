# Hedera

## Why we use it

- Hedera Token Service creates and manages the fungible RWA tokens without deploying Solidity contracts.
- Native KYC, freeze, wipe, pause, supply, and fee-schedule keys enforce token lifecycle controls at network level.
- Holder wallets sign token association and allowance transactions through WalletConnect before receiving assets.
- Hermes can autonomously mint a treasury shortfall and transfer exactly one requested token on Hedera Testnet.
- HashScan links, approved transfers, and Scheduled Transactions provide an auditable path for distribution and recurring-liveness reclaim.

## Implementation files

- `apps/platform/src/lib/hedera/client.ts` — operator/treasury Hedera client.
- `apps/platform/src/lib/hedera/tokenService.ts` — token creation, minting, KYC, freeze, wipe, pause, and transfers.
- `apps/platform/src/lib/hedera/scheduleService.ts` — scheduled reclaim transactions.
- `apps/platform/src/lib/hedera/mirrorNode.ts` — confirms holder-granted token allowances.
- `apps/platform/src/lib/liveness.ts` — expiry worker and live-balance return to treasury.
- `apps/platform/src/lib/hedera/format.ts` — network-aware HashScan links.
- `apps/platform/src/hooks/useWalletConnect.tsx` — holder-signed association and allowance transactions.
- `apps/platform/src/lib/walletconnect/connector.ts` — Hedera WalletConnect configuration.
- `apps/platform/src/app/api/tokens/` — public and operator token lifecycle API routes.
- `apps/platform/src/lib/tokenRequests.ts` — idempotent Hermes mint-and-transfer fulfillment.
- `apps/agent/mcps/hedera/{read_server,write_server}.py` — Hedera MCP tools exposed to
  Hermes, split into read-only (bookkeeping/Mirror Node lookups) and write
  (deploy/whitelist/distribute/reclaim/pause) servers so a read-only agent profile can
  be granted analytics access without any path to mutate token state.

## Tracks addressed

- Tokenization on Hedera.
- "No Solidity Allowed" — the project uses native Hedera SDK services only.
- AI & Agentic Payments — Hermes executes an autonomous HTS mint/transfer after eligibility verification.
