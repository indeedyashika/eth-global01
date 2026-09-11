#!/usr/bin/env node
// Rewrites subgraph.yaml's dataSources to exactly the given array of tokens,
// so an agent can add AND remove tracked tokens in one call (unlike
// add-source.mjs, which only ever appends). Run codegen/build/deploy
// afterward to pick it up.
//
// The first dataSource's name is load-bearing: src/mapping.ts imports from
// "../generated/ERC20Token/ERC20", i.e. the codegen output directory for
// whichever dataSource is named "ERC20Token". We therefore always force the
// first entry in the resulting list to that name, regardless of what name
// (if any) the caller supplied for it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const subgraphDir = path.resolve(fileURLToPath(import.meta.url), "../..");
const manifestPath = path.join(subgraphDir, "subgraph.yaml");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key) continue;
    args[key] = argv[i + 1];
  }
  return args;
}

const { tokens: tokensArg } = parseArgs(process.argv.slice(2));

if (!tokensArg) {
  console.error(
    'Usage: node scripts/set-sources.mjs --tokens \'[{"address":"0x...","startBlock":12345,"name":"Optional"}]\''
  );
  process.exit(1);
}

let tokens;
try {
  tokens = JSON.parse(tokensArg);
} catch (err) {
  console.error(`--tokens is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(tokens) || tokens.length === 0) {
  console.error("--tokens must be a non-empty JSON array.");
  process.exit(1);
}

const seen = new Set();
for (const t of tokens) {
  if (!t || typeof t.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t.address)) {
    console.error(`Invalid or missing address: ${JSON.stringify(t)}`);
    process.exit(1);
  }
  if (!Number.isInteger(t.startBlock) || t.startBlock < 0) {
    console.error(`Invalid or missing startBlock for ${t.address}: ${JSON.stringify(t)}`);
    process.exit(1);
  }
  const key = t.address.toLowerCase();
  if (seen.has(key)) {
    console.error(`Duplicate address in --tokens: ${t.address}`);
    process.exit(1);
  }
  seen.add(key);
}

const manifest = yaml.load(readFileSync(manifestPath, "utf8"));
const template = manifest.dataSources[0];

manifest.dataSources = tokens.map((t, i) => ({
  ...template,
  // First dataSource MUST be named ERC20Token -- see file header comment.
  // Any caller-supplied name for entry 0 is ignored to protect codegen.
  name: i === 0 ? "ERC20Token" : t.name || `ERC20Token${i + 1}`,
  source: {
    ...template.source,
    address: t.address,
    startBlock: t.startBlock,
  },
}));

writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));

console.log(
  `Set ${tokens.length} dataSource(s): ${manifest.dataSources.map((d) => `${d.name}=${d.source.address}`).join(", ")}`
);
console.log("Now run: npm run codegen && npm run build && npm run deploy");
