import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const platformRoot = fs.existsSync(path.join(process.cwd(), "public"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "platform");

if (!process.env.__TSX_RUNNING__) {
  const result = spawnSync("npx", ["tsx", "scripts/test-contract-deployment-config.mjs"], {
    cwd: platformRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

const { contractDeploymentStatus, requireLiveContractDeployments } = await import("../src/lib/evm/contracts.ts");
delete process.env.PROPERTY_REGISTRY_ADDRESS;
delete process.env.YIELD_VAULT_ADDRESS;
process.env.PRISM_CONTRACT_MODE = "LIVE";
assert.throws(requireLiveContractDeployments, /PropertyRegistry.*YieldVault/);
assert(contractDeploymentStatus().every((item) => item.state === "COMPILED_ONLY" && item.address === null));
console.log("Contract deployment configuration tests passed.");
