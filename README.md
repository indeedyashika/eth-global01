# Hermes Agent — Railway Template

Deploy [Hermes Agent](https://github.com/NousResearch/hermes-agent) on [Railway](https://railway.app) with a web-based admin dashboard for configuration, gateway management, and user pairing.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hermes-agent-ai?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

> Hermes Agent is an autonomous AI agent by [Nous Research](https://nousresearch.com/) that lives on your server, connects to your messaging channels (Telegram, Discord, Slack, etc.), and gets more capable the longer it runs.

<!-- TODO: Add dashboard screenshot -->
<!-- ![Dashboard](docs/dashboard.png) -->

## Features

- **Admin Dashboard** — dark-themed UI to configure providers, channels, tools, and manage the gateway
- **One-Page Setup** — provider dropdown, checkbox-based channel/tool toggles — no config files to edit
- **Gateway Management** — start, stop, restart the Hermes gateway from the browser
- **Live Status** — stat cards for gateway state, uptime, model, and pending pairing requests
- **Live Logs** — streaming gateway log viewer
- **User Pairing** — approve or deny users who message your bot, revoke access anytime
- **Multi-chain Tokenization Storefront** — the integrated Next.js platform supports Hedera testnet and Ethereum Sepolia; creation remains an operator-only Hermes action
- **Cookie Auth** — password-protected Hermes dashboard and setup
- **Public Tokenization UI** — wallet users can open the root URL without the Hermes admin login; the admin dashboard itself lives at `/hermes`
- **Reset Config** — one-click reset to start fresh
## Implementation Status

| Capability | Status | Evidence/Notes |
| :--- | :--- | :--- |
| **Hermes autonomous execution** | **LIVE** | Async daemon server (`apps/agent/server.py`) manages recurring liveness sweeps and `/api/agent/execute` autonomous pipeline runs within cryptographically bounded session allowances. Emits explicit simulated provenance in simulation mode. |
| **ERC-7579** | **LIVE** | `SessionKeyValidator.sol` implements 9-field session policy with EIP-712 nested array hashing (`allowedTargets`, `allowedSelectors`), time window checks, spend budget (`maxSpend`), flow ceiling (`maxFlow`), monotonic nonce replay protection, and ERC-4337 packed `validateUserOp` with signature verification. Parity verified in `sessionPolicy.ts` and test suite. |
| **Hedera HTS** | **LIVE** | Native HTS integration via `@hiero-ledger/sdk` in `tokenService.ts` (`TokenCreateTransaction`, `TokenGrantKycTransaction`, `TokenFreezeTransaction`, `TokenWipeTransaction`, `TokenPauseTransaction`, `TokenDissociateTransaction`). Submits real testnet transactions when operator credentials are configured. |
| **HCS** | **PARTIAL** | On-chain message submission via `TopicMessageSubmitTransaction` supported in `hcsAudit.ts` when `HEDERA_AUDIT_TOPIC_ID` and operator keys are configured. In demo/simulated mode, returns `provenance: "SIMULATED"` with `txId: null` and `hashscanUrl: null`. Fails closed with configuration error if topic is missing in LIVE mode; never falls back to operator account. |
| **x402** | **LIVE** | Full HTTP 402 payment challenge protocol implemented in `/api/x402/property-oracle` and `/api/x402/settle` using `Blocky402` specification. Enforces invoice issuance, unpaid challenge protection, server-side recipient/amount validation, and rejects unconfirmed/forged transaction IDs on Hedera testnet. |
| **USPS** | **PARTIAL** | Production XML parser and USPS Web Tools consumer implemented in `oracleService.ts` and `server.py`. Validates delivery point validation (DPV). Runs in `LIVE_USPS` mode with `USPS_USER_ID`, failing closed with HTTP 503 if credentials are missing; deterministic test fixtures for Miami (`DPV: Y`) and arbitrary ZIP/invalid address rejection (`DPV: N`). Never defaults to 'Y'. |
| **Chainlink Functions** | **COMPILED_ONLY** | `USPSChainlinkConsumer.sol` and `usps-verify.js` exist, compile, and encode/decode calldata and event topics (`AddressValidationRequested`, `AddressValidationFulfilled`). Live on-chain oracle subscriptions are not deployed or actively funded on testnet. |
| **Superfluid** | **SIMULATED** | Constant Flow Agreement (CFA) math (`(monthlyRent * shareBasisPoints) / 10000 / 2592000`) and stream management implemented in `YieldVault.sol` and `superfluid_mcp/server.py`. In local/demo environments, continuous stream execution returns `provenance: "SIMULATED"` with `txId: null` and `explorerUrl: null`. Client-side dashboard counter animates derived continuous accrual. |
| **World ID** | **LIVE** | IDKit verification integration in `src/lib/worldid/verification.ts` with real World API v4 endpoint verification (`/api/v4/verify`), expected action/signal hash validation, and environment gating. Rejects non-production proofs with `selfie_environment_mismatch` and fails closed with HTTP 503 when `WORLD_RP_ID` is unconfigured. |
| **YieldVault** | **COMPILED_ONLY** | `contracts/YieldVault.sol` compiled to `src/lib/evm/generated/YieldVault.json`. Calldata encoding, decoding, event topics, and continuous flow math verified in `test-contracts.mjs`. In `SIMULATED` mode, contracts are tracked as `COMPILED_ONLY` or `SIMULATED` unless configured on Sepolia. |
| **PropertyRegistry** | **COMPILED_ONLY** | `contracts/PropertyRegistry.sol` compiled to `src/lib/evm/generated/PropertyRegistry.json`. Calldata encoding, decoding, event topics, and deployment state machine verified via `test-contracts.mjs`. |
| **The Graph** | **INDEXED** | `subgraph.yaml` and `schema.graphql` define `Token`, `Account`, and `Transfer` entities. `/api/subgraph` executes live in-process GraphQL queries, provides studio deployment metadata, exposes dual MCP tools (`subgraph_read`, `subgraph_write`), and falls back to deterministic indexed account fixtures when offline. |
| **MCP** | **LIVE** | Model Context Protocol servers implemented in Python for `usps_chainlink`, `subgraph` (read/write), and `superfluid`. JSON-RPC endpoints expose tool definitions (`get_top_holders`, `add_token_source`, `validate_usps_address`, etc.) consumed by Hermes agent. |
| **liveness** | **LIVE** | Internal liveness sweep worker in `liveness.ts` monitors recurring Selfie Check deadlines; evaluates `OK`, `AT_RISK`, and `EXPIRED` states. Automatic reclaim transfers expired token balances back to treasury via approved allowance and arms Hedera Scheduled Transactions (`ScheduleCreateTransaction`). |
| **yield claims** | **SIMULATED** | `/api/yield/claim` enforces strict fail-closed security: requires active session authentication, verifies investor property ownership, enforces compliance/liveness checks, and requires `Idempotency-Key` headers (detecting duplicate claims). Fails closed with HTTP 503 `LIVE_SETTLEMENT_UNAVAILABLE` and `amountClaimed: "0"` because no live Base Sepolia fUSDCx transfer signer is configured. |
| **rent deposits** | **SIMULATED** | `/api/rent/simulate` requires authenticated operator session (`PRISM_OPERATOR_ADDRESSES`); non-operators receive HTTP 403. Computes continuous flow rate (`amount / 2592000`), records event to SQLite audit trail, logs HCS audit with `provenance: "SIMULATED"` and `txId: null`, explicitly marking simulated provenance. |

## Getting Started

The easiest way to get started:

### 1. Get an LLM Provider Key (free)

1. Register for free at [OpenRouter](https://openrouter.ai/)
2. Create an API key from your [OpenRouter dashboard](https://openrouter.ai/keys)
3. Pick a free model from the [model list sorted by price](https://openrouter.ai/models?order=pricing-low-to-high) (e.g. `google/gemma-3-1b-it:free`, `meta-llama/llama-3.1-8b-instruct:free`)

### 2. Set Up a Telegram Bot (fastest channel)

Hermes Agent interacts entirely through messaging channels — there is no chat UI like ChatGPT. Telegram is the quickest to set up:

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts, and copy the **Bot Token**
3. Send a message to your new bot — it will appear as a pairing request in the admin dashboard
4. To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot)

### 3. Deploy to Railway

1. Click the **Deploy on Railway** button above
2. Set the `ADMIN_PASSWORD` environment variable (or a random one will be generated and printed to deploy logs)
3. Attach a **volume** mounted at `/data` (persists config across redeploys)
4. Open your app URL — log in with username `admin` and your password

### 4. Configure in the Admin Dashboard

1. **LLM Provider** — select OpenRouter from the dropdown, paste your API key, enter the model name
2. **Messaging Channel** — check Telegram, paste the Bot Token from BotFather
3. Click **Save & Start** — the gateway will start and your bot goes live

### 5. Start Chatting

Message your Telegram bot. If you're a new user, a pairing request will appear in the admin dashboard under **Users** — click **Approve**, and you're in.

<!-- TODO: Add Telegram chat screenshot -->
<!-- ![Telegram Example](docs/telegram-example.png) -->

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Web server port (set automatically by Railway) |
| `ADMIN_USERNAME` | `admin` | Basic auth username |
| `ADMIN_PASSWORD` | *(auto-generated)* | Sign-in password — if unset, a random password is printed to logs |
| `HERMES_REF` | *(pinned in Dockerfile)* | Hermes Agent version to install (any upstream git tag/branch). Set this to override the Dockerfile default without editing code — see [Updating Hermes](#updating-hermes). |
| `HEDERA_NETWORK` | `testnet` | Hedera network used by both the operator and connected wallets. |
| `HEDERA_OPERATOR_ID` | *(required for token actions)* | Server-side operator/treasury account ID. |
| `HEDERA_OPERATOR_KEY` | *(required for token actions)* | Server-side operator private key. Never expose it to the browser or agent chat. |
| `WALLETCONNECT_PROJECT_ID` | *(required for wallet connection)* | Reown project ID served to the wallet client at runtime. |
| `SEPOLIA_RPC_URL` | *(required for EVM actions)* | Ethereum Sepolia JSON-RPC endpoint. |
| `EVM_OPERATOR_PRIVATE_KEY` | *(required for EVM actions)* | Funded Sepolia treasury/operator key. Server-side only. |
| `TOKENIZATION_APP_URL` | *(derived from browser URL)* | Optional canonical public URL (your root deploy URL), used in wallet metadata. |
| `DATABASE_PATH` | `/data/tokenization/tokenization.db` | Persistent SQLite database path in the Railway volume. |
| `LIVENESS_SWEEP_INTERVAL_SECONDS` | `15` | Internal recurring-Selfie expiry sweep interval; minimum 10 seconds. |

All other configuration (LLM provider, model, channels, tools) is managed through the admin dashboard.

### World ID policy

The Setup form can require either or both World ID credentials before a holder
is whitelisted:

- **Selfie Check** — a face credential with liveness and similarity checks.
- **Identity Check** — document-backed conditions. Minimum age and exact
  nationality are activated independently; at least one is selected when
  Identity Check is required.

Nationality values are stored as ISO 3166-1 alpha-3 codes. The current selector
contains Argentina (`ARG`), Australia (`AUS`), Chile (`CHL`), Colombia (`COL`),
Costa Rica (`CRI`), Croatia (`HRV`), Italy (`ITA`), Japan (`JPN`), Malaysia
(`MYS`), Mexico (`MEX`), Panama (`PAN`), Portugal (`PRT`), Singapore (`SGP`),
South Korea (`KOR`), United Kingdom (`GBR`), and United States (`USA`).
Availability can expand as World adds document support.

Selfie Check can also be made recurring. The creator chooses the exact renewal
period in seconds (minimum 60; `300` gives a five-minute demo). Each new proof
is verified through Hermes and World before the deadline moves. A holder first
approves a Hedera or ERC-20 token allowance; if the verified selfie expires,
the internal worker returns the holder's live balance to treasury and revokes
access. For Hedera periods up to 60 days, an on-chain Scheduled Transaction is
armed as an additional safety net; Sepolia uses ERC-20 `transferFrom`.

## Supported Providers

OpenRouter, DeepSeek, DashScope, GLM / Z.AI, Kimi, MiniMax, HuggingFace

## Supported Channels

Telegram, Discord, Slack, WhatsApp, Email, Mattermost, Matrix

## Supported Tool Integrations

Parallel (search), Firecrawl (scraping), Tavily (search), FAL (image gen), Browserbase, GitHub, OpenAI Voice (Whisper/TTS), Honcho (memory)

## Architecture

```
Railway Container
├── Python Admin Server (Starlette + Uvicorn)
│   ├── /, /tokens/*, /api/tokens/*, /api/runtime-config, /_next/* — Public proxy to the Next.js platform (no auth)
│   ├── /health      — Health check (no auth)
│   ├── /setup/api/* — Config, status, logs, gateway, pairing (cookie auth)
│   ├── /hermes      — Native Hermes dashboard entry point (cookie auth)
│   └── /*            — Authenticated proxy to the native Hermes dashboard
├── Next.js Tokenization Platform — private loopback subprocess on port 3000
├── Hermes dashboard — private loopback subprocess on port 9119
└── Hermes gateway   — managed async subprocess
```

The admin server runs on `$PORT` and manages Hermes plus the tokenization UI as child processes. Hermes config is stored in `/data/.hermes`, while tokenization data is stored in `/data/tokenization/tokenization.db`. The Next.js server is bound to loopback and owns the public root domain; the native Hermes dashboard (an upstream SPA that can't be moved under a URL prefix) keeps the rest of the path space, entered via `/hermes`.

## Running Locally

```bash
docker build -f apps/agent/Dockerfile -t hermes-agent .
docker run --rm -it -p 8080:8080 \
  -e PORT=8080 \
  -e ADMIN_PASSWORD=changeme \
  -e HEDERA_NETWORK=testnet \
  -e HEDERA_OPERATOR_ID=0.0.xxxxx \
  -e HEDERA_OPERATOR_KEY=your-private-key \
  -e WALLETCONNECT_PROJECT_ID=your-project-id \
  -v hermes-data:/data \
  hermes-agent
```

Open `http://localhost:8080` to use the public tokenization platform.
The Hermes dashboard at `http://localhost:8080/hermes` remains protected with
`admin` / `changeme`.

For Railway, keep the service **Root Directory** set to `/`. The repository-level
`railway.toml` selects `apps/agent/Dockerfile`, whose build context needs both
`apps/agent/` and `apps/platform/`.

## Updating Hermes

This template pins a specific Hermes Agent release in the `Dockerfile` (`ARG HERMES_REF`, currently `v2026.7.1`). To upgrade:

- **Recommended:** set a `HERMES_REF` service variable in Railway to any upstream [release tag](https://github.com/NousResearch/hermes-agent/releases) (e.g. `v2026.7.1`), then redeploy. It's passed in as a Docker build arg and overrides the Dockerfile default — no code change needed.
- **Or** bump `ARG HERMES_REF` in the `Dockerfile` and redeploy.

The "Update" button inside the Hermes dashboard is a **no-op on Railway** (it detects a container install and refuses) — the image is immutable, so a runtime self-update wouldn't survive a redeploy. Bump `HERMES_REF` and redeploy instead. When jumping releases, re-check that the Dockerfile's install extras still match upstream's `pyproject.toml`.

## Credits

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com/)
- UI inspired by [OpenClaw](https://github.com/praveen-ks-2001/openclaw-railway) admin template
