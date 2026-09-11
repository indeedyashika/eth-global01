#!/usr/bin/env node
// Appends a new ethereum dataSource to subgraph.yaml, cloned from the first
// existing dataSource (same abi/mapping/handler), so one subgraph can track
// several ERC20 contracts. Run codegen/build/deploy afterward to pick it up.
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

const { address, "start-block": startBlockArg, name } = parseArgs(process.argv.slice(2));

if (!address || !startBlockArg) {
  console.error("Usage: node scripts/add-source.mjs --address 0x... --start-block 12345 [--name MyToken]");
  process.exit(1);
}

const startBlock = Number(startBlockArg);
if (!Number.isInteger(startBlock) || startBlock < 0) {
  console.error(`Invalid --start-block: ${startBlockArg}`);
  process.exit(1);
}

const manifest = yaml.load(readFileSync(manifestPath, "utf8"));

const existing = manifest.dataSources.find(
  (ds) => ds.source.address.toLowerCase() === address.toLowerCase()
);
if (existing) {
  console.error(`Address ${address} is already tracked as dataSource "${existing.name}". Nothing to do.`);
  process.exit(1);
}

const template = manifest.dataSources[0];
const newSourceName = name || `ERC20Token${manifest.dataSources.length + 1}`;

const newDataSource = {
  ...template,
  name: newSourceName,
  source: {
    ...template.source,
    address,
    startBlock,
  },
};

manifest.dataSources.push(newDataSource);

writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));

console.log(`Added dataSource "${newSourceName}" for ${address} (startBlock ${startBlock}).`);
console.log("Now run: npm run codegen && npm run build && npm run deploy");
