"use client";

import React, { useEffect, useState, useRef } from "react";

export interface InvestorStreamDashboardProps {
  propertyAddress?: string;
  monthlyRent?: number;
  sharePercentage?: number;
  initialBalance?: number;
  isLocked?: boolean;
  onClaim?: () => void;
}

export function InvestorStreamDashboard({
  propertyAddress = "456 Oak Avenue, Miami FL 33101",
  monthlyRent = 5000,
  sharePercentage = 10.0, // 10% ownership
  initialBalance = 12.45021,
  isLocked = false,
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
  const [claimError, setClaimError] = useState<string | null>(null);

  const startRef = useRef<number>(Date.now());
  const initialRef = useRef<number>(initialBalance);

  // High-frequency animation loop for smooth real-time ticking balance (80ms)
  useEffect(() => {
    if (!isStreaming || isLocked) return;

    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startRef.current) / 1000;
      const accrued = elapsedSeconds * flowRatePerSec;
      setCurrentYield(initialRef.current + accrued);
    }, 80);

    return () => clearInterval(interval);
  }, [isStreaming, flowRatePerSec, isLocked]);

  const handleClaim = async () => {
    if (isLocked) return;
    setIsClaiming(true);
    setClaimError(null);
    try {
      const res = await fetch("/api/yield/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamId: "stream_live",
          amount: currentYield,
          recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setClaimError(data.error || "Claims require an authenticated investor session and live settlement.");
      } else {
        setClaimSuccess(true);
        setClaimTx({
          txId: data.txId,
          hashscanUrl: data.hashscanUrl || `https://sepolia.basescan.org/tx/${data.txId}`,
          amount: data.amount,
        });
        if (onClaim) onClaim();
      }
    } catch (e: any) {
      setClaimError(e.message || "Failed to submit yield claim.");
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <div className="relative flex flex-col justify-between h-full font-mono text-black space-y-3">
      {isLocked && (
        <div className="absolute inset-0 bg-white/90 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center p-4 text-center border border-neutral-300">
          <span className="text-xl mb-1">🔒</span>
          <span className="text-xs font-bold text-black uppercase tracking-wider">Step 3 Locked</span>
          <p className="text-[11px] text-neutral-600 mt-1 max-w-[200px]">
            Complete Step 2 $5,000 Rent Deposit to fund continuous yield stream.
          </p>
        </div>
      )}

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
          disabled={isLocked || isClaiming || currentYield <= 0.0001}
          className="flex-1 bg-black text-white px-3 py-2 text-xs font-bold border border-black hover:bg-neutral-800 disabled:opacity-40 transition cursor-pointer"
        >
          {isClaiming ? "Settling..." : "Claim Yield to Wallet"}
        </button>
        <button
          onClick={() => setIsStreaming(!isStreaming)}
          disabled={isLocked}
          className="bg-white text-black px-3 py-2 text-xs border border-neutral-300 hover:bg-neutral-100 transition cursor-pointer whitespace-nowrap disabled:opacity-40"
        >
          {isStreaming ? "Pause Stream" : "Resume"}
        </button>
      </div>

      {claimSuccess && (
        <div className="text-[10px] bg-neutral-100 border border-neutral-300 p-2 text-center text-black space-y-1">
          <div className="font-semibold text-black">
            ✓ Claimed ${claimTx?.amount ? claimTx.amount.toFixed(4) : currentYield.toFixed(4)} fUSDCx!
          </div>
          {claimTx?.hashscanUrl && (
            <a
              href={claimTx.hashscanUrl}
              target="_blank"
              rel="noreferrer"
              className="text-neutral-600 hover:text-black underline block truncate"
            >
              Tx: {claimTx.txId} ↗
            </a>
          )}
        </div>
      )}

      {claimError && (
        <div className="text-[10px] bg-neutral-100 border border-neutral-400 p-2 text-black">
          {claimError}
        </div>
      )}
    </div>
  );
}
