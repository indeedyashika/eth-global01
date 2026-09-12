import { getAddress, isAddress } from "ethers";

export type ContractDeploymentState = "DEPLOYED" | "CONFIGURED" | "COMPILED_ONLY";

type ContractConfig = { name: "PropertyRegistry" | "YieldVault"; env: string };
const CONTRACTS: ContractConfig[] = [
  { name: "PropertyRegistry", env: "PROPERTY_REGISTRY_ADDRESS" },
  { name: "YieldVault", env: "YIELD_VAULT_ADDRESS" },
];

function configuredAddress(env: string): string | null {
  const value = process.env[env]?.trim();
  if (!value || !isAddress(value)) return null;
  return getAddress(value);
}

/** Compilation artifacts are not deployments. An address is only exposed when
 * explicitly configured for the currently supported Sepolia network. */
export function contractDeploymentStatus() {
  const mode = (process.env.PRISM_CONTRACT_MODE ?? "LIVE").toUpperCase();
  return CONTRACTS.map(({ name, env }) => {
    const address = configuredAddress(env);
    const state: ContractDeploymentState = address
      ? mode === "LIVE" ? "DEPLOYED" : "CONFIGURED"
      : "COMPILED_ONLY";
    return { name, network: "sepolia", state, address };
  });
}

export function requireLiveContractDeployments(): void {
  const missing = contractDeploymentStatus().filter((item) => !item.address).map((item) => item.name);
  if (missing.length) {
    throw new Error(`LIVE contract mode requires configured Sepolia addresses for: ${missing.join(", ")}.`);
  }
}
