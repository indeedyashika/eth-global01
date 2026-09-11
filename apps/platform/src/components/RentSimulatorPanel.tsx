"use client";

import React, { useState } from "react";

export interface RentSimulatorPanelProps {
  propertyId?: string;
  defaultRentAmount?: number;
  onDepositSuccess?: (amount: number, receipt: any) => void;
}

export function RentSimulatorPanel({
  propertyId = "prop_456_oak_ave",
  defaultRentAmount = 3800,
  onDepositSuccess,
}: RentSimulatorPanelProps) {
  const [rentAmount, setRentAmount] = useState<number>(defaultRentAmount);
  const [isDepositing, setIsDepositing] = useState<boolean>(false);
  const [depositResult, setDepositResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDepositRent = async () => {
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
        throw new Error(data.error || "Deposit simulation failed");
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
    <div className="flex flex-col justify-between h-full font-mono text-black space-y-3">
      {/* Top Status Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
          <span className="font-bold text-black">INFLOW SIMULATOR</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
          ACH → fUSDCx
        </span>
      </div>

      {/* Preset Amount Chips */}
      <div className="flex items-center justify-between gap-1 text-[11px]">
        <span className="text-neutral-500 text-[10px]">Presets:</span>
        <div className="flex gap-1.5">
          {[1500, 3800, 5200].map((amt) => (
            <button
              key={amt}
              type="button"
              onClick={() => setRentAmount(amt)}
              className={`px-2 py-0.5 border text-[11px] transition cursor-pointer ${
                rentAmount === amt
                  ? "bg-black text-white border-black"
                  : "bg-white text-black border-neutral-300 hover:border-black"
              }`}
            >
              ${amt}
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
              value={rentAmount}
              onChange={(e) => setRentAmount(Number(e.target.value))}
              className="w-full bg-white border border-neutral-300 pl-6 pr-2 py-1.5 text-xs font-mono text-black focus:border-black focus:outline-none"
              placeholder="3800"
            />
          </div>
          <button
            onClick={handleDepositRent}
            disabled={isDepositing || rentAmount <= 0}
            className="bg-black text-white px-3 py-1.5 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer whitespace-nowrap"
          >
            {isDepositing ? "Injecting..." : "Inject Rent"}
          </button>
        </div>
      </div>

      {/* Audit Confirmation Status */}
      {depositResult ? (
        <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2 space-y-1">
          <div className="flex justify-between font-bold text-black">
            <span>✓ ${depositResult.amountDeposited?.toLocaleString()} Inflow Injected</span>
            <span>Flow Accelerated</span>
          </div>
          <div className="flex justify-between text-neutral-600 border-t border-neutral-200 pt-1">
            <span>HCS Receipt:</span>
            <span className="font-mono text-black font-bold">Seq #{depositResult.hcsAudit?.sequenceNumber || "83527"} ↗</span>
          </div>
        </div>
      ) : error ? (
        <div className="text-[10px] bg-neutral-100 border border-neutral-400 p-2 text-black">
          {error}
        </div>
      ) : (
        <div className="text-[10px] text-neutral-500 border-t border-neutral-200 pt-2 flex justify-between">
          <span>Target Contract:</span>
          <span className="text-black font-bold">Base Sepolia YieldVault</span>
        </div>
      )}
    </div>
  );
}
