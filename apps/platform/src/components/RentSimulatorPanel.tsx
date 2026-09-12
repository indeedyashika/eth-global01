"use client";

import React, { useState } from "react";

export interface RentSimulatorPanelProps {
  propertyId?: string;
  defaultRentAmount?: number;
  isLocked?: boolean;
  onDepositSuccess?: (amount: number, receipt: any) => void;
}

export function RentSimulatorPanel({
  propertyId = "prop_456_oak_ave",
  defaultRentAmount = 5000,
  isLocked = false,
  onDepositSuccess,
}: RentSimulatorPanelProps) {
  const [rentAmount, setRentAmount] = useState<number>(defaultRentAmount);
  const [isDepositing, setIsDepositing] = useState<boolean>(false);
  const [depositResult, setDepositResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDepositRent = async () => {
    if (isLocked) return;
    setIsDepositing(true);
    setError(null);

    try {
      const res = await fetch("/api/rent/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          amount: rentAmount,
          tenantName: "Acme Residential Tenant Corp",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Deposit execution failed");
      }

      setDepositResult(data);
      if (onDepositSuccess) {
        onDepositSuccess(rentAmount, data);
      }
    } catch (err: any) {
      setError(err.message || "Failed to trigger rent deposit");
    } finally {
      setIsDepositing(false);
    }
  };

  return (
    <div className="relative flex flex-col justify-between h-full font-mono text-black space-y-3">
      {isLocked && (
        <div className="absolute inset-0 bg-white/90 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center p-4 text-center border border-neutral-300">
          <span className="text-xl mb-1">🔒</span>
          <span className="text-xs font-bold text-black uppercase tracking-wider">Step 2 Locked</span>
          <p className="text-[11px] text-neutral-600 mt-1 max-w-[200px]">
            Complete Step 1 Live x402 Oracle Check to unlock real rent deposit.
          </p>
        </div>
      )}

      {/* Top Status Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
          <span className="font-bold text-black">INFLOW ENGINE</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
          ACH → fUSDCx
        </span>
      </div>

      {/* Preset Amount Chips */}
      <div className="flex items-center justify-between gap-1 text-[11px]">
        <span className="text-neutral-500 text-[10px]">Presets:</span>
        <div className="flex gap-1.5">
          {[2500, 5000, 7500].map((amt) => (
            <button
              key={amt}
              type="button"
              disabled={isLocked}
              onClick={() => setRentAmount(amt)}
              className={`px-2 py-0.5 border text-[11px] transition cursor-pointer disabled:opacity-40 ${
                rentAmount === amt
                  ? "bg-black text-white border-black"
                  : "bg-white text-black border-neutral-300 hover:border-black"
              }`}
            >
              ${amt.toLocaleString()}
            </button>
          ))}
        </div>
      </div>

      {/* Deposit Input & Trigger */}
      <div className="bg-neutral-50 p-2.5 border border-neutral-200 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-2.5 top-1.5 text-neutral-500 text-xs">$</span>
            <input
              type="number"
              disabled={isLocked}
              value={rentAmount}
              onChange={(e) => setRentAmount(Number(e.target.value))}
              className="w-full bg-white border border-neutral-300 pl-6 pr-2 py-1.5 text-xs font-mono text-black focus:border-black focus:outline-none disabled:opacity-50"
              placeholder="5000"
            />
          </div>
          <button
            onClick={handleDepositRent}
            disabled={isLocked || isDepositing || rentAmount <= 0}
            className="bg-black text-white px-3 py-1.5 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer whitespace-nowrap"
          >
            {isDepositing ? "Depositing..." : `Deposit $${rentAmount.toLocaleString()} Rent`}
          </button>
        </div>
      </div>

      {/* Audit Confirmation Status */}
      {depositResult ? (
        <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2 space-y-1">
          <div className="flex justify-between font-bold text-black">
            <span>✓ ${depositResult.amountDeposited?.toLocaleString()} Inflow Deposited</span>
            <span>Flow Accelerated</span>
          </div>
          <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1">
            <span>HCS Receipt:</span>
            <span className="font-mono text-black font-bold">
              {depositResult.hcsAudit?.sequenceNumber ? `Seq #${depositResult.hcsAudit.sequenceNumber}` : "CONFIRMED"} ↗
            </span>
          </div>
        </div>
      ) : error ? (
        <div className="text-[10px] bg-neutral-100 border border-neutral-400 p-2 text-black">
          {error}
        </div>
      ) : (
        <div className="text-[10px] text-neutral-500 border-t border-neutral-200 pt-2 flex justify-between">
          <span>Settlement contract:</span>
          <span className="text-black font-bold">YieldVault · Base Sepolia</span>
        </div>
      )}
    </div>
  );
}
