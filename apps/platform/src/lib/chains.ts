import type { Blockchain, TokenNetwork, TokenRecord } from "@/types";

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

export function configuredHederaNetwork(): "mainnet" | "testnet" | "previewnet" {
  const value = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase();
  return value === "mainnet" || value === "previewnet" ? value : "testnet";
}

export function tokenExplorerUrl(
  blockchain: Blockchain,
  network: TokenNetwork,
  identifier: string
): string {
  if (blockchain === "EVM") {
    const origin = network === "sepolia" ? "https://sepolia.etherscan.io" : "https://etherscan.io";
    return `${origin}/token/${identifier}`;
  }
  return `https://hashscan.io/${network}/token/${identifier}`;
}

export function transactionExplorerUrl(token: Pick<TokenRecord, "blockchain" | "network">, txId: string): string {
  if (token.blockchain === "EVM") {
    const origin = token.network === "sepolia" ? "https://sepolia.etherscan.io" : "https://etherscan.io";
    return `${origin}/tx/${txId}`;
  }
  return `https://hashscan.io/${token.network}/transaction/${encodeURIComponent(txId)}`;
}

export function worldIdHolderSignal(
  token: Pick<TokenRecord, "id" | "blockchain" | "network">,
  accountId: string
): string {
  // Never change the legacy Hedera format: existing World proofs were bound to it.
  if (token.blockchain === "HEDERA") return `hedera:${token.id}:holder:${accountId}`;
  return `eip155:${SEPOLIA_CHAIN_ID}:${token.id.toLowerCase()}:holder:${accountId.toLowerCase()}`;
}
