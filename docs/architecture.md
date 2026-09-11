# Architecture

The repository is split by runtime responsibility, not by feature name.

## Production applications

### `apps/platform`

The public Next.js application owns:

- the token storefront and holder wallet connection;
- the token and holder APIs;
- Hedera transactions, Sepolia ERC-20 transactions, and the SQLite database;
- World ID proof collection, private proof storage, and calls to World APIs.

World credentials and raw proofs stay in this trusted backend. They are never
sent to the language model.

### `apps/agent`

The private Python application owns:

- the Hermes dashboard and gateway lifecycle;
- authentication for the operator console;
- the public reverse proxy to the platform;
- the Hedera, EVM, World ID, and Subgraph adapters under `mcps/`, used by Hermes.

The World ID MCP receives sanitized verification records. It asks the platform
to verify a queued proof; it does not own World secrets or raw proofs.

## Deployment flow

Railway builds `apps/agent/Dockerfile` from the repository root. The first
Docker stage builds `apps/platform` as a standalone Next.js server. The final
image starts the Python agent application, which launches the platform on a
private loopback port and exposes it through the public proxy.

Persistent production state lives under `/data` in the Railway volume:

- `/data/.hermes` for Hermes configuration and sessions;
- `/data/tokenization/tokenization.db` for platform state.

World ID Selfie Check and Identity Check are tested through the real platform
flow. Identity Check uses the configured staging environment and World
Simulator; no separate laboratory application is required.
