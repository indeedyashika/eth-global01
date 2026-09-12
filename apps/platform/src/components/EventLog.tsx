import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import type { EventRecord } from "@/types";

const LABEL: Record<string, string> = {
  CREATE_TOKEN: "Token created",
  ASSOCIATE: "Associated",
  GRANT_KYC: "KYC granted",
  REVOKE_KYC: "KYC revoked",
  FREEZE: "Frozen",
  UNFREEZE: "Unfrozen",
  WIPE: "Wiped (reclaimed)",
  PAUSE: "Token paused",
  UNPAUSE: "Token unpaused",
  TRANSFER: "Transfer",
  ALLOWANCE_APPROVE: "Allowance approved",
  WORLDID_VERIFY: "World ID verified",
  CHECKIN: "Liveness check-in",
  SCHEDULE_RECLAIM: "Auto-reclaim scheduled",
  CANCEL_RECLAIM: "Auto-reclaim cancelled",
  AUTO_RECLAIM_EXECUTED: "Auto-reclaim executed",
  TOKEN_MINTED: "Treasury supply minted",
  TOKEN_REQUESTED: "Token requested",
  TOKEN_REQUEST_FULFILLED: "Token sent by Hermes",
  TOKEN_REQUEST_REJECTED: "Token request rejected",
  X402_PROPERTY_DPV_VERIFIED: "USPS DPV Property Verified",
  TENANT_RENT_DEPOSITED: "Tenant Rent Deposited ($5,000)",
  YIELD_CLAIM_SETTLED: "Yield Claim Settled",
  INVESTOR_WORLD_ID_VERIFIED: "World ID Verified Share Claim",
};

interface HcsRecord {
  id?: number;
  topicId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  txId: string;
  type: string;
  propertyId: string;
  actor: string;
  token: string;
  network: string;
  txLink: string;
  memo?: string | null;
}

export default function EventLog({
  events = [],
  tokenId,
  initialLedger,
}: {
  events?: EventRecord[];
  tokenId?: string;
  initialLedger?: {
    topicId: string | null;
    records: HcsRecord[];
    totalCount: number;
  };
}) {
  const [ledger, setLedger] = useState<{
    topicId: string | null;
    records: HcsRecord[];
    totalCount: number;
  } | null>(initialLedger || null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialLedger) {
      setLedger(initialLedger);
      return;
    }
    if (!tokenId) return;

    let cancelled = false;
    setLoading(true);
    fetch(`/api/tokens/${tokenId}/ledger`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.success) {
          setLedger(data);
        }
      })
      .catch((err) => console.warn("[EventLog] fetch ledger error:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tokenId, initialLedger]);

  const hcsRecords = ledger?.records || [];

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 pb-3">
        <div>
          <h2 className="font-bold text-sm text-black">Authoritative Consensus Ledger</h2>
          <p className="text-xs text-neutral-500">
            Hedera Consensus Service (HCS) immutable audit trail with verifiable sequence numbers.
          </p>
        </div>
        {ledger?.topicId && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider">Topic ID:</span>
            <span className="px-2 py-0.5 font-mono text-xs font-bold bg-neutral-100 border border-neutral-300">
              {ledger.topicId}
            </span>
            <span className="px-1.5 py-0.5 text-[10px] bg-emerald-100 text-emerald-800 font-bold border border-emerald-300">
              Hedera Testnet
            </span>
          </div>
        )}
      </div>

      {hcsRecords.length > 0 ? (
        <div className="overflow-x-auto border border-neutral-200">
          <table className="w-full text-left text-xs min-w-[900px]">
            <thead className="bg-neutral-100 border-b border-neutral-200 text-neutral-600 uppercase text-[10px]">
              <tr>
                <th className="p-2.5">Seq #</th>
                <th className="p-2.5">Event Type</th>
                <th className="p-2.5">Consensus Timestamp</th>
                <th className="p-2.5">Transaction ID</th>
                <th className="p-2.5">Topic ID</th>
                <th className="p-2.5">Property ID</th>
                <th className="p-2.5">Actor</th>
                <th className="p-2.5">Token</th>
                <th className="p-2.5">Network</th>
                <th className="p-2.5">Explorer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 font-mono text-[11px]">
              {hcsRecords.map((record) => (
                <tr key={`${record.topicId}-${record.sequenceNumber}`} className="hover:bg-neutral-50">
                  <td className="p-2.5 font-bold">
                    <span className="px-1.5 py-0.5 bg-black text-white text-[10px] font-bold">
                      #{record.sequenceNumber}
                    </span>
                  </td>
                  <td className="p-2.5 font-sans font-bold text-black">
                    {LABEL[record.type] ?? record.type}
                    {record.memo && (
                      <div className="text-[10px] text-neutral-500 font-mono font-normal truncate max-w-xs mt-0.5">
                        {record.memo}
                      </div>
                    )}
                  </td>
                  <td className="p-2.5 text-[10px] text-neutral-600 whitespace-nowrap">
                    {new Date(record.consensusTimestamp).toISOString()}
                  </td>
                  <td className="p-2.5 text-[10px] text-neutral-600">
                    {record.txId.length > 20
                      ? `${record.txId.slice(0, 10)}...${record.txId.slice(-6)}`
                      : record.txId}
                  </td>
                  <td className="p-2.5 text-[10px] text-neutral-700">{record.topicId}</td>
                  <td className="p-2.5 text-[10px] text-neutral-600">
                    {record.propertyId.length > 16
                      ? `${record.propertyId.slice(0, 8)}...`
                      : record.propertyId}
                  </td>
                  <td className="p-2.5 text-[10px] text-neutral-700">
                    {record.actor.length > 16
                      ? `${record.actor.slice(0, 6)}...${record.actor.slice(-4)}`
                      : record.actor}
                  </td>
                  <td className="p-2.5 text-[10px] font-bold text-black">{record.token}</td>
                  <td className="p-2.5 text-[10px]">
                    <span className="px-1.5 py-0.5 bg-neutral-100 border border-neutral-300 rounded text-[10px]">
                      {record.network}
                    </span>
                  </td>
                  <td className="p-2.5 text-[10px]">
                    {record.txLink ? (
                      <a
                        href={record.txLink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-black font-bold underline hover:text-neutral-600"
                      >
                        Receipt ↗
                      </a>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : events.length > 0 ? (
        <ol className="flex flex-col gap-2 max-h-96 overflow-y-auto">
          {events.map((event) => (
            <li
              key={event.id}
              className="text-sm flex items-start justify-between gap-3 border-b border-neutral-200 pb-2 last:border-none font-mono"
            >
              <div>
                <span className="font-medium">{LABEL[event.type] ?? event.type}</span>
                {event.accountId && (
                  <span className="text-zinc-500 font-mono text-xs ml-2">{event.accountId}</span>
                )}
                <div className="text-xs text-zinc-500">{new Date(event.createdAt).toLocaleString()}</div>
              </div>
              {event.txId && event.hashscanUrl ? (
                <a
                  href={event.hashscanUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-zinc-500 hover:underline shrink-0"
                >
                  Explorer ↗
                </a>
              ) : (
                <span className="px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-neutral-600 text-[10px] font-bold tracking-wider">
                  CONFIRMED
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="p-6 text-center text-xs text-neutral-500 bg-neutral-50 border border-neutral-200">
          No consensus records recorded yet. All verified state updates write an immutable HCS sequence record.
        </div>
      )}
    </Card>
  );
}
