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
};

export default function EventLog({ events }: { events: EventRecord[] }) {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-semibold">Activity</h2>
      {events.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing has happened yet.</p>
      ) : (
        <ol className="flex flex-col gap-2 max-h-96 overflow-y-auto">
          {events.map((event) => (
            <li key={event.id} className="text-sm flex items-start justify-between gap-3 border-b border-neutral-200 pb-2 last:border-none font-mono">
              <div>
                <span className="font-medium">{LABEL[event.type] ?? event.type}</span>
                {event.accountId && <span className="text-zinc-500 font-mono text-xs ml-2">{event.accountId}</span>}
                <div className="text-xs text-zinc-500">{new Date(event.createdAt).toLocaleString()}</div>
              </div>
              {event.hashscanUrl && (
                <a href={event.hashscanUrl} target="_blank" rel="noreferrer" className="text-xs text-zinc-500 hover:underline shrink-0">
                  Explorer ↗
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
