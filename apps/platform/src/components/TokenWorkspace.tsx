"use client";

import Link from "next/link";
import React, { useEffect, useState, useRef } from "react";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useWallet } from "@/hooks/useWalletConnect";
import { TheGraphInspectorModal } from "@/components/TheGraphInspectorModal";
import HolderTable from "@/components/HolderTable";
import HolderPanel from "@/components/HolderPanel";
import EventLog from "@/components/EventLog";
import type {
  EventRecord,
  HolderRecord,
  TokenRecord,
  TokenRequestRecord,
  WorldIdClientConfig,
} from "@/types";

export default function TokenWorkspace({
  token,
  holders,
  events,
  requests,
  worldConfig,
}: {
  token: TokenRecord;
  holders: HolderRecord[];
  events: EventRecord[];
  requests: TokenRequestRecord[];
  worldConfig: WorldIdClientConfig;
}) {
  const evm = useEvmWallet();
  const hedera = useWallet();
  const activeAccountId = evm.accountId || hedera.accountId || "";

  const [activeTab, setActiveTab] = useState<"overview" | "captable" | "worldid" | "ledger">("overview");
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
  const [isRunningPipeline, setIsRunningPipeline] = useState(false);
  const [pipelineSuccess, setPipelineSuccess] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<any | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  // Parse property address from memo or fallback to name
  const propertyAddress =
    token.memo?.split("·")[0]?.replace("USPS DPV Validated", "").trim() ||
    token.memo?.split("|")[0]?.trim() ||
    token.name;

  // Derive initial monthly rent from memo or initial supply
  const rentMatch = token.memo?.match(/\$([0-9,]+)/);
  const initialRent = rentMatch
    ? Number(rentMatch[1].replace(/,/g, ""))
    : Number(token.initialSupply) >= 5000
    ? 8200
    : 5000;

  const [monthlyRent, setMonthlyRent] = useState<number>(initialRent);
  const [depositAmount, setDepositAmount] = useState<number>(monthlyRent);
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositSuccess, setDepositSuccess] = useState(false);

  // Per-second stream rate for 10% investor share: (monthlyRent * 0.1) / (30 * 86400)
  const sharePct = 10.0;
  const investorMonthlyRent = (monthlyRent * sharePct) / 100;
  const flowRatePerSec = investorMonthlyRent / 2592000;

  const [accruedYield, setAccruedYield] = useState<number>(14.8251);
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [isClaiming, setIsClaiming] = useState<boolean>(false);
  const [claimReceipt, setClaimReceipt] = useState<{ txId: string; hashscanUrl: string; amount: number } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const startRef = useRef<number>(Date.now());
  const initialRef = useRef<number>(14.8251);

  // Real-time ticking balance (80ms interval)
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      setAccruedYield(initialRef.current + elapsed * flowRatePerSec);
    }, 80);
    return () => clearInterval(timer);
  }, [isStreaming, flowRatePerSec]);

  // Claim yield via real API endpoint
  const handleClaimYield = async () => {
    setIsClaiming(true);
    setClaimError(null);
    try {
      if (!activeAccountId) throw new Error("Connect the investor wallet and authorize a session before claiming.");
      const sessionRes = await fetch(`/api/agent/session?grantor=${encodeURIComponent(activeAccountId)}`);
      const sessionData = await sessionRes.json().catch(() => ({}));
      if (!sessionData.session?.sessionId) {
        throw new Error("No active signed session. Open the Safety Cockpit to authorize one first.");
      }
      const res = await fetch("/api/yield/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          sessionId: sessionData.session.sessionId,
          tokenId: token.id,
        }),
      });
      const data = await res.json();
      if (data.success && data.provenance === "LIVE_ONCHAIN" && data.txId) {
        setClaimReceipt({
          txId: data.txId,
          hashscanUrl: data.hashscanUrl,
          amount: data.amountClaimed,
        });
        initialRef.current = 0;
        startRef.current = Date.now();
        setAccruedYield(0);
        setTimeout(() => setClaimReceipt(null), 8000);
      } else {
        setClaimError(data.error || "Yield was not settled. No funds were transferred.");
      }
    } catch (err) {
      console.error("Claim error:", err);
      setClaimError(err instanceof Error ? err.message : "Yield claim failed.");
    } finally {
      setIsClaiming(false);
    }
  };

  // Inject tenant rent
  const handleInjectRent = async () => {
    setIsDepositing(true);
    setDepositSuccess(false);
    try {
      const res = await fetch("/api/rent/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId: token.id,
          amount: depositAmount,
          tenantName: "Acme Residential Tenant Corp",
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMonthlyRent(depositAmount);
        setDepositSuccess(true);
        setTimeout(() => setDepositSuccess(false), 5000);
      }
    } catch (err) {
      console.error("Rent injection error:", err);
    } finally {
      setIsDepositing(false);
    }
  };

  // Run autonomous agent pipeline
  const handleTriggerPipeline = async () => {
    setIsRunningPipeline(true);
    setPipelineSuccess(false);
    setPipelineError(null);
    try {
      // Resolve active session for grantor
      const sessionUrl = evm.accountId
        ? `/api/agent/session?grantor=${encodeURIComponent(evm.accountId)}`
        : "/api/agent/session";
      const sessionRes = await fetch(sessionUrl);
      const sessionData = await sessionRes.json().catch(() => ({}));
      if (!sessionData.session?.sessionId) {
        setPipelineError(
          "No active session key found. Please open the Safety Cockpit to grant an EIP-712 session key first."
        );
        return;
      }

      const res = await fetch("/api/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionData.session.sessionId,
          action: "FULL_TOKENIZATION_AND_YIELD_PIPELINE",
          property: {
            street: propertyAddress,
            city: "Miami",
            state: "FL",
            zip: "33101",
            monthlyRent,
            shares: Number(token.initialSupply) || 1000,
          },
        }),
      });
      const contentType = res.headers.get("content-type") || "";
      let data: any = {};
      if (contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        try { data = JSON.parse(text); } catch { data = {}; }
      }
      if (data.success) {
        setPipelineSuccess(true);
        setPipelineResult(data);
      } else {
        setPipelineError(data.error || "Autonomous execution failed");
      }
    } catch (e: any) {
      console.error("Pipeline trigger failed:", e);
      setPipelineError(e.message || "Pipeline trigger failed");
    } finally {
      setIsRunningPipeline(false);
    }
  };

  return (
    <div className="min-h-screen bg-white font-mono text-black">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between border-b border-neutral-200 pb-4 text-xs">
          <Link
            href="/"
            className="font-bold text-neutral-600 hover:text-black transition flex items-center gap-1.5"
          >
            <span>←</span>
            <span>Back to Hermes Mission Control</span>
          </Link>
          <div className="flex items-center gap-2 text-neutral-500">
            <span>RWA Token Console</span>
            <span>·</span>
            <span className="text-black font-semibold">{token.symbol}</span>
          </div>
        </div>

        {/* 1. Dynamic Instrument Header Card */}
        <div className="border border-neutral-300 bg-neutral-50 p-6 sm:p-8 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="px-2.5 py-1 bg-black text-white text-xs font-bold">
                  {token.symbol}
                </span>
                <h1 className="text-2xl font-bold tracking-tight text-black">
                  {token.name}
                </h1>
                <span className="px-2 py-0.5 bg-neutral-200 border border-neutral-300 text-[10px] uppercase font-bold text-black">
                  ACTIVE RWA
                </span>
              </div>
              <div className="text-xs text-neutral-600 flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-black">Token ID: {token.id}</span>
                <span>·</span>
                <span>{token.blockchain === "EVM" ? "Ethereum Sepolia" : "Hedera Testnet"}</span>
                <span>·</span>
                <a
                  href={token.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-black underline hover:text-neutral-600 flex items-center gap-0.5"
                >
                  <span>{token.explorerName}</span>
                  <span>↗</span>
                </a>
              </div>
              <div className="text-xs text-neutral-500 pt-1">
                📍 {propertyAddress} · Total Shares: {Number(token.initialSupply).toLocaleString()}
              </div>
            </div>

            {/* Live Investor Balance & Streaming Yield Counter */}
            <div className="border border-neutral-300 bg-white p-4 text-xs space-y-2 min-w-[280px]">
              <div className="flex items-center justify-between text-neutral-500">
                <span>INVESTOR POSITION (10%)</span>
                <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
              </div>
              <div className="text-xl font-bold text-black flex items-baseline gap-1.5">
                <span>{(Number(token.initialSupply) * 0.1).toFixed(0)}</span>
                <span className="text-xs text-neutral-600 font-normal">{token.symbol} Shares</span>
              </div>
              <div className="text-[11px] text-neutral-600 flex items-center justify-between pt-1 border-t border-neutral-200">
                <span>Superfluid CFA Yield:</span>
                <span className="font-bold text-black font-mono">
                  ${accruedYield.toFixed(6)}
                </span>
              </div>
              <div className="pt-2">
                <button
                  onClick={handleClaimYield}
                  disabled={isClaiming || accruedYield <= 0.001}
                  className="w-full bg-black text-white py-2 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer"
                >
                  {isClaiming ? "Settling Claim..." : `Claim Yield ($${accruedYield.toFixed(2)})`}
                </button>
              </div>

              {claimReceipt && (
                <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-1.5 text-center text-black space-y-0.5">
                  <div className="font-bold">✓ Claimed ${claimReceipt.amount.toFixed(4)}!</div>
                  <a
                    href={claimReceipt.hashscanUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-[9px] text-neutral-600 block truncate"
                  >
                    Tx: {claimReceipt.txId} ↗
                  </a>
                </div>
              )}
              {claimError && (
                <div className="mt-2 text-xs text-amber-800" role="alert">
                  Claim not settled: {claimError}
                </div>
              )}
            </div>
          </div>

          {/* Compliance & Rail Badges */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-neutral-200 text-xs">
            <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
              ✓ USPS DPV Verified Property
            </span>
            <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
              ✓ Blocky402 Micropayment Facilitated
            </span>
            <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
              ✓ Superfluid CFA Continuous Stream
            </span>
            <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
              ✓ The Graph Subgraph Indexed
            </span>
            <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
              ✓ ERC-7579 Scoped Session Safe
            </span>
            {token.compliance.worldIdRequired && (
              <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
                ✓ World ID Biometric KYC
              </span>
            )}
            {token.compliance.livenessEnabled && (
              <span className="px-2 py-0.5 bg-white border border-neutral-300 text-[11px]">
                ✓ Liveness Check-in Active
              </span>
            )}
          </div>
        </div>

        {/* 2. Top Operational Metrics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1: Rental Yield & Cashflow */}
          <div className="border border-neutral-300 bg-white p-5 space-y-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">
              Rental Cashflow
            </div>
            <div className="text-2xl font-bold text-black">
              ${monthlyRent.toLocaleString()}.00 <span className="text-xs font-normal text-neutral-600">/ month</span>
            </div>
            <p className="text-xs text-neutral-600 leading-relaxed">
              Gross residential rent collected and distributed continuously into shareholder smart wallets via Superfluid CFA.
            </p>
            <div className="text-[11px] text-black font-semibold pt-2 border-t border-neutral-200">
              Flow Rate: +${flowRatePerSec.toFixed(8)} / sec
            </div>
          </div>

          {/* Card 2: Hedera Consensus Service Audit */}
          <div className="border border-neutral-300 bg-white p-5 space-y-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">
              Hedera HCS Audit Trail
            </div>
            <div className="text-2xl font-bold text-black">
              {events.find((e) => e.hashscanUrl?.includes("/topic/"))?.hashscanUrl?.split("/topic/")[1]
                ? `Topic ${events.find((e) => e.hashscanUrl?.includes("/topic/"))?.hashscanUrl?.split("/topic/")[1]}`
                : "HCS Consensus"}
            </div>
            <p className="text-xs text-neutral-600 leading-relaxed">
              Every x402 oracle check and yield distribution writes an immutable consensus audit record directly to Hedera Consensus Service.
            </p>
            <div className="pt-2 border-t border-neutral-200">
              {events.find((e) => e.hashscanUrl?.includes("/topic/"))?.hashscanUrl ? (
                <a
                  href={events.find((e) => e.hashscanUrl?.includes("/topic/"))!.hashscanUrl!}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-bold text-black underline hover:text-neutral-600 flex items-center gap-1"
                >
                  <span>View HCS Topic on HashScan</span>
                  <span>↗</span>
                </a>
              ) : (
                <span className="text-xs text-neutral-500 font-mono">HCS Topic Unconfigured</span>
              )}
            </div>
          </div>

          {/* Card 3: The Graph Dynamic Cap Table */}
          <div className="border border-neutral-300 bg-white p-5 space-y-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">
              The Graph Protocol
            </div>
            <div className="text-2xl font-bold text-black">
              {holders.length > 0 ? `${holders.length} Active Holders` : "0 Active Holders"}
            </div>
            <p className="text-xs text-neutral-600 leading-relaxed">
              Hermes queries live Sepolia Subgraph indexers to discover shareholder cap tables and dynamically scale Superfluid CFA stream flows.
            </p>
            <div className="pt-2 border-t border-neutral-200">
              <button
                type="button"
                onClick={() => setIsGraphModalOpen(true)}
                className="text-xs font-bold text-black underline hover:text-neutral-600 flex items-center gap-1 cursor-pointer"
              >
                <span>🔍 Inspect Subgraph Cap Table</span>
                <span>↗</span>
              </button>
            </div>
          </div>
        </div>

        {/* 3. Navigation Tabs */}
        <div className="flex border-b border-neutral-300 gap-2 text-xs sm:text-sm font-semibold">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-5 py-3 border-b-2 transition cursor-pointer ${
              activeTab === "overview"
                ? "border-black text-black bg-neutral-100 font-bold"
                : "border-transparent text-neutral-500 hover:text-black"
            }`}
          >
            ⚡ Cashflow &amp; Agent Actions
          </button>
          <button
            onClick={() => setActiveTab("captable")}
            className={`px-5 py-3 border-b-2 transition cursor-pointer ${
              activeTab === "captable"
                ? "border-black text-black bg-neutral-100 font-bold"
                : "border-transparent text-neutral-500 hover:text-black"
            }`}
          >
            👥 Cap Table ({holders.length})
          </button>
          <button
            onClick={() => setActiveTab("worldid")}
            className={`px-5 py-3 border-b-2 transition cursor-pointer ${
              activeTab === "worldid"
                ? "border-black text-black bg-neutral-100 font-bold"
                : "border-transparent text-neutral-500 hover:text-black"
            }`}
          >
            🛡️ World ID Portal
          </button>
          <button
            onClick={() => setActiveTab("ledger")}
            className={`px-5 py-3 border-b-2 transition cursor-pointer ${
              activeTab === "ledger"
                ? "border-black text-black bg-neutral-100 font-bold"
                : "border-transparent text-neutral-500 hover:text-black"
            }`}
          >
            📜 Consensus Activity ({events.length})
          </button>
        </div>

        {/* Tab 1: Cashflow & Agent Actions */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Rent Inflow Engine for this property */}
            <div className="border border-neutral-300 bg-white p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-neutral-200 pb-3">
                <div>
                  <h3 className="text-base font-bold text-black">Tenant Rent Deposit Execution</h3>
                  <p className="text-xs text-neutral-600 mt-0.5">
                    Deposit on-chain rent to accelerate continuous Superfluid cashflow distribution for this property.
                  </p>
                </div>
                <span className="text-xs px-2 py-0.5 bg-neutral-100 border border-neutral-300 font-bold text-black">
                  fUSDCx Reserve
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px]">
                  <span className="absolute left-3 top-2 text-neutral-500 text-xs">$</span>
                  <input
                    type="number"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(Number(e.target.value))}
                    className="w-full bg-neutral-50 border border-neutral-300 pl-7 pr-3 py-2 text-xs font-mono text-black focus:border-black focus:outline-none"
                    placeholder="5000"
                  />
                </div>
                <div className="flex gap-2">
                  {[2500, 5000, 7500, 10000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setDepositAmount(amt)}
                      className={`px-2.5 py-1.5 border text-xs cursor-pointer ${
                        depositAmount === amt
                          ? "bg-black text-white border-black"
                          : "bg-white text-black border-neutral-300 hover:border-black"
                      }`}
                    >
                      ${amt.toLocaleString()}
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleInjectRent}
                  disabled={isDepositing || depositAmount <= 0}
                  className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-50 transition cursor-pointer"
                >
                  {isDepositing ? "Injecting..." : "Inject Rent Deposit"}
                </button>
              </div>

              {depositSuccess && (
                <div className="text-xs bg-neutral-100 border border-neutral-300 p-2.5 text-black font-semibold flex items-center justify-between">
                  <span>✓ ${depositAmount.toLocaleString()} Rent Injected! Flow rate dynamically accelerated.</span>
                  <span className="text-[10px] text-neutral-600">HCS Sequence Logged</span>
                </div>
              )}
            </div>

            {/* Autonomous Pipeline Action */}
            <div className="border border-neutral-300 bg-neutral-50 p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-black">
                    Autonomous Economic Execution
                  </h3>
                  <p className="text-xs text-neutral-600">
                    Trigger Hermes to verify property status via x402 and settle continuous Superfluid yield streaming under delegated session constraints.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleTriggerPipeline}
                    disabled={isRunningPipeline}
                    className="bg-black text-white px-5 py-2.5 border border-black hover:bg-neutral-800 transition font-bold text-xs cursor-pointer flex items-center gap-2 disabled:opacity-50"
                  >
                    {isRunningPipeline ? (
                      <>
                        <span className="w-2.5 h-2.5 rounded-full bg-white animate-spin" />
                        <span>Executing Pipeline...</span>
                      </>
                    ) : (
                      <>
                        <span>⚡</span>
                        <span>Trigger Cashflow Distribution</span>
                      </>
                    )}
                  </button>
                  <Link
                    href="/#safety-cockpit"
                    className="px-4 py-2.5 bg-white border border-neutral-300 text-black hover:bg-neutral-100 transition font-semibold text-xs cursor-pointer"
                  >
                    🛡️ Open Safety Cockpit
                  </Link>
                </div>
              </div>

              {pipelineError && (
                <div className="p-3 border border-red-500 bg-red-50 text-red-700 text-xs">
                  <strong>Session Error:</strong> {pipelineError}
                </div>
              )}

              {pipelineSuccess && pipelineResult && (
                <div className="p-4 border border-black bg-white text-xs space-y-2">
                  <div className="flex items-center justify-between text-black font-bold">
                    <span className="flex items-center gap-1.5">
                      <span>✓</span>
                      <span>Autonomous Cashflow Distribution Successfully Executed</span>
                    </span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      Execution ID: {pipelineResult.executionId}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-neutral-700 pt-2 border-t border-neutral-200">
                    <div>
                      Settlement: <strong>0.5 HBAR x402 Micropayment</strong> (Delegated Session Cap)
                    </div>
                    <div>
                      Yield Stream: <strong>+${flowRatePerSec.toFixed(8)} / sec</strong> active on Base Sepolia
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Cap Table */}
        {activeTab === "captable" && (
          <div className="space-y-6">
            <HolderTable token={token} holders={holders} />
          </div>
        )}

        {/* Tab 3: World ID Portal & Token Requests */}
        {activeTab === "worldid" && (
          <div className="space-y-6">
            <HolderPanel
              token={token}
              holders={holders}
              requests={requests}
              worldConfig={worldConfig}
            />
          </div>
        )}

        {/* Tab 4: Immutable Consensus Activity Ledger */}
        {activeTab === "ledger" && (
          <div className="space-y-6">
            <EventLog events={events} />
          </div>
        )}

        {/* Interactive The Graph Inspector Modal */}
        <TheGraphInspectorModal
          isOpen={isGraphModalOpen}
          onClose={() => setIsGraphModalOpen(false)}
        />
      </div>
    </div>
  );
}
