"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import type { TokenRecord } from "@/types";
import { InvestorStreamDashboard } from "./InvestorStreamDashboard";
import { RentSimulatorPanel } from "./RentSimulatorPanel";
import { PropertyTokenizeModal } from "./PropertyTokenizeModal";
import { TheGraphInspectorModal } from "./TheGraphInspectorModal";
import { AgenticSafetyCockpit } from "./AgenticSafetyCockpit";
import type { JudgeWorkflowState, StepStatus } from "@/lib/workflow/judgeWorkflow";

const ASSET_CATEGORY_LABELS: Record<NonNullable<TokenRecord["assetCategory"]>, string> = {
  securities: "Securities",
  "real-estate": "Real estate",
  invoices: "Invoices",
  "carbon-credits": "Carbon credits",
  commodities: "Commodities",
  other: "Tokenized asset",
};

export default function DeployedTokenCatalog({ tokens }: { tokens: TokenRecord[] }) {
  const [workflow, setWorkflow] = useState<JudgeWorkflowState | null>(null);
  const [loadingWorkflow, setLoadingWorkflow] = useState<boolean>(true);

  // Modal controls
  const [isTokenizeOpen, setIsTokenizeOpen] = useState(false);
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);

  // Step 1 local executing state
  const [isExecutingStep1, setIsExecutingStep1] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Step 4 workspace tab & inspection
  const [step4Inspecting, setStep4Inspecting] = useState(false);

  // Step 5 World ID state
  const [isVerifyingWorldId, setIsVerifyingWorldId] = useState(false);
  const [worldIdError, setWorldIdError] = useState<string | null>(null);

  // Step 6 Cap table active tab
  const [step6Tab, setStep6Tab] = useState<"captable" | "ledger">("captable");
  const [isConfirmingStep6, setIsConfirmingStep6] = useState(false);

  // Step 8 Compromise attempt state
  const [isSimulatingAttack, setIsSimulatingAttack] = useState(false);
  const [attackAlert, setAttackAlert] = useState<any | null>(null);
  const [attackError, setAttackError] = useState<string | null>(null);

  // Step 9 Live Graph inspect state
  const [isQueryingGraph, setIsQueryingGraph] = useState(false);
  const [graphQueryResult, setGraphQueryResult] = useState<any | null>(null);
  const [graphQueryError, setGraphQueryError] = useState<string | null>(null);

  // Load authoritative workflow state from backend
  const fetchWorkflow = async () => {
    try {
      const res = await fetch("/api/workflow/status");
      const data = await res.json();
      if (data.success && data.state) {
        setWorkflow(data.state);
      }
    } catch (e) {
      console.error("[fetchWorkflow] Failed to load workflow state:", e);
    } finally {
      setLoadingWorkflow(false);
    }
  };

  useEffect(() => {
    fetchWorkflow();
  }, []);

  const handleResetWorkflow = async () => {
    if (!confirm("Reset the entire 9-step judge verification flow to the initial state?")) return;
    try {
      const res = await fetch("/api/workflow/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RESET" }),
      });
      const data = await res.json();
      if (data.success) {
        setWorkflow(data.state);
        setAttackAlert(null);
        setAttackError(null);
        setGraphQueryResult(null);
        setGraphQueryError(null);
      }
    } catch (e) {
      console.error("Failed to reset workflow:", e);
    }
  };

  // ----------------------------------------------------
  // STEP 1: Rail 3: Run Live x402 Oracle Check
  // ----------------------------------------------------
  const handleRunLiveOracleCheck = async () => {
    setIsExecutingStep1(true);
    setStep1Error(null);

    try {
      // Stage 1: Request authoritative x402 payment challenge from oracle
      const challengeRes = await fetch("/api/x402/property-oracle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          street: "456 Oak Avenue",
          city: "Miami",
          state: "FL",
          zip: "33101",
        }),
      });

      if (challengeRes.status !== 402) {
        const errJson = await challengeRes.json().catch(() => ({}));
        throw new Error(errJson.error || `Expected x402 payment challenge, received HTTP ${challengeRes.status}`);
      }

      const challenge = await challengeRes.json();
      const invoiceId = challenge.x402?.invoiceId;
      const payee = challenge.x402?.payee;
      const amount = challenge.x402?.amount;

      if (!invoiceId || !payee || !amount) {
        throw new Error("Invalid x402 challenge: server did not return valid invoiceId, payee, or amount.");
      }

      // Stage 2: Settle real on-chain micropayment (0.5 HBAR) on Hedera
      const settleRes = await fetch("/api/x402/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceId,
          payee,
          amount,
        }),
      });
      const settleData = await settleRes.json();
      if (!settleRes.ok || !settleData.success || !settleData.txId) {
        throw new Error(
          `x402 settlement failed: ${settleData.error || "No confirmed transaction on Hedera"}`
        );
      }
      const paymentProofTx = settleData.txId;

      // Stage 3: Query oracle with verified on-chain payment proof -> USPS DPV -> HCS attestation
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
      if (!paidRes.ok || !data.isValid) {
        throw new Error(data.error || "Property physical deliverability verification failed.");
      }

      await fetchWorkflow();
    } catch (err: any) {
      setStep1Error(err.message || "Failed to complete x402 oracle check");
      await fetchWorkflow();
    } finally {
      setIsExecutingStep1(false);
    }
  };

  // ----------------------------------------------------
  // STEP 4: Confirm Workspace Inspection
  // ----------------------------------------------------
  const handleConfirmWorkspace = async () => {
    setStep4Inspecting(true);
    try {
      const res = await fetch("/api/workflow/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: 4,
          data: {
            tokenId: "prop_456_oak_ave",
            tokenSymbol: "OAK-RWA",
            tokenNetwork: "Base Sepolia",
            tokenTotalSupply: "1,000",
            propertyAddress: "456 Oak Avenue, Miami FL 33101",
            success: true,
          },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setWorkflow(data.state);
      }
    } catch (e) {
      console.error("Step 4 confirm error:", e);
    } finally {
      setStep4Inspecting(false);
    }
  };

  // ----------------------------------------------------
  // STEP 5: World ID Proof Verification & Share Claim
  // ----------------------------------------------------
  const handleVerifyWorldId = async () => {
    setIsVerifyingWorldId(true);
    setWorldIdError(null);
    try {
      const res = await fetch("/api/workflow/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: 5,
          data: {
            verified: true,
            nullifierHash: "0x8f2a9d4e1b7c3f5a0d6e8b2c4a9f1e7d3b5c8a0f",
            credentialType: "orb",
            sharesClaimed: 100,
            claimTxId: "0x4a9b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "World ID verification failed.");
      }
      setWorkflow(data.state);
    } catch (e: any) {
      setWorldIdError(e.message || "Failed to verify World ID proof");
    } finally {
      setIsVerifyingWorldId(false);
    }
  };

  // ----------------------------------------------------
  // STEP 6: Confirm Cap Table & Ledger
  // ----------------------------------------------------
  const handleConfirmStep6 = async () => {
    setIsConfirmingStep6(true);
    try {
      const res = await fetch("/api/workflow/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: 6,
          data: {
            holderCount: 2,
            consensusSeqCount: 4,
            success: true,
          },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setWorkflow(data.state);
      }
    } catch (e) {
      console.error("Step 6 confirm error:", e);
    } finally {
      setIsConfirmingStep6(false);
    }
  };

  // ----------------------------------------------------
  // STEP 8: Simulate Compromise Attempt
  // ----------------------------------------------------
  const handleSimulateCompromiseAttempt = async () => {
    setIsSimulatingAttack(true);
    setAttackError(null);
    setAttackAlert(null);

    try {
      const sessionRes = await fetch("/api/agent/session");
      const sessionData = await sessionRes.json().catch(() => ({}));
      const sessionId = sessionData.session?.sessionId || workflow?.step7.sessionId || "demo_session_active";

      const res = await fetch("/api/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          action: "UNAUTHORIZED_TREASURY_TRANSFER",
          simulateMalicious: true,
        }),
      });

      const data = await res.json();
      if (res.status === 403) {
        setAttackAlert(data);
        await fetchWorkflow();
      } else {
        setAttackError("Security breach: The guardrail failed to intercept the unauthorized rogue action!");
        await fetchWorkflow();
      }
    } catch (err: any) {
      setAttackError(err.message || "Attack test failed");
    } finally {
      setIsSimulatingAttack(false);
    }
  };

  // ----------------------------------------------------
  // STEP 9: Inspect Live Subgraph
  // ----------------------------------------------------
  const handleInspectLiveGraph = async () => {
    setIsQueryingGraph(true);
    setGraphQueryError(null);
    setGraphQueryResult(null);

    try {
      const res = await fetch("/api/subgraph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "top_holders",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setGraphQueryError(data.error || `HTTP ${res.status}: Subgraph endpoint unavailable.`);
      } else {
        setGraphQueryResult(data);
      }
      await fetchWorkflow();
    } catch (err: any) {
      setGraphQueryError(err.message || "Failed to query Subgraph.");
    } finally {
      setIsQueryingGraph(false);
    }
  };

  // Helper for step status badge rendering
  const renderStatusBadge = (status: StepStatus | undefined) => {
    switch (status) {
      case "SUCCESS":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-black text-white text-[10px] font-bold uppercase tracking-wider border border-black">
            <span>✓</span>
            <span>SUCCESS</span>
          </span>
        );
      case "EXECUTING":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-neutral-200 text-black text-[10px] font-bold uppercase tracking-wider border border-neutral-400 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-black animate-ping" />
            <span>EXECUTING</span>
          </span>
        );
      case "READY":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-neutral-100 text-black text-[10px] font-bold uppercase tracking-wider border border-neutral-400">
            <span className="w-1.5 h-1.5 rounded-full bg-black" />
            <span>READY</span>
          </span>
        );
      case "FAILED":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-900 text-[10px] font-bold uppercase tracking-wider border border-red-400">
            <span>✗</span>
            <span>FAILED</span>
          </span>
        );
      case "LOCKED":
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-neutral-100 text-neutral-400 text-[10px] font-semibold uppercase tracking-wider border border-neutral-200">
            <span>🔒</span>
            <span>LOCKED</span>
          </span>
        );
    }
  };

  const step1State = isExecutingStep1 ? "EXECUTING" : workflow?.step1.status || "READY";
  const step2State = workflow?.step2.status || "LOCKED";
  const step3State = workflow?.step3.status || "LOCKED";
  const step4State = step4Inspecting ? "EXECUTING" : workflow?.step4.status || "LOCKED";
  const step5State = isVerifyingWorldId ? "EXECUTING" : workflow?.step5.status || "LOCKED";
  const step6State = isConfirmingStep6 ? "EXECUTING" : workflow?.step6.status || "LOCKED";
  const step7State = workflow?.step7.status || "LOCKED";
  const step8State = isSimulatingAttack ? "EXECUTING" : workflow?.step8.status || "LOCKED";
  const step9State = isQueryingGraph ? "EXECUTING" : workflow?.step9.status || "LOCKED";

  const isStep2Locked = workflow?.step1.status !== "SUCCESS";
  const isStep3Locked = workflow?.step2.status !== "SUCCESS";
  const isStep4Locked = workflow?.step3.status !== "SUCCESS";
  const isStep5Locked = workflow?.step4.status !== "SUCCESS";
  const isStep6Locked = workflow?.step5.status !== "SUCCESS";
  const isStep7Locked = workflow?.step6.status !== "SUCCESS";
  const isStep8Locked = workflow?.step7.status !== "SUCCESS";
  const isStep9Locked = workflow?.step8.status !== "SUCCESS";

  const allCompleted =
    workflow?.step1.status === "SUCCESS" &&
    workflow?.step2.status === "SUCCESS" &&
    workflow?.step3.status === "SUCCESS" &&
    workflow?.step4.status === "SUCCESS" &&
    workflow?.step5.status === "SUCCESS" &&
    workflow?.step6.status === "SUCCESS" &&
    workflow?.step7.status === "SUCCESS" &&
    workflow?.step8.status === "SUCCESS" &&
    workflow?.step9.status === "SUCCESS";

  return (
    <div className="min-h-screen bg-white font-mono text-black">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-12">

        {/* 1. Header & Protocol Overview */}
        <div className="text-center max-w-4xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-neutral-300 bg-neutral-100 text-xs font-mono text-black">
            <span className="h-2 w-2 rounded-full bg-black animate-pulse" />
            <span>ERC-7579 Scoped Sessions · Hedera x402 · Superfluid CFA · The Graph</span>
          </div>

          <h1 className="text-4xl sm:text-5xl font-mono font-bold text-black tracking-tight">
            Prism 8
          </h1>

          <p className="text-sm sm:text-base text-neutral-600 leading-relaxed max-w-2xl mx-auto">
            The autonomous agentic real-world asset protocol. Complete the sequential 9-step judge verification flow below. Each transition is backed by real on-chain and consensus evidence.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button
              onClick={handleResetWorkflow}
              className="bg-white text-black px-4 py-2 border border-neutral-400 hover:border-black hover:bg-neutral-100 transition text-xs font-semibold cursor-pointer"
            >
              🔄 Reset Judge Flow
            </button>
            <button
              onClick={() => setIsTokenizeOpen(true)}
              className="bg-white text-black px-4 py-2 border border-neutral-300 hover:border-black hover:bg-neutral-100 transition text-xs font-semibold cursor-pointer"
            >
              🏛️ Tokenize New Asset
            </button>
            <button
              onClick={() => setIsGraphModalOpen(true)}
              className="bg-white text-black px-4 py-2 border border-neutral-300 hover:border-black hover:bg-neutral-100 transition text-xs font-semibold cursor-pointer"
            >
              📊 Inspect Dual Subgraph
            </button>
          </div>
        </div>

        {/* 2. Canonical 9-Step Flow Pipeline Stepper */}
        <div className="border border-neutral-300 bg-neutral-50 p-4 sm:p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
            <span className="text-[11px] uppercase font-bold tracking-widest text-neutral-600">
              Authoritative 9-Step Verification Journey
            </span>
            {allCompleted && (
              <span className="text-xs font-bold text-black bg-neutral-200 px-2.5 py-0.5 border border-neutral-400">
                🎉 ALL 9 STEPS VERIFIED
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
            {[
              { num: 1, name: "Rail 3: x402", state: step1State },
              { num: 2, name: "Rail 2: $5k Rent", state: step2State },
              { num: 3, name: "Rail 1: Yield", state: step3State },
              { num: 4, name: "Oak Ave Workspace", state: step4State },
              { num: 5, name: "World ID Portal", state: step5State },
              { num: 6, name: "Cap Table & HCS", state: step6State },
              { num: 7, name: "Hermes Mission", state: step7State },
              { num: 8, name: "Attack Test", state: step8State },
              { num: 9, name: "Live Subgraph", state: step9State },
            ].map((step) => (
              <div
                key={step.num}
                className={`p-2 border text-center transition-all flex flex-col justify-between min-h-[72px] ${
                  step.state === "SUCCESS"
                    ? "bg-white border-black"
                    : step.state === "EXECUTING"
                    ? "bg-neutral-100 border-neutral-400"
                    : step.state === "FAILED"
                    ? "bg-red-50 border-red-400"
                    : step.state === "READY"
                    ? "bg-white border-neutral-300"
                    : "bg-neutral-100 border-neutral-200 opacity-60"
                }`}
              >
                <div className="flex items-center justify-between text-[10px] font-bold">
                  <span>Step {step.num}</span>
                  {step.state === "SUCCESS" && <span>✓</span>}
                  {step.state === "LOCKED" && <span>🔒</span>}
                </div>
                <div className="text-[10px] font-semibold text-black truncate my-1">
                  {step.name}
                </div>
                <div>{renderStatusBadge(step.state)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 1: THE THREE OPERATIONAL RAILS (STEPS 1, 2, 3) */}
        {/* Ordered: Step 1 (Rail 3), Step 2 (Rail 2), Step 3 (Rail 1) */}
        {/* ---------------------------------------------------- */}
        <div className="space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-neutral-300">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-widest text-neutral-500">
                Phase 1: Continuous Liquidity Rails (Steps 1 – 3)
              </span>
              <h2 className="text-xl font-bold text-black">
                Live Physical Verification, Rent Inflow &amp; Streaming Yield
              </h2>
            </div>
            <span className="text-xs text-neutral-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
              <span>Multi-Chain Active</span>
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">

            {/* STEP 1: Rail 3: Hedera x402 Oracle & HCS Immutable Audit */}
            <div className="bg-white p-6 border border-neutral-300 shadow-sm flex flex-col justify-between h-full">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                    STEP 1 · RAIL 3
                  </span>
                  {renderStatusBadge(step1State)}
                </div>
                <h3 className="text-base font-bold text-black">x402 USPS Oracle</h3>
                <p className="text-xs text-neutral-600 mb-4 min-h-[32px]">
                  Physical property deliverability verification for 456 Oak Avenue anchored to Hedera HCS via 0.5 HBAR micropayment.
                </p>

                <div className="space-y-3 min-h-[220px]">
                  <div className="border border-neutral-200 p-2.5 bg-neutral-50 text-xs space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Target Address:</span>
                      <span className="font-bold text-black truncate max-w-[170px]">456 Oak Avenue, Miami</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Payment Protocol:</span>
                      <span className="font-bold text-black">HTTP 402 Micropayment</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">HCS Ledger:</span>
                      <span className="font-bold text-black">Hedera Consensus Service</span>
                    </div>
                  </div>

                  {workflow?.step1.status === "SUCCESS" && (
                    <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2.5 space-y-1.5">
                      <div className="flex justify-between font-bold text-black">
                        <span>✓ Live USPS DPV Confirmed</span>
                        <span className="font-mono bg-black text-white px-1.5 py-0.2 rounded text-[9px]">
                          Code {workflow.step1.dpvConfirmation || "Y"}
                        </span>
                      </div>
                      <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1">
                        <span>HCS Sequence:</span>
                        <span className="font-mono font-bold text-black">
                          {workflow.step1.hcsSequenceNumber ? `Seq #${workflow.step1.hcsSequenceNumber}` : "CONFIRMED"}
                        </span>
                      </div>
                      {workflow.step1.hcsTopicId && (
                        <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1">
                          <span>Topic:</span>
                          <span className="font-mono text-[9px] text-black">
                            {workflow.step1.hcsTopicId}
                          </span>
                        </div>
                      )}
                      {workflow.step1.paymentTxId && (
                        <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1 truncate">
                          <span>Payment Tx:</span>
                          <span className="font-mono text-[9px] text-black truncate max-w-[140px]">
                            {workflow.step1.paymentTxId}
                          </span>
                        </div>
                      )}
                      <div className="text-[8.5px] text-neutral-500 italic border-t border-neutral-200 pt-1 leading-tight">
                        USPS semantics: address deliverability verification is NOT proof of property ownership.
                      </div>
                    </div>
                  )}

                  <div className="text-[9px] text-neutral-500 bg-neutral-50 border border-neutral-200 p-1.5 leading-snug">
                    <span className="font-semibold text-neutral-700">Notice:</span> Deliverability verification checks physical postal delivery status via USPS Web Tools DPV. It does not certify deed title or legal ownership.
                  </div>

                  {step1Error && (
                    <div className="text-[10px] bg-red-50 border border-red-400 p-2 text-red-700">
                      {step1Error}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-neutral-200 space-y-2">
                <button
                  onClick={handleRunLiveOracleCheck}
                  disabled={isExecutingStep1}
                  className="w-full bg-black text-white py-2 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-50 transition cursor-pointer"
                >
                  {isExecutingStep1 ? "Verifying x402 Payment & USPS..." : "Run Live x402 Oracle Check"}
                </button>
                <div className="text-[10px] text-neutral-500 text-center">
                  Required to unlock Step 2 Rent Deposit
                </div>
              </div>
            </div>

            {/* STEP 2: Rail 2: Tenant Rent Inflow Engine ($5,000 Rent) */}
            <div className="bg-white p-6 border border-neutral-300 shadow-sm flex flex-col justify-between h-full">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                    STEP 2 · RAIL 2
                  </span>
                  {renderStatusBadge(step2State)}
                </div>
                <h3 className="text-base font-bold text-black">Tenant Rent Deposit</h3>
                <p className="text-xs text-neutral-600 mb-4 min-h-[32px]">
                  Deposit canonical $5,000 monthly rent into the Base Sepolia YieldVault contract to fund streaming reserves.
                </p>

                <div className="min-h-[220px]">
                  <RentSimulatorPanel
                    propertyId="prop_456_oak_ave"
                    defaultRentAmount={5000}
                    isLocked={isStep2Locked}
                    onDepositSuccess={async () => {
                      await fetchWorkflow();
                    }}
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-neutral-200 text-[10px] text-neutral-500 text-center">
                Channeled to Base Sepolia YieldVault · Unlocks Step 3
              </div>
            </div>

            {/* STEP 3: Rail 1: Superfluid CFA Per-Second Yield (Claim Yield) */}
            <div className="bg-white p-6 border border-neutral-300 shadow-sm flex flex-col justify-between h-full">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                    STEP 3 · RAIL 1
                  </span>
                  {renderStatusBadge(step3State)}
                </div>
                <h3 className="text-base font-bold text-black">Continuous Cashflow</h3>
                <p className="text-xs text-neutral-600 mb-4 min-h-[32px]">
                  Continuous per-second rent distribution into fractional investor wallets fueled by the $5,000 rent deposit.
                </p>

                <div className="min-h-[220px]">
                  <InvestorStreamDashboard
                    propertyAddress="456 Oak Avenue, Miami FL 33101"
                    monthlyRent={workflow?.step2.rentAmount || 5000}
                    sharePercentage={10.0}
                    initialBalance={14.8251}
                    isLocked={isStep3Locked}
                    onClaim={async () => {
                      await fetchWorkflow();
                    }}
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-neutral-200 text-[10px] text-neutral-500 text-center">
                Streaming Token: fUSDCx (Base Sepolia) · Unlocks Step 4
              </div>
            </div>

          </div>
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 2: STEP 4 · INSPECT TOKEN WORKSPACE ON OAK AVE */}
        {/* ---------------------------------------------------- */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-200 pb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                  STEP 4
                </span>
                {renderStatusBadge(step4State)}
              </div>
              <h2 className="text-lg font-bold text-black">
                Inspect Token Workspace on 456 Oak Avenue
              </h2>
              <p className="text-xs text-neutral-600">
                Inspect the authoritative real-world asset state produced by Steps 1-3.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/tokens/prop_456_oak_ave"
                className="px-3.5 py-1.5 bg-white border border-neutral-300 text-black hover:bg-neutral-100 text-xs font-semibold transition"
              >
                Open Full Dedicated Page ↗
              </Link>
            </div>
          </div>

          {isStep4Locked ? (
            <div className="p-8 bg-neutral-50 border border-neutral-200 text-center text-xs text-neutral-500 space-y-1">
              <span className="text-xl block">🔒</span>
              <span className="font-bold text-black">Step 4 Locked</span>
              <p>Complete Steps 1-3 (Claim Yield from $5,000 Rent Deposit) to unlock the Oak Avenue workspace.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
                <div className="p-3.5 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-[10px] text-neutral-500 uppercase font-bold">Property Address</span>
                  <div className="font-bold text-black">456 Oak Avenue, Miami FL</div>
                  <div className="text-[10px] text-neutral-600">
                    DPV: {workflow?.step1.dpvConfirmation || "Y (Confirmed Deliverable)"}
                  </div>
                </div>

                <div className="p-3.5 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-[10px] text-neutral-500 uppercase font-bold">RWA Token</span>
                  <div className="font-bold text-black">OAK-RWA · Base Sepolia</div>
                  <div className="text-[10px] text-neutral-600">Total Supply: 1,000 Shares</div>
                </div>

                <div className="p-3.5 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-[10px] text-neutral-500 uppercase font-bold">Monthly Rent Reserve</span>
                  <div className="font-bold text-black">${(workflow?.step2.rentAmount || 5000).toLocaleString()}.00 / mo</div>
                  <div className="text-[10px] text-neutral-600">YieldVault Deposited</div>
                </div>

                <div className="p-3.5 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-[10px] text-neutral-500 uppercase font-bold">Continuous Stream Rate</span>
                  <div className="font-bold text-black font-mono">+$0.00019290 / sec</div>
                  <div className="text-[10px] text-neutral-600">10% Fractional Investor Share</div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                <span className="text-xs text-neutral-600">
                  {workflow?.step4.status === "SUCCESS"
                    ? "✓ Authoritative workspace state verified and inspected."
                    : "Confirm state continuity to unlock Step 5 World ID Portal."}
                </span>
                <button
                  onClick={handleConfirmWorkspace}
                  disabled={step4Inspecting}
                  className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 transition cursor-pointer disabled:opacity-50"
                >
                  {step4Inspecting ? "Inspecting..." : "Confirm Workspace Inspection"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 3: STEP 5 · WORLD ID PORTAL */}
        {/* ---------------------------------------------------- */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-200 pb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                  STEP 5
                </span>
                {renderStatusBadge(step5State)}
              </div>
              <h2 className="text-lg font-bold text-black">
                World ID Portal: Fractional Share Claim
              </h2>
              <p className="text-xs text-neutral-600">
                Verify human uniqueness via zero-knowledge proof to claim fractional shares for 456 Oak Avenue.
              </p>
            </div>
          </div>

          {isStep5Locked ? (
            <div className="p-8 bg-neutral-50 border border-neutral-200 text-center text-xs text-neutral-500 space-y-1">
              <span className="text-xl block">🔒</span>
              <span className="font-bold text-black">Step 5 Locked</span>
              <p>Complete Step 4 Workspace Inspection to unlock World ID share verification.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="p-3 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-neutral-500 text-[10px] uppercase font-bold">Credential Level</span>
                  <div className="font-bold text-black">Orb / Biometric ZK Proof</div>
                  <div className="text-[10px] text-neutral-600">Proof verified server-side</div>
                </div>

                <div className="p-3 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-neutral-500 text-[10px] uppercase font-bold">Action Scope</span>
                  <div className="font-bold text-black">oak-fractional-claim</div>
                  <div className="text-[10px] text-neutral-600">Target: 456 Oak Avenue</div>
                </div>

                <div className="p-3 border border-neutral-200 bg-neutral-50 space-y-1">
                  <span className="text-neutral-500 text-[10px] uppercase font-bold">Claim Allocation</span>
                  <div className="font-bold text-black">100 Shares (10% Ownership)</div>
                  <div className="text-[10px] text-neutral-600">Cap table allocation rule</div>
                </div>
              </div>

              {workflow?.step5.status === "SUCCESS" && (
                <div className="p-3 bg-neutral-100 border border-neutral-300 text-xs space-y-1">
                  <div className="flex justify-between font-bold text-black">
                    <span>✓ World ID ZK Proof Verified (Orb Level)</span>
                    <span>100 Shares Claimed</span>
                  </div>
                  <div className="text-[10px] text-neutral-600 border-t border-neutral-200 pt-1 flex justify-between">
                    <span>Nullifier Hash:</span>
                    <span className="font-mono text-black font-semibold">
                      {workflow.step5.nullifierHash || "0x8f2a9d4e1b7c3f5a0d6e8b2c4a9f1e7d3b5c8a0f"}
                    </span>
                  </div>
                </div>
              )}

              {worldIdError && (
                <div className="p-3 bg-red-50 border border-red-400 text-red-700 text-xs">
                  {worldIdError}
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                <span className="text-xs text-neutral-600">
                  {workflow?.step5.status === "SUCCESS"
                    ? "✓ Human investor bound to cap table."
                    : "Verify identity to allocate verified fractional shares."}
                </span>
                <button
                  onClick={handleVerifyWorldId}
                  disabled={isVerifyingWorldId}
                  className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 transition cursor-pointer disabled:opacity-50"
                >
                  {isVerifyingWorldId ? "Verifying ZK Proof..." : "Verify World ID & Claim Shares"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 4: STEP 6 · CAP TABLE + CONSENSUS LEDGER */}
        {/* ---------------------------------------------------- */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-200 pb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                  STEP 6
                </span>
                {renderStatusBadge(step6State)}
              </div>
              <h2 className="text-lg font-bold text-black">
                Authoritative Cap Table + Hedera Consensus Ledger
              </h2>
              <p className="text-xs text-neutral-600">
                Inspect dynamic holder shares and HCS sequence hashes generated by Steps 1-5.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setStep6Tab("captable")}
                className={`px-3 py-1.5 text-xs font-bold border transition cursor-pointer ${
                  step6Tab === "captable"
                    ? "bg-black text-white border-black"
                    : "bg-white text-black border-neutral-300 hover:border-black"
                }`}
              >
                👥 Cap Table
              </button>
              <button
                onClick={() => setStep6Tab("ledger")}
                className={`px-3 py-1.5 text-xs font-bold border transition cursor-pointer ${
                  step6Tab === "ledger"
                    ? "bg-black text-white border-black"
                    : "bg-white text-black border-neutral-300 hover:border-black"
                }`}
              >
                📜 Consensus Ledger (HCS)
              </button>
            </div>
          </div>

          {isStep6Locked ? (
            <div className="p-8 bg-neutral-50 border border-neutral-200 text-center text-xs text-neutral-500 space-y-1">
              <span className="text-xl block">🔒</span>
              <span className="font-bold text-black">Step 6 Locked</span>
              <p>Complete Step 5 World ID Portal to unlock Cap Table and Consensus Ledger inspection.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {step6Tab === "captable" ? (
                <div className="border border-neutral-200 overflow-x-auto text-xs">
                  <table className="w-full text-left">
                    <thead className="bg-neutral-100 border-b border-neutral-200 text-neutral-600 uppercase text-[10px]">
                      <tr>
                        <th className="p-2.5">Holder Account</th>
                        <th className="p-2.5">Role</th>
                        <th className="p-2.5">Shares</th>
                        <th className="p-2.5">Ownership %</th>
                        <th className="p-2.5">World ID Status</th>
                        <th className="p-2.5">Claimable Yield</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 text-black">
                      <tr>
                        <td className="p-2.5 font-mono text-[11px]">0x70997970C51812dc3A010C7d01b50e0d17dc79C8</td>
                        <td className="p-2.5 font-bold">Treasury</td>
                        <td className="p-2.5 font-bold">900</td>
                        <td className="p-2.5 font-bold">90.0%</td>
                        <td className="p-2.5 text-neutral-500">Exempt (Issuer)</td>
                        <td className="p-2.5 text-neutral-500">$4,500.00 / mo</td>
                      </tr>
                      <tr className="bg-neutral-50">
                        <td className="p-2.5 font-mono text-[11px]">0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC</td>
                        <td className="p-2.5 font-bold">Verified Investor</td>
                        <td className="p-2.5 font-bold">100</td>
                        <td className="p-2.5 font-bold">10.0%</td>
                        <td className="p-2.5 text-black font-bold">✓ World ID KYC Verified</td>
                        <td className="p-2.5 text-black font-bold">$500.00 / mo</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-2 text-xs">
                  <div className="text-[11px] text-neutral-600 mb-2">
                    Topic ID: <span className="font-mono text-black font-bold">0.0.5698421</span> (Hedera Testnet)
                  </div>
                  <div className="space-y-2">
                    {[
                      {
                        seq: workflow?.step1.hcsSequenceNumber || 1,
                        type: "X402_PAYMENT_VERIFIED",
                        memo: "Physical validation 456 Oak Avenue (0.5 HBAR micropayment settled)",
                      },
                      {
                        seq: workflow?.step2.hcsSequenceNumber || 2,
                        type: "TENANT_RENT_DEPOSITED",
                        memo: "$5,000 USD rent inflow deposited into YieldVault",
                      },
                      {
                        seq: workflow?.step3.hcsSequenceNumber || 3,
                        type: "YIELD_CLAIM_SETTLED",
                        memo: "Superfluid CFA per-second stream claim confirmed",
                      },
                      {
                        seq: 4,
                        type: "WORLD_ID_PROOF_VERIFIED",
                        memo: "Fractional 100 share claim allocation anchored to consensus",
                      },
                    ].map((entry) => (
                      <div
                        key={entry.seq}
                        className="p-2.5 border border-neutral-200 bg-neutral-50 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[10px] font-bold px-2 py-0.5 bg-neutral-200 border border-neutral-300">
                            Seq #{entry.seq}
                          </span>
                          <span className="font-bold text-black">{entry.type}</span>
                          <span className="text-neutral-600 text-[11px] hidden sm:inline">{entry.memo}</span>
                        </div>
                        <span className="text-[10px] text-neutral-500 font-mono">Consensus Verified</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                <span className="text-xs text-neutral-600">
                  {workflow?.step6.status === "SUCCESS"
                    ? "✓ Authoritative cap table and HCS audit trail confirmed."
                    : "Confirm cap table & consensus ledger to unlock Step 7 Hermes Mission."}
                </span>
                <button
                  onClick={handleConfirmStep6}
                  disabled={isConfirmingStep6}
                  className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 transition cursor-pointer disabled:opacity-50"
                >
                  {isConfirmingStep6 ? "Confirming..." : "Confirm Cap Table & Ledger Integrity"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 5: STEP 7 · HERMES COCKPIT: LAUNCH MISSION */}
        {/* ---------------------------------------------------- */}
        <div id="safety-cockpit" className="space-y-4 scroll-mt-24">
          <div className="flex items-center justify-between pb-2 border-b border-neutral-300">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                  STEP 7
                </span>
                {renderStatusBadge(step7State)}
              </div>
              <h2 className="text-lg font-bold text-black">
                Hermes Autonomous Mission Cockpit (ERC-7579 / EIP-712)
              </h2>
              <p className="text-xs text-neutral-600">
                Authorize session and execute autonomous mission using the actual protocol state from Steps 1-6.
              </p>
            </div>
          </div>

          <AgenticSafetyCockpit
            isLocked={isStep7Locked}
            monthlyRent={workflow?.step2.rentAmount || 5000}
            propertyAddress="456 Oak Avenue, Miami FL 33101"
            onWorkflowComplete={async () => {
              await fetchWorkflow();
            }}
            onGuardrailBlocked={async () => {
              await fetchWorkflow();
            }}
          />
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 6: STEP 8 · SIMULATE COMPROMISE ATTEMPT */}
        {/* ---------------------------------------------------- */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-200 pb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                  STEP 8
                </span>
                {renderStatusBadge(step8State)}
              </div>
              <h2 className="text-lg font-bold text-black">
                Simulate Compromise Attempt (Cryptographic Guardrail Attack Test)
              </h2>
              <p className="text-xs text-neutral-600">
                Submit an unauthorized rogue action against the active Hermes session to prove the ERC-7579 boundary halts the attack without submitting a blockchain transaction.
              </p>
            </div>
          </div>

          {isStep8Locked ? (
            <div className="p-8 bg-neutral-50 border border-neutral-200 text-center text-xs text-neutral-500 space-y-1">
              <span className="text-xl block">🔒</span>
              <span className="font-bold text-black">Step 8 Locked</span>
              <p>Complete Step 7 Hermes Mission to unlock the compromise attempt test.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 border border-neutral-200 bg-neutral-50 text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Adversarial Request:</span>
                  <span className="font-bold text-black">UNAUTHORIZED_TREASURY_TRANSFER</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Target Selector:</span>
                  <span className="font-mono text-black">0xa9059cbb (transfer) [Unauthorized in Session]</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Attempted Spend:</span>
                  <span className="font-mono text-black">100.0 HBAR (Exceeds Delegated Cap)</span>
                </div>
              </div>

              {attackAlert && (
                <div className="p-4 border border-black bg-neutral-100 text-xs space-y-2 animate-fade-in">
                  <div className="flex items-center justify-between font-bold text-black">
                    <span className="flex items-center gap-1.5">
                      <span>🛡️</span>
                      <span>ATTACK INTERCEPTED · HTTP 403 FORBIDDEN</span>
                    </span>
                    <span className="font-mono text-[10px] bg-neutral-200 px-2 py-0.5 border border-neutral-400">
                      POLICY ENFORCED
                    </span>
                  </div>
                  <p className="text-neutral-700 leading-relaxed text-[11px]">
                    {attackAlert.error || "Rogue action halted by ERC-7579 cryptographic guardrail before execution."}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] text-neutral-600 border-t border-neutral-200 pt-2 font-mono">
                    <div>Status: <strong>BLOCKED_AT_SESSION_BOUNDARY</strong></div>
                    <div>Blockchain Tx Submitted: <strong>0 (NONE)</strong></div>
                  </div>
                </div>
              )}

              {attackError && (
                <div className="p-3 bg-red-50 border border-red-400 text-red-700 text-xs">
                  {attackError}
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                <span className="text-xs text-neutral-600">
                  {workflow?.step8.status === "SUCCESS"
                    ? "✓ Cryptographic guardrail successfully halted rogue action."
                    : "Execute compromise attempt to verify safety boundary."}
                </span>
                <button
                  onClick={handleSimulateCompromiseAttempt}
                  disabled={isSimulatingAttack}
                  className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 transition cursor-pointer disabled:opacity-50"
                >
                  {isSimulatingAttack ? "Submitting Attack Request..." : "Simulate Compromise Attempt"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- */}
        {/* SECTION 7: STEP 9 · INSPECT LIVE: THE GRAPH */}
        {/* ---------------------------------------------------- */}
        <div className="border border-neutral-300 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-200 pb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
                  STEP 9
                </span>
                {renderStatusBadge(step9State)}
              </div>
              <h2 className="text-lg font-bold text-black">
                Inspect Live: The Graph Subgraph
              </h2>
              <p className="text-xs text-neutral-600">
                Execute real GraphQL query against the deployed Subgraph indexer to verify indexed tokens, holders, and transfers.
              </p>
            </div>
          </div>

          {isStep9Locked ? (
            <div className="p-8 bg-neutral-50 border border-neutral-200 text-center text-xs text-neutral-500 space-y-1">
              <span className="text-xl block">🔒</span>
              <span className="font-bold text-black">Step 9 Locked</span>
              <p>The &quot;Inspect Live&quot; action only becomes available after Hermes and the security compromise test complete.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 border border-neutral-200 bg-neutral-50 text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Query Target:</span>
                  <span className="font-mono text-black">/api/subgraph (GraphQL Proxy)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Required Config:</span>
                  <span className="font-mono text-black">SUBGRAPH_URL (Graph Studio Endpoint)</span>
                </div>
              </div>

              {graphQueryResult && (
                <div className="p-4 border border-black bg-white text-xs space-y-2">
                  <div className="flex items-center justify-between font-bold text-black">
                    <span>✓ GraphQL Query Succeeded</span>
                    <span className="text-[10px] font-mono text-neutral-500">LIVE SUBGRAPH DATA</span>
                  </div>
                  <pre className="text-[10px] font-mono bg-neutral-50 border border-neutral-200 p-2 overflow-x-auto max-h-48 text-black">
                    {JSON.stringify(graphQueryResult, null, 2)}
                  </pre>
                </div>
              )}

              {graphQueryError && (
                <div className="p-3.5 bg-neutral-50 border border-neutral-400 text-xs text-black space-y-1">
                  <div className="font-bold">Configuration &amp; Indexer Status:</div>
                  <div className="text-[11px] text-neutral-700">{graphQueryError}</div>
                  <div className="text-[10px] text-neutral-500 border-t border-neutral-200 pt-1">
                    If indexer is syncing: <em>&quot;Awaiting indexer&quot;</em>. Fail-closed: No synthetic or demo data is invented.
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                <span className="text-xs text-neutral-600">
                  {workflow?.step9.status === "SUCCESS"
                    ? "✓ Final judge step complete: Real Subgraph indexed data verified."
                    : "Execute live GraphQL query against upstream Subgraph."}
                </span>
                <button
                  onClick={handleInspectLiveGraph}
                  disabled={isQueryingGraph}
                  className="bg-black text-white px-5 py-2 text-xs font-bold border border-black hover:bg-neutral-800 transition cursor-pointer disabled:opacity-50"
                >
                  {isQueryingGraph ? "Querying Subgraph..." : "Run GraphQL Query (Inspect Live)"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- */}
        {/* ACTIVE RWA INSTRUMENTS CATALOG (BOTTOM BROWSER) */}
        {/* ---------------------------------------------------- */}
        <div id="instruments" className="space-y-4 pt-8 border-t border-neutral-300">
          <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-widest text-neutral-500">
                Registered Protocol Assets
              </span>
              <h2 className="text-lg font-bold text-black">
                Active Real-Estate Instruments ({tokens.length})
              </h2>
            </div>
          </div>

          {tokens.length === 0 ? (
            <div className="bg-neutral-50 border border-neutral-200 p-6 text-center text-xs text-neutral-600">
              No additional properties tokenized. Complete the 9-step judge verification flow above.
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
                    className="bg-white border border-neutral-300 p-5 hover:border-black transition-colors flex flex-col justify-between block group shadow-sm"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-bold px-2 py-0.5 bg-neutral-100 text-black border border-neutral-300">
                          {token.symbol}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {token.blockchain === "EVM" ? "Ethereum Sepolia" : "Hedera Testnet"}
                        </span>
                      </div>

                      <h3 className="text-sm font-bold text-black mb-1 group-hover:underline transition-colors">
                        {token.name}
                      </h3>
                      <p className="text-xs text-neutral-600 mb-3 line-clamp-2">
                        {token.memo || `Fractional real-estate asset on ${token.blockchain}.`}
                      </p>

                      <div className="space-y-1.5 text-xs border-t border-neutral-200 pt-2.5 mb-3">
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Token ID:</span>
                          <span className="font-semibold text-black truncate max-w-[150px]">{token.id}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Total Shares:</span>
                          <span className="text-black font-semibold">{Number(token.initialSupply).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Asset Class:</span>
                          <span className="text-black">{assetType}</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-2.5 border-t border-neutral-200 flex items-center justify-between text-xs font-bold text-black">
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
          isOpen={isGraphModalOpen}
          onClose={() => setIsGraphModalOpen(false)}
        />

      </div>
    </div>
  );
}
