"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccountAllowanceApproveTransaction, AccountId, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";
import { getDAppConnector } from "@/lib/walletconnect/connector";

interface WalletContextValue {
  accountId: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Holder signs a TokenAssociateTransaction for their own account. Returns the tx id. */
  associateToken: (tokenId: string) => Promise<string>;
  /** Holder approves a token allowance to `spenderAccountId` (the treasury), enabling
   *  scheduled/immediate compliance reclaims later without a further signature. */
  approveAllowance: (tokenId: string, spenderAccountId: string, amount: number) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore an existing WalletConnect session (if any) on first load.
  useEffect(() => {
    let cancelled = false;
    getDAppConnector()
      .then((connector) => {
        if (cancelled) return;
        const existing = connector.signers[0];
        if (existing) setAccountId(existing.getAccountId().toString());
      })
      .catch(() => {
        /* env not configured yet, or no prior session — surfaced when the user hits Connect */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const connector = await getDAppConnector();
      const session = await connector.openModal();
      const accounts = session.namespaces?.hedera?.accounts ?? [];
      const first = accounts[0]; // formatted like "hedera:testnet:0.0.xxxxx"
      if (!first) throw new Error("Wallet did not return a Hedera account");
      setAccountId(first.split(":").pop() ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      const connector = await getDAppConnector();
      await connector.disconnectAll();
    } catch {
      // best-effort
    }
    setAccountId(null);
  }, []);

  const associateToken = useCallback(
    async (tokenId: string) => {
      if (!accountId) throw new Error("Connect a wallet first");
      const connector = await getDAppConnector();
      const signer = connector.getSigner(AccountId.fromString(accountId));
      const transaction = new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(accountId))
        .setTokenIds([TokenId.fromString(tokenId)]);
      const response = await transaction.executeWithSigner(signer);
      return response.transactionId.toString();
    },
    [accountId]
  );

  const approveAllowance = useCallback(
    async (tokenId: string, spenderAccountId: string, amount: number) => {
      if (!accountId) throw new Error("Connect a wallet first");
      const connector = await getDAppConnector();
      const signer = connector.getSigner(AccountId.fromString(accountId));
      const transaction = new AccountAllowanceApproveTransaction()
        .approveTokenAllowance(
          TokenId.fromString(tokenId),
          AccountId.fromString(accountId),
          AccountId.fromString(spenderAccountId),
          amount
        );
      const response = await transaction.executeWithSigner(signer);
      return response.transactionId.toString();
    },
    [accountId]
  );

  const value = useMemo<WalletContextValue>(
    () => ({ accountId, connecting, error, connect, disconnect, associateToken, approveAllowance }),
    [accountId, connecting, error, connect, disconnect, associateToken, approveAllowance]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
