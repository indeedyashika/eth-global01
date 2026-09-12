"use client";

import React from "react";

export interface HcsAuditBadgeProps {
  topicId?: string | null;
  sequenceNumber?: number | string | null;
  txId?: string | null;
  consensusTimestamp?: string;
  compact?: boolean;
}

export function HcsAuditBadge({
  topicId,
  sequenceNumber,
  txId,
  consensusTimestamp,
  compact = false,
}: HcsAuditBadgeProps) {
  const hashscanTopicUrl = topicId ? `https://hashscan.io/testnet/topic/${topicId}` : undefined;
  const hashscanTxUrl = txId
    ? `https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`
    : hashscanTopicUrl;

  if (compact) {
    const badgeContent = (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
        <span>HCS {sequenceNumber ? `#${sequenceNumber}` : "SIMULATED"}</span>
      </>
    );

    if (hashscanTopicUrl) {
      return (
        <a
          href={hashscanTopicUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-neutral-100 text-black border border-neutral-300 hover:bg-neutral-200 transition-colors"
          title="Verified on Hedera Consensus Service (HCS)"
        >
          {badgeContent}
        </a>
      );
    }

    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-neutral-100 text-black border border-neutral-300"
        title="Verified on Hedera Consensus Service (HCS Simulated)"
      >
        {badgeContent}
      </span>
    );
  }

  return (
    <div className="p-3 bg-neutral-50 border border-neutral-300 rounded-xl text-xs text-black shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-black"></span>
          </span>
          <span className="font-semibold text-black tracking-wide uppercase text-[10px]">
            Hedera Consensus Audit Trail (HCS)
          </span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-neutral-200 text-black font-mono border border-neutral-300">
          {sequenceNumber ? `Seq #${sequenceNumber}` : "SIMULATED"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-neutral-300 font-mono text-[11px]">
        <div>
          <span className="text-neutral-500 text-[10px] block">Topic ID</span>
          {topicId && hashscanTopicUrl ? (
            <a
              href={hashscanTopicUrl}
              target="_blank"
              rel="noreferrer"
              className="text-black font-semibold hover:underline flex items-center gap-1"
            >
              {topicId} ↗
            </a>
          ) : topicId ? (
            <span className="text-black font-semibold">{topicId}</span>
          ) : (
            <span className="text-black font-bold">SIMULATED</span>
          )}
        </div>
        <div>
          <span className="text-neutral-500 text-[10px] block">Settlement Tx</span>
          {txId === "SIMULATED_PAYMENT" || !txId ? (
            <span className="text-black font-bold">SIMULATED</span>
          ) : hashscanTxUrl ? (
            <a
              href={hashscanTxUrl}
              target="_blank"
              rel="noreferrer"
              className="text-black font-semibold hover:underline truncate block"
            >
              {txId.slice(0, 16)}...
            </a>
          ) : (
            <span className="text-black font-semibold truncate block">
              {txId.slice(0, 16)}...
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
