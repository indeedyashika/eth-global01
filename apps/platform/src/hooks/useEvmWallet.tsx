"use client";

import { BrowserProvider, Contract, getAddress } from "ethers";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import artifact from "@/lib/evm/generated/CompliantRwaToken.json";
import { SEPOLIA_CHAIN_ID_HEX } from "@/lib/chains";
import { getMetaMaskProvider } from "@/lib/evm/browserProvider";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

interface EvmWalletContextValue {
  accountId: string | null;
  connecting: boolean;
  error: string | null;
  connect: (walletType?: any) => Promise<void>;
  disconnect: () => void;
  approveAllowance: (tokenId: string, spender: string, amount: number) => Promise<string>;
}

const EvmWalletContext = createContext<EvmWalletContextValue | null>(null);

async function switchToSepolia(ethereum: EthereumProvider): Promise<void> {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) throw error;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: SEPOLIA_CHAIN_ID_HEX,
        chainName: "Sepolia",
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
        blockExplorerUrls: ["https://sepolia.etherscan.io"],
      }],
    });
  }
}

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ethereum = getMetaMaskProvider() as EthereumProvider | undefined;
    if (!ethereum) return;
    const sync = (accounts: unknown) => {
      const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      setAccountId(first ? getAddress(first) : null);
    };
    ethereum.request({ method: "eth_accounts" }).then(sync).catch(() => undefined);
    const listener = (...args: unknown[]) => sync(args[0]);
    ethereum.on?.("accountsChanged", listener);
    return () => ethereum.removeListener?.("accountsChanged", listener);
  }, []);

  const connect = useCallback(async (walletType?: any) => {
    const targetWallet = typeof walletType === "string" ? walletType : undefined;
    setConnecting(true);
    setError(null);
    try {
      let targetProvider: any = typeof window !== "undefined" ? window.ethereum : undefined;

      if (typeof window !== "undefined") {
        const win = window as any;
        if (targetWallet === "phantom") {
          targetProvider = win.phantom?.ethereum || (win.ethereum?.providers?.find((p: any) => p.isPhantom)) || (win.ethereum?.isPhantom ? win.ethereum : null);
          if (!targetProvider) {
            window.open("https://phantom.app/", "_blank");
            throw new Error("Phantom extension not detected. Opening download page...");
          }
        } else if (targetWallet === "coinbase") {
          targetProvider = win.coinbaseWalletExtension || (win.ethereum?.providers?.find((p: any) => p.isCoinbaseWallet)) || (win.ethereum?.isCoinbaseWallet ? win.ethereum : null);
          if (!targetProvider) {
            window.open("https://www.coinbase.com/wallet", "_blank");
            throw new Error("Coinbase Wallet not detected. Opening download page...");
          }
        } else if (targetWallet === "brave") {
          targetProvider = win.ethereum?.isBraveWallet ? win.ethereum : win.ethereum?.providers?.find((p: any) => p.isBraveWallet);
          if (!targetProvider) {
            throw new Error("Brave Wallet is only available inside the Brave browser.");
          }
        } else if (targetWallet === "rainbow") {
          targetProvider = win.ethereum?.isRainbow ? win.ethereum : win.ethereum?.providers?.find((p: any) => p.isRainbow);
          if (!targetProvider) {
            window.open("https://rainbow.me/", "_blank");
            throw new Error("Rainbow wallet not detected. Opening download page...");
          }
        } else if (targetWallet === "metamask") {
          targetProvider = win.ethereum?.providers?.find((p: any) => p.isMetaMask && !p.isPhantom && !p.isBraveWallet) || (win.ethereum?.isMetaMask ? win.ethereum : win.ethereum);
          if (!targetProvider) {
            window.open("https://metamask.io/download/", "_blank");
            throw new Error("MetaMask not detected. Opening download page...");
          }
        }
      }

      if (!targetProvider) {
        targetProvider = typeof window !== "undefined" ? (window as any).ethereum : undefined;
      }

      if (!targetProvider) {
        window.open("https://metamask.io/download/", "_blank");
        throw new Error("Install an EVM wallet such as MetaMask or Phantom to connect.");
      }

      // 1. Request account authorization first to establish connection & origin session
      const accounts = await targetProvider.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      if (!first) throw new Error("The wallet did not return an EVM account.");
      setAccountId(getAddress(first));

      // 2. Switch to Sepolia if needed, without failing connection if user declines switch
      try {
        const currentChainId = await targetProvider.request({ method: "eth_chainId" });
        if (currentChainId !== SEPOLIA_CHAIN_ID_HEX) {
          await switchToSepolia(targetProvider);
        }
      } catch (chainErr) {
        console.warn("Could not switch to Sepolia network automatically:", chainErr);
      }
    } catch (cause) {
      let message = cause instanceof Error ? cause.message : "Failed to connect the wallet.";
      if (message.toLowerCase().includes("amoy") || message.includes("80002")) {
        message = "MetaMask is stuck on Polygon Amoy. Open MetaMask and switch your network to Sepolia.";
      }
      setError(message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => setAccountId(null), []);

  const approveAllowance = useCallback(async (tokenId: string, spender: string, amount: number) => {
    const ethereum = getMetaMaskProvider() as EthereumProvider | undefined;
    if (!ethereum || !accountId) throw new Error("Connect a Sepolia wallet first.");
    await switchToSepolia(ethereum);
    const provider = new BrowserProvider(ethereum);
    const signer = await provider.getSigner();
    const token = new Contract(tokenId, artifact.abi, signer);
    const tx = await token.approve(getAddress(spender), BigInt(amount));
    const receipt = await tx.wait();
    if (!receipt) throw new Error("The Sepolia allowance transaction was not confirmed.");
    return tx.hash as string;
  }, [accountId]);

  const value = useMemo<EvmWalletContextValue>(() => ({
    accountId,
    connecting,
    error,
    connect,
    disconnect,
    approveAllowance,
  }), [accountId, connecting, error, connect, disconnect, approveAllowance]);

  return <EvmWalletContext.Provider value={value}>{children}</EvmWalletContext.Provider>;
}

export function useEvmWallet(): EvmWalletContextValue {
  const context = useContext(EvmWalletContext);
  if (!context) throw new Error("useEvmWallet must be used within EvmWalletProvider");
  return context;
}
