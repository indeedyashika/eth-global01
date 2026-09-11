#!/usr/bin/env node
// Read-only subgraph MCP server.
//
// Exposes only GraphQL queries against the deployed subgraph (and a public Sepolia
// JSON-RPC block read) -- nothing here can edit subgraph.yaml or trigger a `graph
// deploy`. This file deliberately never imports node:child_process, so there is no
// tool here whose implementation could shell out even if a future edit tried to add
// one carelessly. See write.ts for add_token_source / set_token_sources.
//
// This is the MCP registered for any agent profile that should be able to answer
// questions about a token but must never be able to act on it (see
// apps/agent/server.py:write_config_yaml's `pr` profile).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  SEPOLIA_RPC_URL,
  queryGraph,
  queryDeploymentMeta,
  readTrackedTokens,
  textResult,
  tokenWhere,
  tokenAddressArg,
} from "./common.js";

const server = new McpServer({ name: "graph-experiments-read", version: "0.1.0" });

server.tool(
  "get_token_info",
  "List the indexed ERC20 token(s)' name, symbol, decimals, and total transfer count.",
  { tokenAddress: tokenAddressArg },
  async ({ tokenAddress }) => {
    const where = tokenAddress ? `(where: { id: "${tokenAddress.toLowerCase()}" })` : "";
    const data = await queryGraph(`{
      tokens${where} {
        id
        name
        symbol
        decimals
        transferCount
      }
    }`);
    return textResult(data.tokens);
  }
);

server.tool(
  "get_biggest_transfer",
  "Find the largest ERC20 transfer ever indexed, by raw token value.",
  {
    tokenAddress: tokenAddressArg,
    excludeMintBurn: z
      .boolean()
      .default(true)
      .describe("Exclude mints/burns (transfers to/from the zero address)"),
  },
  async ({ tokenAddress, excludeMintBurn }) => {
    const where = tokenWhere(tokenAddress, excludeMintBurn ? "isMintOrBurn: false" : undefined);
    const data = await queryGraph(`{
      transfers(first: 1, orderBy: value, orderDirection: desc${where}) {
        id
        token { id symbol }
        from { address }
        to { address }
        value
        isMintOrBurn
        blockNumber
        blockTimestamp
        transactionHash
      }
    }`);
    const transfers = data.transfers as unknown[];
    return textResult(transfers[0] ?? null);
  }
);

server.tool(
  "get_top_holders",
  "List the accounts with the largest current token balances.",
  { tokenAddress: tokenAddressArg, limit: z.number().int().min(1).max(100).default(10) },
  async ({ tokenAddress, limit }) => {
    const where = tokenWhere(tokenAddress);
    const data = await queryGraph(`{
      accounts(first: ${limit}, orderBy: balance, orderDirection: desc${where}) {
        token { id symbol }
        address
        balance
        sentCount
        receivedCount
      }
    }`);
    return textResult(data.accounts);
  }
);

server.tool(
  "get_recent_transfers",
  "List the most recent token transfers, newest first.",
  { tokenAddress: tokenAddressArg, limit: z.number().int().min(1).max(100).default(20) },
  async ({ tokenAddress, limit }) => {
    const where = tokenWhere(tokenAddress);
    const data = await queryGraph(`{
      transfers(first: ${limit}, orderBy: blockTimestamp, orderDirection: desc${where}) {
        id
        token { id symbol }
        from { address }
        to { address }
        value
        isMintOrBurn
        blockTimestamp
        transactionHash
      }
    }`);
    return textResult(data.transfers);
  }
);

server.tool(
  "get_account_balance",
  "Get a specific account's current indexed token balance(s).",
  {
    address: z.string().describe("Account address (0x...)"),
    tokenAddress: tokenAddressArg,
  },
  async ({ address, tokenAddress }) => {
    const where = tokenWhere(tokenAddress, `address: "${address.toLowerCase()}"`);
    const data = await queryGraph(`{
      accounts(first: 100${where}) {
        token { id symbol }
        address
        balance
        sentCount
        receivedCount
      }
    }`);
    return textResult(data.accounts);
  }
);

server.tool(
  "get_latest_sepolia_block",
  "Get the latest block number on Ethereum Sepolia by calling a public JSON-RPC endpoint " +
    "(no subgraph indexing involved -- this is live chain state).",
  {},
  async () => {
    const res = await fetch(SEPOLIA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    if (!res.ok) {
      throw new Error(`RPC HTTP error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error) {
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    }
    const blockNumber = parseInt(json.result as string, 16);
    return textResult({ blockNumber, hex: json.result, rpcUrl: SEPOLIA_RPC_URL });
  }
);

server.tool(
  "get_tracked_tokens",
  "List the ERC20 tokens this subgraph is currently configured to index (from subgraph.yaml). " +
    "This is LOCAL config, not proof it's live -- use get_deployment_status to confirm Graph " +
    "Studio is actually serving this exact set. Adding/removing tracked tokens requires the " +
    "write server.",
  {},
  async () => {
    const tokens = readTrackedTokens().map((ds) => ({
      name: ds.name,
      address: ds.source.address,
      startBlock: ds.source.startBlock,
    }));
    return textResult(tokens);
  }
);

server.tool(
  "get_deployment_status",
  "Check whether Graph Studio is actually live-serving the locally-configured token set (as opposed " +
    "to just trusting that the last deploy succeeded). Reports the locally-configured tokens " +
    "alongside the live deployment's indexing status (current block, any indexing errors). Useful " +
    "any time query results look wrong/stale/empty.",
  {},
  async () => {
    const trackedTokens = readTrackedTokens().map((ds) => ({
      name: ds.name,
      address: ds.source.address,
      startBlock: ds.source.startBlock,
    }));
    const meta = await queryDeploymentMeta();
    return textResult({
      trackedTokens,
      live: meta,
      note:
        "'live.block.number' is how far indexing has progressed -- a token just added can take a " +
        "while to catch up from its startBlock before query tools return its data. " +
        "'live.hasIndexingErrors: true' means something is broken server-side and needs attention.",
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
