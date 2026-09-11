import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";

if (!process.env.__TSX_RUNNING__) {
  const result = spawnSync("npx", ["tsx", path.resolve("scripts/test-contract-deployment-config.mjs")], {
    stdio: "inherit", shell: true, env: { ...process.env, __TSX_RUNNING__: "1" },
  });
  process.exit(result.status ?? 1);
}

const { contractDeploymentStatus, requireLiveContractDeployments } = await import("../src/lib/evm/contracts.ts");
delete process.env.PROPERTY_REGISTRY_ADDRESS;
delete process.env.YIELD_VAULT_ADDRESS;
process.env.PRISM_CONTRACT_MODE = "LIVE";
assert.throws(requireLiveContractDeployments, /PropertyRegistry.*YieldVault/);
assert(contractDeploymentStatus().every((item) => item.state === "COMPILED_ONLY" && item.address === null));
process.env.PRISM_CONTRACT_MODE = "SIMULATED";
assert(contractDeploymentStatus().every((item) => item.state === "SIMULATED" && item.address === null));
console.log("Contract deployment configuration tests passed.");
