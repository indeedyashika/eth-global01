/**
 * Verification test for The Graph integration:
 * 1. Checks subgraph.yaml manifest & schema.graphql
 * 2. Checks MCP tool definitions (subgraph_read and subgraph_write)
 * 3. Verifies /api/subgraph endpoint response structure & runtime behavior
 * 4. Checks TheGraphInspectorModal component
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "../../..");
const platformRoot = resolve(projectRoot, "apps/platform");

// Execute via tsx if not already running under tsx
const isRunningUnderTsx = Boolean(process.env.__TSX_RUNNING__ || process.execArgv.some((a) => a.includes("tsx")));
if (!isRunningUnderTsx) {
  const result = spawnSync("npx", ["tsx", "scripts/test-subgraph.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

console.log("=================================================");
console.log("   LiquidityStream The Graph Verification Test   ");
console.log("=================================================\n");

let passed = 0;
let total = 0;

function assert(condition, name) {
  total++;
  if (condition) {
    console.log(`✓ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`✗ [FAIL] ${name}`);
  }
}

// 1. Verify Subgraph Manifest & Schema
const subgraphYamlPath = resolve(projectRoot, "apps/agent/mcps/subgraph/subgraph/subgraph.yaml");
const schemaGraphqlPath = resolve(projectRoot, "apps/agent/mcps/subgraph/subgraph/schema.graphql");

assert(existsSync(subgraphYamlPath), "subgraph.yaml exists");
assert(existsSync(schemaGraphqlPath), "schema.graphql exists");

if (existsSync(schemaGraphqlPath)) {
  const schemaContent = readFileSync(schemaGraphqlPath, "utf-8");
  assert(schemaContent.includes("type Token @entity"), "schema defines Token entity");
  assert(schemaContent.includes("type Account @entity"), "schema defines Account entity");
  assert(schemaContent.includes("type Transfer @entity"), "schema defines Transfer entity");
}

// 2. Verify MCP Server Tools
const readMcpPath = resolve(projectRoot, "apps/agent/mcps/subgraph/mcp-server/src/read.ts");
const writeMcpPath = resolve(projectRoot, "apps/agent/mcps/subgraph/mcp-server/src/write.ts");

assert(existsSync(readMcpPath), "subgraph_read MCP server exists");
assert(existsSync(writeMcpPath), "subgraph_write MCP server exists");

if (existsSync(readMcpPath)) {
  const readContent = readFileSync(readMcpPath, "utf-8");
  assert(readContent.includes("get_top_holders"), "subgraph_read exposes get_top_holders");
  assert(readContent.includes("get_token_info"), "subgraph_read exposes get_token_info");
  assert(readContent.includes("get_recent_transfers"), "subgraph_read exposes get_recent_transfers");
  assert(readContent.includes("get_deployment_status"), "subgraph_read exposes get_deployment_status");
}

if (existsSync(writeMcpPath)) {
  const writeContent = readFileSync(writeMcpPath, "utf-8");
  assert(writeContent.includes("add_token_source"), "subgraph_write exposes add_token_source");
  assert(writeContent.includes("set_token_sources"), "subgraph_write exposes set_token_sources");
}

// 3. Verify /api/subgraph Route & Actual Runtime API Behavior
const routePath = resolve(projectRoot, "apps/platform/src/app/api/subgraph/route.ts");
assert(existsSync(routePath), "apps/platform/src/app/api/subgraph/route.ts exists");

if (existsSync(routePath)) {
  try {
    const { GET, POST } = await import(pathToFileURL(routePath).href);
    assert(typeof GET === "function", "route.ts exports callable GET handler");
    assert(typeof POST === "function", "route.ts exports callable POST handler");

    // Test GET /api/subgraph behavior
    const getRes = await GET();
    assert(getRes.status === 200, "GET /api/subgraph returns HTTP 200");
    const getData = await getRes.json();
    assert(getData.status === "ok", "GET response status is 'ok'");
    assert(
      getData.mode === "demonstration-mode" || getData.mode === "live-studio",
      "GET mode indicates live-studio or demonstration-mode"
    );
    assert(
      Array.isArray(getData.schemaEntities) &&
        ["Token", "Account", "Transfer"].every((entity) => getData.schemaEntities.includes(entity)),
      "GET response schemaEntities includes Token, Account, and Transfer"
    );
    assert(
      getData.meta && typeof getData.meta.network === "string" && typeof getData.meta.block?.number === "number",
      "GET response includes valid indexing metadata"
    );
    assert(
      Array.isArray(getData.data?.tokens) && getData.data.tokens.length > 0,
      "route.ts provides reliable demo fallback tokens"
    );
    assert(
      Array.isArray(getData.data?.holders) && getData.data.holders.length > 0,
      "route.ts provides reliable demo fallback holders"
    );
    assert(
      Array.isArray(getData.data?.recentTransfers) && getData.data.recentTransfers.length > 0,
      "route.ts provides reliable demo fallback transfers"
    );

    // Test POST /api/subgraph behavior for top_holders action
    const postHoldersReq = new Request("http://localhost/api/subgraph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "top_holders" }),
    });
    const postHoldersRes = await POST(postHoldersReq);
    assert(postHoldersRes.status === 200, "POST top_holders returns HTTP 200");
    const postHoldersData = await postHoldersRes.json();
    assert(
      Array.isArray(postHoldersData.data?.accounts) && postHoldersData.data.accounts.length > 0,
      "POST top_holders returns account allocations"
    );

    // Test POST /api/subgraph behavior for GraphQL queries
    const postQueryReq = new Request("http://localhost/api/subgraph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ tokens { id symbol } }" }),
    });
    const postQueryRes = await POST(postQueryReq);
    assert(postQueryRes.status === 200, "POST GraphQL query returns HTTP 200");
    const postQueryData = await postQueryRes.json();
    assert(
      Boolean(postQueryData.data?.tokens && postQueryData.data?.accounts),
      "POST GraphQL query returns structured entity data"
    );
  } catch (err) {
    assert(false, `API behavior validation failed: ${err.message}`);
  }
}

// 4. Verify TheGraphInspectorModal Component
const modalPath = resolve(projectRoot, "apps/platform/src/components/TheGraphInspectorModal.tsx");
assert(existsSync(modalPath), "TheGraphInspectorModal.tsx exists");

console.log(`\nResults: ${passed}/${total} assertions passed.`);
if (passed === total) {
  console.log("✓ ALL THE GRAPH VERIFICATION TESTS PASSED!\n");
  process.exit(0);
} else {
  console.error("✗ Some tests failed.\n");
  process.exit(1);
}
