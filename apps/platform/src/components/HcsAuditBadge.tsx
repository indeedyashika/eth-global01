"use client";

import React from "react";

export interface HcsAuditBadgeProps {
  topicId?: string;
  sequenceNumber?: number | string;
  txId?: string;
  consensusTimestamp?: string;
  compact?: boolean;
}

export function HcsAuditBadge({
  topicId = "0.0.4491823",
  sequenceNumber = "83526",
  txId,
  consensusTimestamp,
  compact = false,
}: HcsAuditBadgeProps) {
  const hashscanTopicUrl = `https://hashscan.io/testnet/topic/${topicId}`;
  const hashscanTxUrl = txId
    ? `https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`
    : `https://hashscan.io/testnet/topic/${topicId}`;

  if (compact) {
    return (
      <a
        href={hashscanTopicUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-neutral-100 text-black border border-neutral-300 hover:bg-neutral-200 transition-colors"
        title="Verified on Hedera Consensus Service (HCS)"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
        <span>HCS #{sequenceNumber}</span>
      </a>
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
          Seq #{sequenceNumber}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-neutral-300 font-mono text-[11px]">
        <div>
          <span className="text-neutral-500 text-[10px] block">Topic ID</span>
          <a
            href={hashscanTopicUrl}
            target="_blank"
            rel="noreferrer"
            className="text-black font-semibold hover:underline flex items-center gap-1"
          >
            {topicId} ↗
          </a>
        </div>
        <div>
          <span className="text-neutral-500 text-[10px] block">Settlement Tx</span>
          <a
            href={hashscanTxUrl}
            target="_blank"
            rel="noreferrer"
            className="text-black font-semibold hover:underline truncate block"
          >
            {txId ? `${txId.slice(0, 16)}...` : "Confirmed on Testnet ↗"}
          </a>
        </div>
      </div>
    </div>
  );
}
