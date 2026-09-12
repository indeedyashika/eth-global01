"use client";

import React, { useState } from "react";

export interface RentSimulatorPanelProps {
  propertyId?: string;
  defaultRentAmount?: number;
  isLocked?: boolean;
  onDepositSuccess?: (amount: number, receipt: any) => void;
}

export type DepositPhase =
  | "IDLE"
  | "DEPOSIT_PENDING"
  | "TRANSACTION_SUBMITTED"
  | "TRANSACTION_CONFIRMED"
  | "DEPOSIT_CONFIRMED"
  | "ERROR";

export function RentSimulatorPanel({
  propertyId = "prop_456_oak_ave",
  isLocked = false,
  onDepositSuccess,
}: RentSimulatorPanelProps) {
  const [phase, setPhase] = useState<DepositPhase>("IDLE");
  const [depositResult, setDepositResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const CANONICAL_AMOUNT = 5000;
  const FLOW_RATE_PER_SEC = CANONICAL_AMOUNT / 2592000;

  const handleDepositRent = async () => {
    if (isLocked || phase === "DEPOSIT_PENDING" || phase === "TRANSACTION_SUBMITTED") return;
    setError(null);

    try {
      // Step 1: Deposit Pending
      setPhase("DEPOSIT_PENDING");

      // Give visual feedback for transaction preparation/submission
      const resPromise = fetch("/api/rent/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          amount: CANONICAL_AMOUNT,
          tenantName: "Acme Residential Tenant Corp",
        }),
      });

      // Brief transition to indicate broadcast
      setTimeout(() => {
        setPhase((p) => (p === "DEPOSIT_PENDING" ? "TRANSACTION_SUBMITTED" : p));
      }, 400);

      const res = await resPromise;
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Rent deposit failed on server");
      }

      // Step 3: Transaction Confirmed on-chain
      setPhase("TRANSACTION_CONFIRMED");

      // Step 4: Deposit Confirmed & Settled
      setTimeout(() => {
        setPhase("DEPOSIT_CONFIRMED");
        setDepositResult(data);
        if (onDepositSuccess) {
          onDepositSuccess(CANONICAL_AMOUNT, data);
        }
      }, 600);
    } catch (err: any) {
      setPhase("ERROR");
      setError(err.message || "Failed to execute $5,000 rent deposit");
    }
  };

  const steps = [
    {
      id: "DEPOSIT_PENDING",
      label: "Deposit Pending",
      active: phase === "DEPOSIT_PENDING",
      done: ["TRANSACTION_SUBMITTED", "TRANSACTION_CONFIRMED", "DEPOSIT_CONFIRMED"].includes(phase),
    },
    {
      id: "TRANSACTION_SUBMITTED",
      label: "Transaction Submitted",
      active: phase === "TRANSACTION_SUBMITTED",
      done: ["TRANSACTION_CONFIRMED", "DEPOSIT_CONFIRMED"].includes(phase),
    },
    {
      id: "TRANSACTION_CONFIRMED",
      label: "Transaction Confirmed",
      active: phase === "TRANSACTION_CONFIRMED",
      done: ["DEPOSIT_CONFIRMED"].includes(phase),
    },
    {
      id: "DEPOSIT_CONFIRMED",
      label: "Deposit Confirmed",
      active: phase === "DEPOSIT_CONFIRMED",
      done: phase === "DEPOSIT_CONFIRMED",
    },
  ];

  return (
    <div className="relative flex flex-col justify-between h-full font-mono text-black space-y-3">
      {isLocked && (
        <div className="absolute inset-0 bg-white/95 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center p-4 text-center border border-neutral-300">
          <span className="text-xl mb-1">🔒</span>
          <span className="text-xs font-bold text-black uppercase tracking-wider">Step 2 Locked</span>
          <p className="text-[11px] text-neutral-600 mt-1 max-w-[220px]">
            Complete Step 1 Live x402 Oracle Check to unlock real $5,000 rent deposit.
          </p>
        </div>
      )}

      {/* Top Status Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              phase === "DEPOSIT_CONFIRMED"
                ? "bg-black"
                : phase !== "IDLE" && phase !== "ERROR"
                ? "bg-black animate-pulse"
                : "bg-neutral-400"
            }`}
          />
          <span className="font-bold text-black">INFLOW ENGINE · RAIL 2</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black font-bold">
          Base Sepolia (84532)
        </span>
      </div>

      {/* Authoritative Rent Parameters */}
      <div className="bg-neutral-50 p-2.5 border border-neutral-200 space-y-1.5 text-[11px]">
        <div className="flex justify-between items-center">
          <span className="text-neutral-500">Canonical Rent:</span>
          <span className="font-bold text-black text-xs">$5,000.00 USD</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-neutral-500">Continuous Stream:</span>
          <span className="font-mono text-black">+${FLOW_RATE_PER_SEC.toFixed(6)}/sec</span>
        </div>
        <div className="flex justify-between items-center border-t border-neutral-200 pt-1 text-[10px]">
          <span className="text-neutral-500">Settlement Contract:</span>
          <span className="text-black font-bold truncate max-w-[160px]" title="YieldVault">
            YieldVault.sol
          </span>
        </div>
      </div>

      {/* 4-Phase Stepper */}
      <div className="bg-white border border-neutral-200 p-2 space-y-1">
        <div className="text-[9px] font-bold text-neutral-500 uppercase tracking-wider mb-1">
          Settlement Lifecycle
        </div>
        <div className="grid grid-cols-2 gap-1 text-[10px]">
          {steps.map((step, idx) => (
            <div
              key={step.id}
              className={`p-1.5 border text-left flex items-center gap-1.5 transition-colors ${
                step.done
                  ? "bg-neutral-100 border-black text-black font-bold"
                  : step.active
                  ? "bg-black text-white border-black font-bold"
                  : "bg-neutral-50 border-neutral-200 text-neutral-400"
              }`}
            >
              <span className="text-[9px]">{step.done ? "✓" : `${idx + 1}.`}</span>
              <span className="truncate">{step.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Deposit Action Trigger */}
      <div>
        <button
          onClick={handleDepositRent}
          disabled={
            isLocked ||
            phase === "DEPOSIT_PENDING" ||
            phase === "TRANSACTION_SUBMITTED" ||
            phase === "TRANSACTION_CONFIRMED" ||
            phase === "DEPOSIT_CONFIRMED"
          }
          className="w-full bg-black text-white py-2 px-3 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer flex items-center justify-center gap-2"
        >
          {phase === "DEPOSIT_PENDING" ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Deposit Pending...
            </>
          ) : phase === "TRANSACTION_SUBMITTED" ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Transaction Submitted...
            </>
          ) : phase === "TRANSACTION_CONFIRMED" ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Transaction Confirmed!
            </>
          ) : phase === "DEPOSIT_CONFIRMED" ? (
            "✓ $5,000 Rent Deposited & Settled"
          ) : (
            "Deposit $5,000 Rent"
          )}
        </button>
      </div>

      {/* Confirmation & Audit Receipts */}
      {depositResult ? (
        <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2 space-y-1">
          <div className="flex justify-between font-bold text-black">
            <span>✓ $5,000 Rent Settled</span>
            <span className="text-[9px] px-1 bg-black text-white">Step 3 Unlocked</span>
          </div>
          <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1">
            <span>BaseScan Tx:</span>
            <a
              href={depositResult.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-black font-bold underline truncate max-w-[130px]"
            >
              {depositResult.txHash?.slice(0, 10)}...
            </a>
          </div>
          <div className="flex justify-between text-neutral-600">
            <span>HCS Receipt:</span>
            <a
              href={depositResult.hcsAudit?.hashscanUrl || "#"}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-black font-bold underline"
            >
              {depositResult.hcsAudit?.sequenceNumber
                ? `Seq #${depositResult.hcsAudit.sequenceNumber}`
                : "Anchored"} ↗
            </a>
          </div>
        </div>
      ) : error ? (
        <div className="text-[10px] bg-red-50 border border-red-300 p-2 text-red-700">
          <div className="font-bold">Deposit Failed:</div>
          <div className="text-[9px] mt-0.5">{error}</div>
          <button
            onClick={() => setPhase("IDLE")}
            className="mt-1.5 px-2 py-0.5 bg-red-700 text-white text-[9px] font-bold"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="text-[10px] text-neutral-500 border-t border-neutral-200 pt-1 flex justify-between">
          <span>Authoritative Source:</span>
          <span className="text-black font-bold">Base Sepolia · YieldVault</span>
        </div>
      )}
    </div>
  );
}
