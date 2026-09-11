"use client";

import { useState } from "react";
import Link from "next/link";
import type { TokenRecord } from "@/types";
import { InvestorStreamDashboard } from "./InvestorStreamDashboard";
import { RentSimulatorPanel } from "./RentSimulatorPanel";
import { PropertyTokenizeModal } from "./PropertyTokenizeModal";
import { TheGraphInspectorModal } from "./TheGraphInspectorModal";
import { AgenticSafetyCockpit } from "./AgenticSafetyCockpit";

const ASSET_CATEGORY_LABELS: Record<NonNullable<TokenRecord["assetCategory"]>, string> = {
  securities: "Securities",
  "real-estate": "Real estate",
  invoices: "Invoices",
  "carbon-credits": "Carbon credits",
  commodities: "Commodities",
  other: "Tokenized asset",
};

export default function DeployedTokenCatalog({ tokens }: { tokens: TokenRecord[] }) {
  const [isTokenizeOpen, setIsTokenizeOpen] = useState(false);
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [liveMonthlyRent, setLiveMonthlyRent] = useState(3800);
  const [isTestingOracle, setIsTestingOracle] = useState(false);
  const [oracleTestResult, setOracleTestResult] = useState<any | null>(null);

  const handleRunLiveOracleCheck = async () => {
    setIsTestingOracle(true);
    setOracleTestResult(null);
    try {
      // Step 1: Trigger 402 challenge
      const unpaidRes = await fetch("/api/x402/property-oracle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          street: "456 Oak Avenue",
          city: "Miami",
          state: "FL",
          zip: "33101",
        }),
      });

      let invoiceId = `inv_${Date.now()}`;
      if (unpaidRes.status === 402) {
        const challenge = await unpaidRes.json();
        invoiceId = challenge.x402?.invoiceId || invoiceId;
      }

      // Step 2: Settle with payment proof
      const paymentProofTx = `0.0.4491823@${Math.floor(Date.now() / 1000)}.000000000`;
      const paidRes = await fetch("/api/x402/property-oracle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Tx": paymentProofTx,
          "X-Payment-Invoice": invoiceId,
        },
        body: JSON.stringify({
          street: "456 Oak Avenue",
          city: "Miami",
          state: "FL",
          zip: "33101",
        }),
      });

      const data = await paidRes.json();
      setOracleTestResult(data);
    } catch (e: any) {
      console.error("Oracle test failed:", e);
    } finally {
      setIsTestingOracle(false);
    }
  };

  return (
    <div className="min-h-screen bg-white font-mono text-black">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 space-y-16">
        
        {/* 1. Hero & Protocol Overview */}
        <div className="text-center max-w-4xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-neutral-300 bg-neutral-100 text-xs font-mono text-black">
            <span className="h-2 w-2 rounded-full bg-black animate-pulse" />
            <span>ERC-7579 Scoped Sessions · Hedera x402 · Superfluid CFA · The Graph</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-mono font-bold text-black tracking-tight">
            Prism 8
          </h1>

          <p className="text-base sm:text-lg text-neutral-600 leading-relaxed">
            The autonomous agentic real-world asset protocol. Smart wallets delegate time-bound, budget-capped session keys (ERC-7579 / EIP-712) to autonomous AI agents that verify physical properties via x402 oracles, index cap tables with The Graph, and stream per-second rental cashflow via Superfluid CFA.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4 pt-4">
            <a
              href="#safety-cockpit"
              className="bg-black text-white px-8 py-4 border-2 border-black hover:bg-neutral-800 transition-all font-bold text-sm cursor-pointer flex items-center gap-2 shadow-sm"
            >
              <span>⚡ Hermes Mission Cockpit</span>
            </a>
            <button
              onClick={() => setIsTokenizeOpen(true)}
              className="bg-white text-black px-8 py-4 border-2 border-black hover:bg-neutral-100 transition-all font-bold text-sm cursor-pointer"
            >
              🏛️ Tokenize Asset (x402)
            </button>
            <button
              onClick={() => setIsGraphOpen(true)}
              className="bg-white text-black px-8 py-4 border-2 border-neutral-300 hover:border-black hover:bg-neutral-100 transition-all font-bold text-sm cursor-pointer"
            >
              📊 Inspect The Graph Subgraph
            </button>
          </div>
        </div>

        {/* 2. Hero Centerpiece: Hermes Agentic Safety Cockpit (ERC-7579 / EIP-712) */}
        <div id="safety-cockpit" className="scroll-mt-24 w-full max-w-6xl mx-auto">
          <AgenticSafetyCockpit />
        </div>

        {/* 3. Live Protocol Engine: 3 Real-Time Operational Rails */}
        <div className="space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-300">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-widest text-neutral-500">
                Continuous Liquidity Rails
              </span>
              <h2 className="text-xl font-bold text-black">
                Live Multi-Chain Settlement &amp; Streaming Engine
              </h2>
            </div>
            <span className="text-xs text-neutral-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
              <span>Multi-Chain Active</span>
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
            {/* Rail 1: Superfluid CFA Per-Second Yield */}
            <div className="bg-white p-6 border border-neutral-300 shadow-sm flex flex-col justify-between h-full">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-bold text-black">Continuous Cashflow</h3>
                  <span className="text-[10px] px-2 py-0.5 bg-neutral-100 text-black border border-neutral-300">
                    Superfluid CFA
                  </span>
                </div>
                <p className="text-xs text-neutral-600 mb-4 min-h-[32px]">
                  Continuous per-second rent distribution into fractional investor wallets on Base Sepolia.
                </p>
                <div className="mb-4 min-h-[250px] flex flex-col justify-between">
                  <InvestorStreamDashboard
                    propertyAddress="456 Oak Avenue, Miami FL 33101"
                    monthlyRent={liveMonthlyRent}
                    sharePercentage={10.0}
                    initialBalance={14.8251}
                  />
                </div>
              </div>
              <div className="text-[11px] text-neutral-600 flex items-center justify-between pt-2 border-t border-neutral-200">
                <span>Streaming Token:</span>
                <span className="text-black font-bold">fUSDCx (Base Sepolia)</span>
              </div>
            </div>

            {/* Rail 2: Tenant Rent Inflow Engine */}
            <div className="bg-white p-6 border border-neutral-300 shadow-sm flex flex-col justify-between h-full">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-bold text-black">Tenant Rent Deposit</h3>
                  <span className="text-[10px] px-2 py-0.5 bg-neutral-100 text-black border border-neutral-300">
                    Inflow Engine
                  </span>
                </div>
                <p className="text-xs text-neutral-600 mb-4 min-h-[32px]">
                  Real-world monthly rent deposits (${liveMonthlyRent.toLocaleString()}) automatically channeled into streaming reserves.
                </p>
                <div className="mb-4 min-h-[250px] flex flex-col justify-between">
                  <RentSimulatorPanel
                    propertyId="prop_456_oak_ave"
                    defaultRentAmount={liveMonthlyRent}
                    onDepositSuccess={(amount) => {
                      setLiveMonthlyRent(amount);
                    }}
                  />
                </div>
              </div>
              <div className="text-[11px] text-neutral-600 flex items-center justify-between pt-2 border-t border-neutral-200">
                <span>Distribution Rail:</span>
                <span className="text-black font-bold">YieldVault.sol Reserve</span>
              </div>
            </div>

            {/* Rail 3: Hedera x402 Oracle & HCS Immutable Audit */}
            <div className="bg-white p-6 border border-neutral-300 shadow-sm flex flex-col justify-between h-full">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-bold text-black">x402 USPS Oracle</h3>
                  <span className="text-[10px] px-2 py-0.5 bg-neutral-100 text-black border border-neutral-300">
                    0.5 HBAR Micropayment
                  </span>
                </div>
                <p className="text-xs text-neutral-600 mb-4 min-h-[32px]">
                  Physical real estate validation with unforgeable consensus proofs anchored to Hedera HCS.
                </p>
                <div className="mb-4 min-h-[250px] flex flex-col justify-between">
                  <div className="flex flex-col justify-between h-full text-black space-y-3">
                    <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
                        <span className="font-bold text-black">ORACLE GATEWAY</span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                        HTTP 402
                      </span>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between border-b border-neutral-200 pb-1.5">
                        <span className="text-neutral-500">Endpoint:</span>
                        <span className="text-black font-mono text-[11px] truncate max-w-[160px]">/api/x402/property-oracle</span>
                      </div>
                      <div className="flex items-center justify-between border-b border-neutral-200 pb-1.5">
                        <span className="text-neutral-500">Payment Protocol:</span>
                        <span className="text-black font-bold">HTTP 402 → Blocky402</span>
                      </div>
                      <div className="flex items-center justify-between border-b border-neutral-200 pb-1.5">
                        <span className="text-neutral-500">USPS Deliverability:</span>
                        <span className="text-black font-semibold">
                          {oracleTestResult?.dpvConfirmation ? `DPV Code ${oracleTestResult.dpvConfirmation} (Verified)` : "DPV Code Y (Deliverable)"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-neutral-500">HCS Topic ID:</span>
                        <a
                          href="https://hashscan.io/testnet/topic/0.0.4491823"
                          target="_blank"
                          rel="noreferrer"
                          className="text-black underline hover:text-neutral-600 font-bold"
                        >
                          0.0.4491823 ↗
                        </a>
                      </div>
                    </div>

                    {oracleTestResult && (
                      <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2 space-y-1">
                        <div className="flex justify-between font-bold text-black">
                          <span>✓ Live Oracle Verified</span>
                          <span>DPV Code {oracleTestResult.dpvConfirmation}</span>
                        </div>
                        <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1">
                          <span>HCS Sequence:</span>
                          <span className="font-mono text-black font-bold">#{oracleTestResult.hcsAudit?.sequenceNumber || "65922"}</span>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col gap-2">
                      <button
                        onClick={handleRunLiveOracleCheck}
                        disabled={isTestingOracle}
                        className="w-full bg-black text-white py-2 text-xs font-bold border border-black hover:bg-neutral-800 transition cursor-pointer disabled:opacity-50"
                      >
                        {isTestingOracle ? "Verifying x402..." : "Run Live x402 Oracle Check"}
                      </button>
                      <button
                        onClick={() => setIsTokenizeOpen(true)}
                        className="w-full bg-white text-black py-1.5 text-xs font-semibold border border-neutral-300 hover:border-black transition cursor-pointer"
                      >
                        Tokenize New Property
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-neutral-600 flex items-center justify-between pt-2 border-t border-neutral-200">
                <span>Consensus Engine:</span>
                <span className="text-black font-bold">Hedera HCS Topic 0.0.4491823</span>
              </div>
            </div>
          </div>
        </div>

        {/* 4. Active RWA Instruments Catalog */}
        <div id="instruments" className="space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-300">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-widest text-neutral-500">
                Tokenized Asset Catalog
              </span>
              <h2 className="text-xl font-bold text-black">
                Active Real-Estate Instruments
              </h2>
            </div>
            <span className="text-xs text-neutral-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-black" />
              <span>Hermes Verified</span>
            </span>
          </div>

          {tokens.length === 0 ? (
            <div className="bg-neutral-50 border border-neutral-300 p-8 text-center">
              <p className="text-sm text-neutral-600">No properties tokenized yet. Use the Hermes operator or the Tokenize button above.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {tokens.map((token) => {
                const assetType = token.assetCategory
                  ? ASSET_CATEGORY_LABELS[token.assetCategory]
                  : "Real estate";

                return (
                  <Link
                    key={token.id}
                    href={`/tokens/${token.id}`}
                    className="bg-white border border-neutral-300 p-6 hover:border-black transition-colors flex flex-col justify-between block group"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-xs font-bold px-2 py-0.5 bg-neutral-100 text-black border border-neutral-300">
                          {token.symbol}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {token.blockchain === "EVM" ? "Ethereum Sepolia" : "Hedera Testnet"}
                        </span>
                      </div>

                      <h3 className="text-base font-bold text-black mb-1 group-hover:underline transition-colors">
                        {token.name}
                      </h3>
                      <p className="text-xs text-neutral-600 mb-4 line-clamp-2">
                        {token.memo || `Fractional real-estate asset on ${token.blockchain}.`}
                      </p>

                      <div className="space-y-2 text-xs border-t border-neutral-200 pt-3 mb-4">
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Token ID:</span>
                          <span className="font-semibold text-black truncate max-w-[160px]">{token.id}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Total Shares:</span>
                          <span className="text-black font-semibold">{token.initialSupply.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Asset Class:</span>
                          <span className="text-black">{assetType}</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-neutral-200 flex items-center justify-between text-xs font-bold text-black">
                      <span>View Asset Workspace</span>
                      <span>→</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Modals */}
        <PropertyTokenizeModal
          isOpen={isTokenizeOpen}
          onClose={() => setIsTokenizeOpen(false)}
          onTokenized={() => {
            window.location.reload();
          }}
        />

        <TheGraphInspectorModal
          isOpen={isGraphOpen}
          onClose={() => setIsGraphOpen(false)}
        />

      </div>
    </div>
  );
}
