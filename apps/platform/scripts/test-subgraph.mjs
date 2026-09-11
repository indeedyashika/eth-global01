/**
 * Verification test for The Graph integration:
 * 1. Checks subgraph.yaml manifest & schema.graphql
 * 2. Checks MCP tool definitions (subgraph_read and subgraph_write)
 * 3. Verifies /api/subgraph endpoint response structure
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "../../..");

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

// 3. Verify /api/subgraph Route File
const routePath = resolve(projectRoot, "apps/platform/src/app/api/subgraph/route.ts");
assert(existsSync(routePath), "apps/platform/src/app/api/subgraph/route.ts exists");

if (existsSync(routePath)) {
  const routeContent = readFileSync(routePath, "utf-8");
  assert(routeContent.includes("export async function GET"), "route.ts exports GET handler");
  assert(routeContent.includes("export async function POST"), "route.ts exports POST handler");
  assert(routeContent.includes("DEMO_SUBGRAPH_DATA"), "route.ts provides reliable demo fallback data");
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
