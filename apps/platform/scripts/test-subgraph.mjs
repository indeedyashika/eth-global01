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

    // Test GET /api/subgraph behavior (unconfigured fail-closed)
    const getRes = await GET();
    assert(getRes.status === 200, "GET /api/subgraph returns HTTP 200 status check");
    const getData = await getRes.json();
    assert(getData.status === "unconfigured" || getData.status === "ok", "GET response status is valid");
    assert(
      getData.mode === "unconfigured" || getData.mode === "live-studio",
      "GET mode indicates live-studio or unconfigured (no demo mode)"
    );
    assert(
      Array.isArray(getData.schemaEntities) &&
        ["Token", "Account", "Transfer"].every((entity) => getData.schemaEntities.includes(entity)),
      "GET response schemaEntities includes Token, Account, and Transfer"
    );
    assert(
      typeof getData.isLive === "boolean",
      "GET response includes valid isLive boolean state"
    );
    assert(
      getData.data === undefined,
      "route.ts does NOT provide fabricated demo fallback tokens/holders"
    );

    // Test POST /api/subgraph behavior when unconfigured: must fail-closed with 503 SUBGRAPH_UNCONFIGURED
    const postHoldersReq = new Request("http://localhost/api/subgraph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "top_holders" }),
    });
    const postHoldersRes = await POST(postHoldersReq);
    assert(postHoldersRes.status === 503, "POST top_holders fails closed with HTTP 503 when unconfigured");
    const postHoldersData = await postHoldersRes.json();
    assert(
      postHoldersData.code === "SUBGRAPH_UNCONFIGURED",
      "POST top_holders returns SUBGRAPH_UNCONFIGURED error code"
    );

    // Test POST /api/subgraph behavior for GraphQL queries: must fail-closed with 503 SUBGRAPH_UNCONFIGURED
    const postQueryReq = new Request("http://localhost/api/subgraph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ tokens { id symbol } }" }),
    });
    const postQueryRes = await POST(postQueryReq);
    assert(postQueryRes.status === 503, "POST GraphQL query fails closed with HTTP 503 when unconfigured");
    const postQueryData = await postQueryRes.json();
    assert(
      postQueryData.code === "SUBGRAPH_UNCONFIGURED",
      "POST GraphQL query returns SUBGRAPH_UNCONFIGURED error code"
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
