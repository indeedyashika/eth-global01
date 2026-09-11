import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress } from "ethers";
import artifact from "./generated/CompliantRwaToken.json";
import { SEPOLIA_CHAIN_ID, transactionExplorerUrl } from "@/lib/chains";
import type { ComplianceOptions, TokenRecord } from "@/types";

let providerSingleton: JsonRpcProvider | null = null;
let signerSingleton: Wallet | null = null;

export function getSepoliaProvider(): JsonRpcProvider {
  const rpcUrl = process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com";
  if (!providerSingleton) providerSingleton = new JsonRpcProvider(rpcUrl, SEPOLIA_CHAIN_ID);
  return providerSingleton;
}

export function getEvmOperator(): Wallet {
  const privateKey = process.env.EVM_OPERATOR_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("EVM_OPERATOR_PRIVATE_KEY is not configured.");
  if (!signerSingleton) signerSingleton = new Wallet(privateKey, getSepoliaProvider());
  return signerSingleton;
}

export function getEvmOperatorAddress(): string {
  return getAddress(getEvmOperator().address);
}

async function assertSepolia(): Promise<void> {
  const network = await getSepoliaProvider().getNetwork();
  if (network.chainId !== BigInt(SEPOLIA_CHAIN_ID)) {
    throw new Error(`The configured EVM RPC is chain ${network.chainId}; Sepolia ${SEPOLIA_CHAIN_ID} is required.`);
  }
}

function contract(address: string): Contract {
  return new Contract(getAddress(address), artifact.abi, getEvmOperator());
}

function readContract(address: string): Contract {
  return new Contract(getAddress(address), artifact.abi, getSepoliaProvider());
}

async function submit(txPromise: Promise<{ hash: string; wait: () => Promise<unknown> }>) {
  await assertSepolia();
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`No Sepolia receipt was returned for ${tx.hash}.`);
  return {
    txId: tx.hash,
    hashscanUrl: `https://sepolia.etherscan.io/tx/${tx.hash}`,
    explorerUrl: `https://sepolia.etherscan.io/tx/${tx.hash}`,
  };
}

export async function deployEvmToken(input: {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: number;
  supplyType: "FINITE" | "INFINITE";
  maxSupply?: number;
  compliance: ComplianceOptions;
}) {
  await assertSepolia();
  const operator = getEvmOperator();
  const gateEnabled =
    input.compliance.kycRequired ||
    input.compliance.freezeDefault ||
    input.compliance.worldIdRequired;
  const maxSupply = input.supplyType === "FINITE" ? BigInt(input.maxSupply ?? 0) : BigInt(0);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, operator);
  const deployed = await factory.deploy(
    input.name,
    input.symbol,
    input.decimals,
    BigInt(input.initialSupply),
    maxSupply,
    gateEnabled,
    input.compliance.freezeDefault,
    input.compliance.pauseEnabled,
    input.compliance.wipeEnabled,
    operator.address,
  );
  const deploymentTx = deployed.deploymentTransaction();
  if (!deploymentTx) throw new Error("Sepolia deployment transaction was not created.");
  await deployed.waitForDeployment();
  const tokenId = getAddress(await deployed.getAddress());
  return {
    tokenId,
    txId: deploymentTx.hash,
    hashscanUrl: `https://sepolia.etherscan.io/tx/${deploymentTx.hash}`,
    explorerUrl: `https://sepolia.etherscan.io/tx/${deploymentTx.hash}`,
    keys: {
      admin: true,
      kyc: gateEnabled,
      freeze: input.compliance.freezeDefault,
      wipe: input.compliance.wipeEnabled,
      pause: input.compliance.pauseEnabled,
      supply: true,
      feeSchedule: false,
    },
  };
}

export function setEvmApproved(tokenId: string, account: string, approved: boolean) {
  return submit(contract(tokenId).setApproved(getAddress(account), approved));
}

export function setEvmFrozen(tokenId: string, account: string, frozen: boolean) {
  return submit(contract(tokenId).setFrozen(getAddress(account), frozen));
}

export function pauseEvmToken(tokenId: string, paused: boolean) {
  return submit(paused ? contract(tokenId).pause() : contract(tokenId).unpause());
}

export function mintEvmToken(tokenId: string, amount: bigint) {
  return submit(contract(tokenId).mint(getEvmOperatorAddress(), amount));
}

export function transferEvmFromTreasury(tokenId: string, account: string, amount: bigint | number) {
  return submit(contract(tokenId).transfer(getAddress(account), BigInt(amount)));
}

export async function getEvmTokenBalance(tokenId: string, account: string): Promise<bigint> {
  await assertSepolia();
  return BigInt(await readContract(tokenId).balanceOf(getAddress(account)));
}

export async function getEvmAllowance(tokenId: string, owner: string): Promise<bigint> {
  await assertSepolia();
  return BigInt(await readContract(tokenId).allowance(getAddress(owner), getEvmOperatorAddress()));
}

export async function reclaimEvmViaAllowance(tokenId: string, account: string) {
  const owner = getAddress(account);
  const amount = await getEvmTokenBalance(tokenId, owner);
  if (amount === BigInt(0)) return { amount: "0", txId: null, hashscanUrl: null, explorerUrl: null };
  const allowance = await getEvmAllowance(tokenId, owner);
  if (allowance < amount) throw new Error("The holder's ERC-20 allowance is lower than their live balance.");
  const result = await submit(
    contract(tokenId).transferFrom(owner, getEvmOperatorAddress(), amount),
  );
  return { ...result, amount: amount.toString() };
}

export async function recoverEvmBalance(tokenId: string, account: string) {
  const owner = getAddress(account);
  const amount = await getEvmTokenBalance(tokenId, owner);
  if (amount === BigInt(0)) return { amount: "0", txId: null, hashscanUrl: null, explorerUrl: null };
  const result = await submit(contract(tokenId).recover(owner, amount));
  return { ...result, amount: amount.toString() };
}

export function evmTransactionUrl(token: TokenRecord, txId: string): string {
  return transactionExplorerUrl(token, txId);
}
