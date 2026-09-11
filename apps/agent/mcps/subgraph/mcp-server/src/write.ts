#!/usr/bin/env node
// Write (state-mutating) subgraph MCP server.
//
// The only place that can edit subgraph.yaml and trigger a `graph deploy` -- i.e.
// change which ERC20 contracts are indexed. This does NOT touch chain state or the
// treasury, but it does need GRAPH_DEPLOY_KEY, so it's kept separate from read.ts and
// must never be registered for a public/read-only agent profile (see
// apps/agent/server.py:write_config_yaml's `pr` profile, which registers subgraph_read
// only).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SUBGRAPH_DIR, type DeploymentMeta, queryDeploymentMeta } from "./common.js";

const execFileAsync = promisify(execFile);

const tokenAddressPattern = /^0x[0-9a-fA-F]{40}$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A successful `graph deploy` CLI exit means Studio accepted the deploy, not
// that api.studio.thegraph.com is already serving it -- there's a brief
// (empirically ~1-3s) propagation window right after. A single immediate
// _meta check can catch that window and report a false "not live yet" for a
// deploy that's actually fine, so retry with backoff instead of checking
// once. Total worst-case wait if it never matches: ~10s.
async function waitForLiveDeployment(
  publishedHash: string,
  { attempts = 5, delayMs = 2000 } = {}
): Promise<{ matched: boolean; meta?: DeploymentMeta; lastError?: string }> {
  let lastMeta: DeploymentMeta | undefined;
  let lastError: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      lastMeta = await queryDeploymentMeta();
      if (lastMeta.deployment === publishedHash) return { matched: true, meta: lastMeta };
    } catch (err) {
      // SUBGRAPH_URL can be transiently unreachable right after a deploy too -- keep retrying.
      lastError = (err as Error).message;
    }
  }
  return { matched: false, meta: lastMeta, lastError };
}

// Shared by every tool that mutates subgraph.yaml and redeploys: runs a list
// of npm-script steps in the subgraph dir and collects their combined output
// for the tool result (read by an LLM agent, not a human -- see deploy.mjs
// for why we redact the version-pinned URL out of its stdout). A successful
// CLI exit only means the deploy *request* succeeded, not that Studio is
// actually serving it yet -- so we follow up with a retried _meta check
// against SUBGRAPH_URL and report whether the new deployment hash is
// confirmed live, rather than just assuming it.
async function runDeployPipeline(steps: Array<{ label: string; cmd: string; args: string[] }>) {
  const log: string[] = [];
  let deployStdout = "";
  for (const { label, cmd, args } of steps) {
    log.push(`$ ${label}`);
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: SUBGRAPH_DIR,
        maxBuffer: 1024 * 1024 * 20,
      });
      log.push(stdout.trim(), stderr.trim());
      if (label === "npm run deploy") deployStdout = stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      log.push(e.stdout?.trim() ?? "", e.stderr?.trim() ?? "", `FAILED: ${e.message}`);
      throw new Error(log.filter(Boolean).join("\n"));
    }
  }
  log.push(
    "Deploy request succeeded. No SUBGRAPH_URL / MCP config change is needed -- it should already " +
      "point at the stable '.../version/latest' Studio URL. Do not tell the user to update SUBGRAPH_URL."
  );

  const publishedHash = deployStdout.match(/Build completed:\s*(\S+)/)?.[1];
  if (publishedHash) {
    const { matched, meta, lastError } = await waitForLiveDeployment(publishedHash);
    if (matched && meta) {
      log.push(
        `Confirmed live: Graph Studio is now serving this exact deploy (block ${meta.block?.number}, ` +
          `hasIndexingErrors: ${meta.hasIndexingErrors}).`
      );
    } else if (meta) {
      log.push(
        `NOT YET LIVE after retrying: Studio is still serving a previous deployment (${meta.deployment}), ` +
          `not this one (${publishedHash}). Propagation is usually done within a few seconds, so this is ` +
          "unusual -- call get_deployment_status again in a bit to confirm before relying on query results."
      );
    } else {
      log.push(
        `Could not verify live status (${lastError}). Call get_deployment_status once SUBGRAPH_URL is ` +
          "confirmed reachable."
      );
    }
  }

  return log.filter(Boolean).join("\n");
}

const server = new McpServer({ name: "graph-experiments-write", version: "0.1.0" });

server.tool(
  "add_token_source",
  "Add a new ERC20 contract to this subgraph and redeploy to Graph Studio, so it monitors " +
    "another token alongside whatever it already tracks, without disturbing the rest of the set. " +
    "For removing tokens, or replacing the whole tracked set in one step, use set_token_sources " +
    "instead. Requires GRAPH_DEPLOY_KEY in the environment (or subgraph/.env for local use). Runs " +
    "codegen, build, and deploy -- can take up to a minute; wait for it to finish before retrying.",
  {
    address: z.string().regex(tokenAddressPattern).describe("ERC20 contract address to start tracking (0x...)"),
    startBlock: z.number().int().min(0).describe("Block number to start indexing from (deployment/mint block)"),
    name: z
      .string()
      .optional()
      .describe("Optional dataSource name (defaults to ERC20Token<n>)"),
  },
  async ({ address, startBlock, name }) => {
    const addArgs = ["run", "add-source", "--", "--address", address, "--start-block", String(startBlock)];
    if (name) addArgs.push("--name", name);

    const text = await runDeployPipeline([
      { label: "npm run add-source", cmd: "npm", args: addArgs },
      { label: "npm run codegen", cmd: "npm", args: ["run", "codegen"] },
      { label: "npm run build", cmd: "npm", args: ["run", "build"] },
      { label: "npm run deploy", cmd: "npm", args: ["run", "deploy"] },
    ]);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "set_token_sources",
  "Replace the ENTIRE set of ERC20 tokens this subgraph tracks with exactly the given list, then " +
    "redeploy to Graph Studio -- the way to both add and remove tokens in one call (any tracked " +
    "token not included is dropped). Call get_tracked_tokens (on the read server) first if you need " +
    "to know the current set before editing it. Requires GRAPH_DEPLOY_KEY in the environment (or " +
    "subgraph/.env for local use). Runs codegen, build, and deploy -- can take up to a minute; wait " +
    "for it to finish before retrying, and note freshly-added tokens need time to sync before query " +
    "tools return their data.",
  {
    tokens: z
      .array(
        z.object({
          address: z.string().regex(tokenAddressPattern).describe("ERC20 contract address (0x...)"),
          startBlock: z.number().int().min(0).describe("Block number to start indexing from"),
          name: z
            .string()
            .optional()
            .describe("Optional dataSource name (ignored for the first token, which is always named ERC20Token)"),
        })
      )
      .min(1)
      .describe("The full desired set of tracked tokens -- anything omitted is removed."),
  },
  async ({ tokens }) => {
    const text = await runDeployPipeline([
      {
        label: "npm run set-sources",
        cmd: "npm",
        args: ["run", "set-sources", "--", "--tokens", JSON.stringify(tokens)],
      },
      { label: "npm run codegen", cmd: "npm", args: ["run", "codegen"] },
      { label: "npm run build", cmd: "npm", args: ["run", "build"] },
      { label: "npm run deploy", cmd: "npm", args: ["run", "deploy"] },
    ]);
    return { content: [{ type: "text" as const, text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
