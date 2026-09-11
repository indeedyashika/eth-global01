// Shared plumbing for the split subgraph MCP servers (read.ts / write.ts).
//
// Holds only the GraphQL query client and the subgraph.yaml reader — both servers need
// these to answer questions about tracked tokens. Nothing here can mutate subgraph.yaml
// or trigger a deploy; that lives entirely in write.ts, which is the only file that
// imports node:child_process.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
// Overridable so a deployment can point this at a writable, volume-backed
// copy of the subgraph (code ships in the image; the manifest needs to
// persist across redeploys). Defaults to the sibling checkout for local/dev
// use.
export const SUBGRAPH_DIR = process.env.SUBGRAPH_DIR
  ? path.resolve(process.env.SUBGRAPH_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../subgraph");
export const MANIFEST_PATH = path.join(SUBGRAPH_DIR, "subgraph.yaml");

// MUST be the "/version/latest" query URL (Studio Details tab shows a
// version-pinned one by default, e.g. ".../sepolia-test/auto-1785...") --
// swap the trailing version label for the literal path segment
// "version/latest" and Studio always resolves it to whatever was deployed
// most recently, so this env var stays correct across every redeploy
// without anything needing to track/update it.
export const SUBGRAPH_URL = process.env.SUBGRAPH_URL;

export async function queryGraph(query: string, variables?: Record<string, unknown>) {
  if (!SUBGRAPH_URL) {
    throw new Error(
      "SUBGRAPH_URL is not set. Deploy the subgraph in ../subgraph to Graph Studio (e.g. via the " +
        "set_token_sources tool), then set SUBGRAPH_URL to its query endpoint using the " +
        "'version/latest' path segment (not the version-pinned URL Studio's 'Details' tab shows), " +
        "e.g. https://api.studio.thegraph.com/query/<id>/<name>/version/latest -- that way it keeps " +
        "resolving to whatever was deployed most recently."
    );
  }
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Subgraph HTTP error ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors) {
    throw new Error(`Subgraph query error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as Record<string, unknown>;
}

export interface DataSource {
  name: string;
  source: { address: string; startBlock: number };
}

export function readTrackedTokens(): DataSource[] {
  const manifest = yaml.load(readFileSync(MANIFEST_PATH, "utf8")) as { dataSources: DataSource[] };
  return manifest.dataSources;
}

export interface DeploymentMeta {
  deployment: string;
  block: { number: string } | null;
  hasIndexingErrors: boolean;
}

// Every subgraph exposes this field automatically (no schema changes needed).
// `deployment` is the IPFS hash of the manifest currently being served --
// the same hash `graph deploy` prints as "Build completed: Qm...". Comparing
// the two is how we verify the locally-configured token set (subgraph.yaml)
// actually matches what Graph Studio is live-serving at SUBGRAPH_URL, rather
// than just assuming the last deploy step succeeded.
export async function queryDeploymentMeta(): Promise<DeploymentMeta> {
  const data = await queryGraph(`{ _meta { deployment block { number } hasIndexingErrors } }`);
  return data._meta as DeploymentMeta;
}

export function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function tokenWhere(tokenAddress: string | undefined, extra?: string): string {
  const clauses = [
    ...(tokenAddress ? [`token: "${tokenAddress.toLowerCase()}"`] : []),
    ...(extra ? [extra] : []),
  ];
  return clauses.length ? `, where: { ${clauses.join(", ")} }` : "";
}

export const tokenAddressArg = z
  .string()
  .optional()
  .describe("Restrict to one tracked token's contract address (0x...). Omit to query across all tracked tokens.");
