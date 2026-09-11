# Multi-chain Tokenization Platform (Hedera + Ethereum Sepolia)

A frontend + backend for issuing real-world-asset tokens on **Hedera Token Service (HTS)** or
as compliance-aware **ERC-20 contracts on Ethereum Sepolia**, with
compliance controls picked as checkboxes at creation time — KYC, freeze-gating, wipe/clawback,
pause, and World ID-gated whitelisting with liveness-based auto-reclaim.

The Hedera adapter remains entirely native HTS/Schedule Service via the Hedera SDK. The Solidity
contract under `contracts/` belongs only to the separate Sepolia adapter.

## Why HTS instead of an ERC-20 contract

Every compliance primitive this app needs — KYC, freeze, wipe, pause, custom fees — is a
**native token key/feature** on Hedera, enforced by consensus nodes, not application code. That
means:

- Compliance can't be bypassed by calling the token contract directly — there is no contract.
- The Hedera network itself rejects a non-compliant transfer even if this app's local database
  is stale or wrong (see the comment in `POST /api/tokens/[id]/transfer`).

## Architecture

Single Next.js 16 app (App Router, TypeScript, Tailwind). No separate backend process.
In the integrated deployment it is built as a standalone Node server and exposed
publicly at the root domain through Hermes's reverse proxy — Hermes's own admin
dashboard lives at `/hermes` instead. There is no public UI for creating new
tokens; that only happens via a direct `POST /api/tokens` call made by the
operator.

```
src/
  app/
    page.tsx                     storefront (server component, reads SQLite directly)
    tokens/[tokenId]/page.tsx    token workspace (holder self-service + admin panel)
    api/tokens/...               shared token/holder route handlers
    api/evm/tokens               Sepolia ERC-20 deployment route
  components/                    React UI
  hooks/useWalletConnect.tsx     WalletConnect (HashPack etc.) client-side wallet state
  hooks/useEvmWallet.tsx         injected EVM wallet and ERC-20 allowance signing
  lib/
    hedera/
      client.ts                 operator/treasury Client singleton
      tokenService.ts           TokenCreate/GrantKyc/Freeze/Wipe/Pause/Transfer
      scheduleService.ts        Scheduled Transaction safety net for auto-reclaim
      mirrorNode.ts             confirms holder-granted token allowances
      format.ts                 HashScan link helpers
    evm/client.ts               Sepolia deploy/mint/allowlist/freeze/reclaim adapter
    db/                         better-sqlite3 (schema in schema.ts, queries in repo.ts)
    walletconnect/connector.ts  browser DAppConnector singleton
    worldid/verification.ts     shared World verification API client
    worldid/pendingVerification.ts agent-triggered proof queue executor
    liveness.ts                 selfie deadlines + deterministic reclaim worker
    validation.ts               zod schemas for every API route
  types/index.ts                shared domain types
```

**SDK note:** this project uses `@hiero-ledger/sdk`, not `@hashgraph/sdk`. The WalletConnect
integration (`@hashgraph/hedera-wallet-connect`) is built against `@hiero-ledger/sdk`
specifically — mixing it with `@hashgraph/sdk` would create two incompatible copies of every
SDK class (`AccountId`, `Transaction`, ...). `@hiero-ledger/sdk` is a full drop-in with the same
API surface. Similarly, wallet connection uses `@hashgraph/hedera-wallet-connect`'s legacy
`DAppConnector` rather than full Reown AppKit — `hashconnect` (the older HashPack-specific
library) prints its own deprecation notice ("will be shut down by 2026"), so it was avoided.

## Compliance checkboxes → HTS features

