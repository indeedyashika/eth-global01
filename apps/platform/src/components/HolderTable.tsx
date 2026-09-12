"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/apiClient";
import { Badge, Button, Card, ErrorText } from "@/components/ui";
import type { HolderRecord, TokenRecord } from "@/types";
import { hasRequiredWorldIdVerification } from "@/lib/worldid/policy";

export interface CapTableHolder {
  holder: string;
  walletAccount: string;
  shares: number;
  ownershipPercentage: number;
  ownershipPercentageFormatted: string;
  claimableYieldUsd: number;
  claimableYieldFormatted: string;
  verificationStatus: string;
  livenessStatus: string;
  token: string;
  network: string;
  lastTransaction: string | null;
  lastTransactionUrl: string | null;
  isTreasury: boolean;
}

export interface CapTableData {
  tokenId: string;
  tokenName: string;
  tokenSymbol: string;
  blockchain: "EVM" | "HEDERA";
  network: string;
  totalSupply: number;
  totalSharesAllocated: number;
  unallocatedShares: number;
  depositedRentUsd: number;
  holders: CapTableHolder[];
  hcsSequenceCount: number;
  updatedAt: string;
}

export default function HolderTable({
  token,
  holders: initialHolders,
}: {
  token: TokenRecord;
  holders: HolderRecord[];
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capTable, setCapTable] = useState<CapTableData | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchCapTable = async () => {
    try {
      setIsLoading(true);
      const res = await fetch(`/api/tokens/${token.id}/captable`);
      const data = await res.json();
      if (data.success && data.capTable) {
        setCapTable(data.capTable);
      }
    } catch (err) {
      console.warn("[HolderTable] Could not fetch authoritative cap table:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCapTable();
  }, [token.id]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusyKey(key);
    setError(null);
    try {
      await fn();
      await fetchCapTable();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyKey(null);
    }
  }

  // Authoritative holders list: prefer capTable.holders from backend, otherwise fallback to local calculation
  const displayedHolders: CapTableHolder[] = capTable?.holders ?? [
    {
      holder: "Treasury (Issuer)",
      walletAccount: token.treasuryAccountId,
      shares: Number(token.initialSupply) || 1000,
      ownershipPercentage: 100.0,
      ownershipPercentageFormatted: "100.00%",
      claimableYieldUsd: 0,
      claimableYieldFormatted: "$0.00 / mo",
      verificationStatus: "Exempt (Issuer)",
      livenessStatus: "EXEMPT",
      token: token.symbol,
      network: token.blockchain === "EVM" ? "Base Sepolia (EVM)" : "Hedera Testnet",
      lastTransaction: token.createTxId || null,
      lastTransactionUrl: token.hashscanUrl || null,
      isTreasury: true,
    },
  ];

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-200 pb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="font-bold text-black text-base">Authoritative Shareholder Cap Table</h2>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 bg-black text-white rounded">
              DYNAMIC LEDGER
            </span>
          </div>
          <p className="text-xs text-neutral-600">
            Authoritative token balances, real-time fractional ownership %, and proportional rental yield.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={isLoading}
          onClick={() => fetchCapTable()}
        >
          {isLoading ? "Refreshing..." : "↻ Refresh On-Chain State"}
        </Button>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="p-3 border border-neutral-200 bg-neutral-50 rounded">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide block">Total Supply</span>
          <span className="text-base font-bold text-black font-mono">
            {(capTable?.totalSupply ?? Number(token.initialSupply) ?? 1000).toLocaleString()} {token.symbol}
          </span>
        </div>
        <div className="p-3 border border-neutral-200 bg-neutral-50 rounded">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide block">Allocated Shares</span>
          <span className="text-base font-bold text-black font-mono">
            {(capTable?.totalSharesAllocated ?? 0).toLocaleString()} Shares
          </span>
        </div>
        <div className="p-3 border border-neutral-200 bg-neutral-50 rounded">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide block">Unallocated Reserves</span>
          <span className="text-base font-bold text-black font-mono">
            {(capTable?.unallocatedShares ?? capTable?.totalSupply ?? 1000).toLocaleString()} Shares
          </span>
        </div>
        <div className="p-3 border border-neutral-200 bg-neutral-50 rounded">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide block">Yield Pool (Monthly)</span>
          <span className="text-base font-bold text-emerald-700 font-mono">
            ${(capTable?.depositedRentUsd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} / mo
          </span>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>

      <div className="overflow-x-auto -mx-4 sm:-mx-5">
        <table className="w-full text-xs min-w-[1000px] border-collapse">
          <thead>
            <tr className="text-left uppercase tracking-wide text-neutral-600 bg-neutral-100 border-y border-neutral-300 text-[10px]">
              <th className="py-2.5 px-4 font-bold">Holder</th>
              <th className="py-2.5 px-3 font-bold">Wallet / Account</th>
              <th className="py-2.5 px-3 font-bold">Shares</th>
              <th className="py-2.5 px-3 font-bold">Ownership %</th>
              <th className="py-2.5 px-3 font-bold">Claimable Yield</th>
              <th className="py-2.5 px-3 font-bold">Verification Status</th>
              <th className="py-2.5 px-3 font-bold">Liveness</th>
              <th className="py-2.5 px-3 font-bold">Token</th>
              <th className="py-2.5 px-3 font-bold">Network</th>
              <th className="py-2.5 px-3 font-bold">Last Transaction</th>
              <th className="py-2.5 px-4 font-bold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {displayedHolders.map((holderRow) => {
              const accountKey = holderRow.walletAccount;
              const matchingLocalHolder = initialHolders.find(
                (h) => h.accountId.toLowerCase() === accountKey.toLowerCase()
              );

              const canWhitelist =
                !holderRow.isTreasury &&
                matchingLocalHolder?.associated &&
                matchingLocalHolder?.status !== "WHITELISTED" &&
                hasRequiredWorldIdVerification(token, matchingLocalHolder);

              const canRevoke =
                !holderRow.isTreasury && matchingLocalHolder?.status === "WHITELISTED";

              const canReclaim =
                !holderRow.isTreasury &&
                (token.keys.wipe || matchingLocalHolder?.allowanceGranted) &&
                holderRow.shares > 0;

              return (
                <tr key={accountKey} className="hover:bg-neutral-50/50 transition">
                  <td className="py-3 px-4 font-bold text-black whitespace-nowrap">
                    {holderRow.holder}
                  </td>
                  <td className="py-3 px-3 font-mono text-[11px] text-neutral-800">
                    {accountKey.length > 18
                      ? `${accountKey.slice(0, 10)}...${accountKey.slice(-8)}`
                      : accountKey}
                  </td>
                  <td className="py-3 px-3 font-bold font-mono text-black">
                    {holderRow.shares.toLocaleString()}
                  </td>
                  <td className="py-3 px-3 font-bold text-black">
                    <span className="px-2 py-0.5 bg-neutral-200 border border-neutral-300 rounded text-[11px] font-mono">
                      {holderRow.ownershipPercentageFormatted}
                    </span>
                  </td>
                  <td className="py-3 px-3 font-bold text-emerald-800 font-mono">
                    {holderRow.claimableYieldFormatted}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <VerificationBadge status={holderRow.verificationStatus} />
                  </td>
                  <td className="py-3 px-3">
                    <LivenessBadge state={holderRow.livenessStatus} />
                  </td>
                  <td className="py-3 px-3 font-mono text-[11px] text-neutral-600">
                    {holderRow.token}
                  </td>
                  <td className="py-3 px-3 text-[11px] text-neutral-600 whitespace-nowrap">
                    {holderRow.network}
                  </td>
                  <td className="py-3 px-3 font-mono text-[11px]">
                    {holderRow.lastTransactionUrl ? (
                      <a
                        href={holderRow.lastTransactionUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-black underline hover:text-neutral-600 font-bold"
                      >
                        {holderRow.lastTransaction
                          ? `${holderRow.lastTransaction.slice(0, 8)}...`
                          : "Explorer"} ↗
                      </a>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    {holderRow.isTreasury ? (
                      <span className="text-neutral-400 text-[10px] uppercase font-bold">Issuer Key</span>
                    ) : (
                      <div className="flex justify-end gap-1.5 flex-wrap">
                        {canWhitelist && (
                          <Button
                            variant="secondary"
                            disabled={busyKey === `${accountKey}:whitelist`}
                            onClick={() =>
                              run(`${accountKey}:whitelist`, () =>
                                postJson(`/api/tokens/${token.id}/holders/${accountKey}/whitelist`)
                              )
                            }
                          >
                            Whitelist
                          </Button>
                        )}
                        {canRevoke && (
                          <Button
                            variant="secondary"
                            disabled={busyKey === `${accountKey}:revoke`}
                            onClick={() =>
                              run(`${accountKey}:revoke`, () =>
                                postJson(`/api/tokens/${token.id}/holders/${accountKey}/revoke`)
                              )
                            }
                          >
                            Revoke
                          </Button>
                        )}
                        {canReclaim && (
                          <Button
                            variant="danger"
                            disabled={busyKey === `${accountKey}:reclaim`}
                            onClick={() => {
                              if (!confirm(`Reclaim ${accountKey}'s balance to treasury?`)) return;
                              run(`${accountKey}:reclaim`, () =>
                                postJson(`/api/tokens/${token.id}/holders/${accountKey}/reclaim-now`)
                              );
                            }}
                          >
                            Reclaim
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function VerificationBadge({ status }: { status: string }) {
  if (status.includes("World ID")) return <Badge tone="emerald">{status}</Badge>;
  if (status.includes("Exempt")) return <Badge tone="zinc">{status}</Badge>;
  if (status.includes("KYC")) return <Badge tone="emerald">{status}</Badge>;
  return <Badge tone="amber">{status}</Badge>;
}

function LivenessBadge({ state }: { state: string }) {
  if (state === "EXEMPT" || state === "OK") return <Badge tone="emerald">{state}</Badge>;
  if (state === "AT_RISK") return <Badge tone="amber">AT RISK</Badge>;
  if (state === "EXPIRED") return <Badge tone="red">EXPIRED</Badge>;
  return <Badge tone="zinc">—</Badge>;
}
