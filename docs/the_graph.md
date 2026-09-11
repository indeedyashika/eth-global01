# The Graph

## Why we use it

- The Graph indexes ERC20 `Transfer` events into a queryable GraphQL API, letting Hermes answer token analytics questions (biggest transfer, top holders, balances, recent activity) instantly instead of scanning chain logs itself.
- Hedera isn't indexed by The Graph, so this subgraph gives Hermes the same kind of "stats" tool for Ethereum Sepolia tokens, complementing the Mirror-Node-backed Hedera stats tools that already cover the Hedera side — together the two MCPs give Hermes token analytics across both chains it operates on.
- The subgraph's tracked-token set is agent-managed at runtime: `add_token_source`/`set_token_sources` let Hermes autonomously start tracking a newly deployed token and redeploy it to Graph Studio itself, without a human touching `subgraph.yaml`.
- `get_deployment_status` lets Hermes verify Graph Studio is actually serving the latest config rather than trusting that a deploy CLI exit code succeeded.

## Implementation files

- `apps/agent/mcps/subgraph/README.md` — experiment overview, deploy steps, tracked-token management, and deployment-verification notes.
- `apps/agent/mcps/subgraph/subgraph/schema.graphql` — `Token`, `Account` (per-token balance), and `Transfer` (with `isMintOrBurn`) entities.
- `apps/agent/mcps/subgraph/subgraph/src/mapping.ts` — shared `handleTransfer` handler for every tracked ERC20 dataSource; derives balances/counts and tags mint/burn transfers.
- `apps/agent/mcps/subgraph/subgraph/subgraph.yaml` — manifest listing one dataSource per tracked ERC20 contract on Sepolia, sharing one mapping via a YAML anchor.
- `apps/agent/mcps/subgraph/subgraph/scripts/add-source.mjs` — appends one new ERC20 dataSource to `subgraph.yaml`.
- `apps/agent/mcps/subgraph/subgraph/scripts/set-sources.mjs` — rewrites the entire dataSource list (the only way to remove tokens).
- `apps/agent/mcps/subgraph/subgraph/scripts/deploy.mjs` — non-interactive `graph deploy` using `GRAPH_DEPLOY_KEY`.
- `apps/agent/mcps/subgraph/mcp-server/src/index.ts` — MCP server exposing `get_token_info`, `get_biggest_transfer`, `get_top_holders`, `get_recent_transfers`, `get_account_balance`, `get_latest_sepolia_block`, `get_tracked_tokens`, `get_deployment_status`, `add_token_source`, and `set_token_sources`.
- `apps/agent/server.py` — wires the `subgraph` MCP into Hermes (env vars, working directory).
- `apps/agent/start.sh` — seeds `/data/subgraph` from the read-only image template on boot, preserving a live `subgraph.yaml` across redeploys.
- `apps/agent/.env.example` — documents the subgraph-related env vars (`SUBGRAPH_URL`, `SEPOLIA_RPC_URL`, `GRAPH_DEPLOY_KEY`, `GRAPH_SUBGRAPH_NAME`).

## Tracks addressed

- Best AI Use Case of The Graph.
- Best AI Tooling for The Graph.

See `feedbacks/the_graph.md` for sponsor feedback.
