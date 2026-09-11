"use client";

import React, { useEffect, useState, useRef } from "react";

export interface InvestorStreamDashboardProps {
  propertyAddress?: string;
  monthlyRent?: number;
  sharePercentage?: number;
  initialBalance?: number;
  onClaim?: () => void;
}

export function InvestorStreamDashboard({
  propertyAddress = "456 Oak Avenue, Miami FL 33101",
  monthlyRent = 3800,
  sharePercentage = 10.0, // 10% ownership
  initialBalance = 12.45021,
  onClaim,
}: InvestorStreamDashboardProps) {
  // Monthly yield for this investor
  const investorMonthlyRent = (monthlyRent * sharePercentage) / 100;
  // Per-second flow rate: monthly / (30 * 86400)
  const flowRatePerSec = investorMonthlyRent / 2592000;

  const [currentYield, setCurrentYield] = useState<number>(initialBalance);
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [isClaiming, setIsClaiming] = useState<boolean>(false);
  const [claimSuccess, setClaimSuccess] = useState<boolean>(false);
  const [claimTx, setClaimTx] = useState<{ txId: string; hashscanUrl: string; amount: number } | null>(null);

  const startRef = useRef<number>(Date.now());
  const initialRef = useRef<number>(initialBalance);

  // High-frequency animation loop for smooth real-time ticking balance (80ms)
  useEffect(() => {
    if (!isStreaming) return;

    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startRef.current) / 1000;
      const accrued = elapsedSeconds * flowRatePerSec;
      setCurrentYield(initialRef.current + accrued);
    }, 80);

    return () => clearInterval(interval);
  }, [isStreaming, flowRatePerSec]);

  const handleClaim = async () => {
    setIsClaiming(true);
    try {
      const res = await fetch("/api/yield/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId: "0.0.4491823",
          accountId: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
          amount: currentYield,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setClaimTx({
          txId: data.txId,
          hashscanUrl: data.hashscanUrl,
          amount: data.amountClaimed,
        });
        setClaimSuccess(true);
        initialRef.current = 0;
        startRef.current = Date.now();
        setCurrentYield(0);
        if (onClaim) onClaim();
        setTimeout(() => setClaimSuccess(false), 7000);
      }
    } catch (e) {
      console.error("Claim error:", e);
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <div className="flex flex-col justify-between h-full font-mono text-black space-y-3">
      {/* Top Status Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
          <span className="font-bold text-black truncate max-w-[180px]">
            {propertyAddress.split(",")[0]}
          </span>
        </div>
        <span className="text-[10px] px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-black">
          Base Sepolia
        </span>
      </div>

      {/* Main Streaming Counter */}
      <div className="text-center py-2.5 px-2 bg-neutral-50 border border-neutral-200">
        <div className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold">
          Accrued Rental Yield (Live)
        </div>
        <div className="text-2xl sm:text-3xl font-extrabold tracking-tight text-black tabular-nums my-1">
          ${currentYield.toFixed(6)}
        </div>
        <div className="text-[11px] text-neutral-600">
          Flow Rate: <span className="font-bold text-black">+${flowRatePerSec.toFixed(8)}/s</span>
        </div>
      </div>

      {/* Share and Rent Metrics */}
      <div className="grid grid-cols-2 gap-2 text-[11px] border-t border-neutral-200 pt-2">
        <div>
          <span className="text-neutral-500 block text-[10px]">Your Equity ({sharePercentage}%)</span>
          <span className="font-bold text-black">${investorMonthlyRent.toFixed(2)} / mo</span>
        </div>
        <div>
          <span className="text-neutral-500 block text-[10px]">Total Property Rent</span>
          <span className="font-bold text-black">${monthlyRent.toLocaleString()} / mo</span>
        </div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleClaim}
          disabled={isClaiming || currentYield <= 0.0001}
          className="flex-1 bg-black text-white px-3 py-2 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer"
        >
          {isClaiming ? "Settling..." : `Claim Yield ($${currentYield.toFixed(2)})`}
        </button>
        <button
          onClick={() => setIsStreaming(!isStreaming)}
          className="bg-white text-black px-3 py-2 text-xs border border-neutral-300 hover:bg-neutral-100 transition cursor-pointer whitespace-nowrap"
        >
          {isStreaming ? "Pause Stream" : "Resume"}
        </button>
      </div>

      {claimSuccess && (
        <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2 text-center text-black space-y-1">
          <div className="font-semibold text-black">
            ✓ Claimed ${claimTx?.amount ? claimTx.amount.toFixed(4) : currentYield.toFixed(4)} fUSDCx!
          </div>
          {claimTx && (
            <div className="text-neutral-600 truncate text-[9px]">
              Tx:{" "}
              <a
                href={claimTx.hashscanUrl}
                target="_blank"
                rel="noreferrer"
                className="underline font-bold text-black"
              >
                {claimTx.txId} ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
