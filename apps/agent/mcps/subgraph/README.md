# graph_experiments

Experiment: use The Graph to let an agent index and answer data questions about ERC20 tokens it
deploys, on Ethereum Sepolia (The Graph doesn't index Hedera yet). Ships with one default token
tracked: `0xf531b8f309be94191af87605cfbf600d71c2cfe0` (Sepolia, indexed from block `11350000`) —
see "Adding/removing tracked tokens" below to change the set.

Two parts:

- `subgraph/` — indexes every `Transfer` event for an agent-chosen set of ERC20 contracts into
  `Token`, `Account`, and `Transfer` entities (one dataSource per tracked token, all sharing the
  same handler). `Account.balance` is derived from transfers (mints/burns to/from the zero
  address are tracked but excluded from balance math for the non-zero side, and flagged via
  `Transfer.isMintOrBurn` so you can filter them out of things like "biggest transfer").
- `mcp-server/` — two independent MCP servers sharing a `common.ts` GraphQL client:
  - `src/read.ts` (`subgraph_read`) — query-only tools: `get_token_info`, `get_biggest_transfer`,
    `get_top_holders`, `get_recent_transfers`, `get_account_balance`, `get_latest_sepolia_block`,
    `get_tracked_tokens` (reads local `subgraph.yaml`), and `get_deployment_status` (confirms
    what's *actually* live on Graph Studio versus what's just locally configured). Never imports
    `node:child_process` — safe to hand to a read-only agent profile.
  - `src/write.ts` (`subgraph_write`) — `add_token_source` / `set_token_sources`, which edit
    `subgraph.yaml` and shell out to the graph-cli to redeploy. Requires `GRAPH_DEPLOY_KEY`.

## 1. Deploy the subgraph

Requires a free [Graph Studio](https://thegraph.com/studio/) account.

```bash
cd subgraph
npm install
npx graph auth --studio <YOUR_DEPLOY_KEY>   # from Studio: create a subgraph first, grab its deploy key
# (`graph auth --studio` still works fine even though `deploy --studio` doesn't on this CLI version)
npm run codegen
npm run build
npm run deploy   # deploys to the subgraph name "sepolia-test" — rename in package.json if you used a different name in Studio
```

Wait for the Studio dashboard to show the subgraph fully synced, then grab its query URL from the
"Details" tab -- but use the **`version/latest`** form, not the version-pinned one Studio shows by
default (`.../sepolia-test/auto-<timestamp>`, which freezes to that specific deploy):

```
https://api.studio.thegraph.com/query/<id>/sepolia-test/version/latest
```

Studio always resolves `version/latest` to whichever version was deployed most recently, so
`SUBGRAPH_URL` set to this form never goes stale -- every future redeploy (via `add_token_source`
/ `set_token_sources`) is picked up automatically, no config changes needed. `deploy.mjs` prints
both forms after every deploy as a reminder. Queries against Studio's own endpoint are free — no
GRT/billing needed for this experiment.

## 2. Run the MCP server(s)

```bash
cd mcp-server
npm install
SUBGRAPH_URL="<query url from step 1>" npm run start:read
# and, only for an agent that's allowed to add/remove tracked tokens:
SUBGRAPH_URL="<query url from step 1>" GRAPH_DEPLOY_KEY="<deploy key>" npm run start:write
```

To wire these into Claude Code, add entries to your MCP config pointing at each server, e.g.:

```json
{
  "mcpServers": {
    "graph-experiments-read": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/graph_experiments/mcp-server/src/read.ts"],
      "env": { "SUBGRAPH_URL": "<query url from step 1>" }
    },
    "graph-experiments-write": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/graph_experiments/mcp-server/src/write.ts"],
      "env": { "SUBGRAPH_URL": "<query url from step 1>", "GRAPH_DEPLOY_KEY": "<deploy key>" }
    }
  }
}
```

Give an agent only `graph-experiments-read` if it should be able to answer questions about
tracked tokens but never change what's indexed or spend the deploy key.

## Adding/removing tracked tokens

- **`set_token_sources`** (MCP tool) replaces the *entire* tracked set in one call — pass the full
  list of `{address, startBlock, name?}` you want tracked; anything omitted is dropped. This is
  the only way to remove a token. Equivalent CLI: `npm run set-sources -- --tokens '[...]'` in
  `subgraph/`, then `npm run codegen && npm run build && npm run deploy`.
- **`add_token_source`** (MCP tool) appends one token without disturbing the rest — convenience
  wrapper, can't remove anything.
- The first dataSource is always named `ERC20Token` regardless of what you pass — `src/mapping.ts`
  imports codegen output from that fixed name, so it can't be renamed per-token.
- Every deploy gets a fresh Graph Studio version label, but that's invisible to `SUBGRAPH_URL` as
  long as it's set to the `version/latest` form (see step 1 above) — no runtime bookkeeping needed.

## Verifying what's actually live

`get_tracked_tokens` only reads the local `subgraph.yaml` — if a deploy's `codegen`/`build` steps
succeed but the final `deploy` step fails (bad key, network blip), the manifest is already rewritten
even though Studio never got the new version, so it can lie. `get_deployment_status` closes that
gap: it queries the subgraph's built-in `_meta { deployment }` field (every subgraph exposes this
automatically), which returns the exact IPFS hash of the manifest Studio is currently serving --
the same hash `graph deploy` prints as `Build completed: Qm...`. `add_token_source`/
`set_token_sources` already do this comparison automatically after every deploy and report whether
it's confirmed live; call `get_deployment_status` directly any time query results look stale, wrong,
or empty.

## Notes

- "Biggest transfer" defaults to excluding mints/burns (`excludeMintBurn: true`) since those are
  usually not representative of real holder-to-holder activity — pass `false` to include them.
- This is wired into the Hermes Railway deployment (`hermes-agent-template/`) as the `graph` MCP
  server — see that template's `.env.example` for the `GRAPH_DEPLOY_KEY` / `GRAPH_SUBGRAPH_NAME` /
  `SUBGRAPH_URL` Railway variables it needs.