| Checkbox (create-token form)          | HTS mechanism                                             |
| -------------------------------------- | ----------------------------------------------------------- |
| Require KYC approval                   | `kycKey` set; admin `TokenGrantKycTransaction` per account   |
| Freeze new accounts by default         | `freezeKey` + `freezeDefault=true`; admin unfreezes on approval |
| Enable wipe / clawback                 | `wipeKey`; admin `TokenWipeTransaction` (immediate reclaim)  |
| Enable pause                           | `pauseKey`; admin `TokenPauseTransaction`                    |
| Custom fee                             | `feeScheduleKey` + `CustomFixedFee` / `CustomFractionalFee` / `CustomRoyaltyFee` |
| Require World ID before whitelisting   | Server-verified World credential gate on top of KYC/freeze |
| Recurring Selfie Check & auto-reclaim  | World-verified renewal + token allowance + worker/**Scheduled Transaction** (see below) |

Whitelisting an address = granting KYC and/or unfreezing it, whichever mechanism(s) the token
was created with. Both are real, independent HTS controls — a token can require either, both,
or neither.

## Liveness / auto-reclaim mechanism

This is the "if the person has not repeated Selfie Check within X time, return
their token balance to treasury" feature. The minimum policy is 60 seconds, so
minute-scale periods can be used in a demo; production policies can use days or
months.

1. A holder who wants to receive a liveness-gated token approves a **token allowance** to the
   treasury (`AccountAllowanceApproveTransaction`, signed by their own wallet). This lets the
   treasury move tokens *out* of the holder's account later without needing another signature.
2. A fresh Selfie proof is queued and Hermes verifies it with World. Only that
   trusted result starts or renews the holder's deadline; there is no manual
   check-in endpoint.
3. For periods up to 60 days, the backend also creates a **Hedera Scheduled
   Transaction** — [HIP-423](https://hips.hedera.com/hip/hip-423): a
   `TransferTransaction` (using the approved allowance) wrapped in `ScheduleCreateTransaction`
   with `setExpirationTime(...)` + `setWaitForExpiry(true)`. The operator's signature (as the
   spender) is attached at creation time, so the network can execute the reclaim
   at expiry.
4. A deterministic internal worker covers every duration, checks the live
   holder balance, performs the approved transfer if needed, then revokes KYC
   and/or freezes the account. A fresh verified selfie cancels the previous
   schedule and arms the next deadline.

Caveats (documented in code comments too):
- A scheduled transaction's amount is fixed at creation time. The worker reads
  the live balance at expiry, so it is the authoritative fallback if the amount
  changed or the schedule could not execute.
- Hedera caps a schedule expiry at 62 days. The platform uses schedules up to
  60 days and the worker for longer policies such as 90 days.

## World ID access demo

The storefront and each deployed token workspace use real World ID proofs. For
holder token requests, verification is an explicit Hermes decision through the
separate `worldid` MCP:

- **Selfie Check** uses `selfieCheckLegacy` in `production`, requires fresh user
  presence, and verifies the Face proof through World API v4.
- **Identity Check** uses World ID 4 in `staging`, so its `18+` and `USA`
  attribute requests can be completed through the World Simulator. The
  application only receives the attestation result, never the document data.
- The browser submits a wallet-bound proof to a short-lived server queue. It is
  never exposed to the LLM or returned through MCP tools.
- When the holder requests a token, Hermes calls `verify_pending_proof`; the
  trusted Next.js backend exchanges the queued payload with World, stores a
  replay-protected nullifier hash, and erases the raw proof.
- A holder is marked verified only after that World response succeeds. Selfie
  and Identity timestamps remain separate so one credential cannot satisfy the
  other policy. Abandoned raw proofs expire after 30 minutes.
- The platform scopes nullifier use to the token and holder policy: the same
  person may qualify for several tokens, while one World identity cannot claim
  the same token through two Hedera accounts. A fresh proof from the same
  holder is allowed to refresh a future liveness timestamp; an exact proof
  payload replay remains rejected.

Recurring Selfie Check uses a fresh World flow for every renewal. Hermes
re-verifies the queued proof through the World MCP, after which the backend
restarts the deadline and re-arms automatic return.

Configure `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`,
`WORLD_RP_SIGNING_KEY`, `WORLD_ACTION`, and `WORLD_IDENTITY_ACTION` as
documented in `.env.example`. `src/lib/worldid/mock.ts` is retained as an
isolated development reference, but no production holder route calls it.

## Setup

1. **Get a Hedera testnet account** (operator/treasury for every token this app creates):
   [portal.hedera.com](https://portal.hedera.com) or hashscan.io → Connect Wallet → Create
   account. You need the Account ID (`0.0.x`) and its DER-encoded private key.
2. **Get a free Reown/WalletConnect project ID** at [cloud.reown.com](https://cloud.reown.com) —
   needed for the "Connect wallet" flow (HashPack, Kabila, etc.). Set it as
   `WALLETCONNECT_PROJECT_ID`; the app exposes this public identifier to the browser at runtime.
3. For Sepolia, configure `SEPOLIA_RPC_URL` and a funded
   `EVM_OPERATOR_PRIVATE_KEY`. That account becomes the ERC-20 treasury and compliance operator.
4. Copy the env file and fill it in:
   ```bash
   cp .env.example .env
   ```
5. Install and run:
   ```bash
   npm install
   npm run dev
   ```
6. Open http://localhost:3000. Hedera creation uses `POST /api/tokens`; Sepolia ERC-20 creation
   uses `POST /api/evm/tokens`. Then open it
   in a second browser (or incognito window) with a *different* funded testnet account connected
   to act as the holder.

## Known simplifications (hackathon scope)

- **Single operator key** backs every token's admin/kyc/freeze/wipe/pause/supply/fee-schedule
  key, and is also the treasury. A production version would generate per-token keys and move
  signing behind an HSM/KMS.
- **No native request authentication** on the admin/holder API routes (pause, wipe, freeze,
  whitelist, transfer, distribute, etc.) — anyone who can reach the deployment can call them. The
  integrated container only binds Next.js to loopback, which stops direct access to port 3000; it
  does **not** gate these routes behind the Hermes session, since the tokenization app is
  intentionally public. Session/signature-based authorization on the admin-only endpoints is
  needed before this holds real value beyond a testnet demo.
- **NFT tokens** can be created (all the same compliance keys apply), but minting individual
  serials / per-serial transfer management isn't built — the workspace UI shows a placeholder
  for non-fungible tokens on the distribute/reclaim panels.
- **Association & allowance verification**: association is confirmed server-side via an
  `AccountBalanceQuery`; allowance approval is confirmed through Hedera Mirror Node before it
  unlocks distribution.
- Amounts throughout the API/UI are in the token's **base units** (respecting whatever
  `decimals` it was created with), not decimal-adjusted display units.
