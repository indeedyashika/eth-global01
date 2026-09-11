"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/apiClient";
import { Badge, Button, Card, ErrorText } from "@/components/ui";
import type { HolderRecord, TokenRecord } from "@/types";
import { hasRequiredWorldIdVerification } from "@/lib/worldid/policy";

export default function HolderTable({ token, holders }: { token: TokenRecord; holders: HolderRecord[] }) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusyKey(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-semibold">Holders</h2>
        <p className="text-xs text-zinc-500 mt-1">
          Admin compliance actions — these sign with the treasury/operator key server-side.
        </p>
      </div>
      <ErrorText>{error}</ErrorText>
      {holders.length === 0 ? (
        <p className="text-sm text-zinc-500">No one has registered for this token yet.</p>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:-mx-5">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-600 border-b border-neutral-300">
                <th className="py-2 px-4 sm:px-5 font-medium">Account</th>
                <th className="py-2 px-2 font-medium">Associated</th>
                {token.compliance.kycRequired && <th className="py-2 px-2 font-medium">KYC</th>}
                {token.compliance.freezeDefault && <th className="py-2 px-2 font-medium">Frozen</th>}
                {token.compliance.worldIdRequired && <th className="py-2 px-2 font-medium">World ID</th>}
                {token.compliance.livenessEnabled && <th className="py-2 px-2 font-medium">Liveness</th>}
                <th className="py-2 px-2 font-medium">Status</th>
                <th className="py-2 px-2 font-medium text-right pr-4 sm:pr-5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {holders.map((holder) => {
                const key = holder.accountId;
                const canWhitelist =
                  holder.associated &&
                  holder.status !== "WHITELISTED" &&
                  hasRequiredWorldIdVerification(token, holder);
                const canReclaim = token.keys.wipe || holder.allowanceGranted;

                return (
                  <tr key={key} className="border-b border-neutral-200 last:border-none">
                    <td className="py-2.5 px-4 sm:px-5 font-mono text-xs">{holder.accountId}</td>
                    <td className="py-2.5 px-2">{holder.associated ? <Dot ok /> : <Dot />}</td>
                    {token.compliance.kycRequired && <td className="py-2.5 px-2">{holder.kycGranted ? <Dot ok /> : <Dot />}</td>}
                    {token.compliance.freezeDefault && <td className="py-2.5 px-2">{holder.frozen ? <Dot /> : <Dot ok />}</td>}
                    {token.compliance.worldIdRequired && (
                      <td className="py-2.5 px-2">
                        {hasRequiredWorldIdVerification(token, holder) ? <Dot ok /> : <Dot />}
                      </td>
                    )}
                    {token.compliance.livenessEnabled && (
                      <td className="py-2.5 px-2">
                        <LivenessBadge state={holder.livenessState} />
                      </td>
                    )}
                    <td className="py-2.5 px-2">
                      <StatusBadge status={holder.status} />
                    </td>
                    <td className="py-2.5 px-2 pr-4 sm:pr-5">
                      <div className="flex justify-end gap-1.5 flex-wrap">
                        {canWhitelist && (
                          <Button
                            variant="secondary"
                            disabled={busyKey === `${key}:whitelist`}
                            onClick={() => run(`${key}:whitelist`, () => postJson(`/api/tokens/${token.id}/holders/${key}/whitelist`))}
                          >
                            Whitelist
                          </Button>
                        )}
                        {holder.status === "WHITELISTED" && (
                          <Button
                            variant="secondary"
                            disabled={busyKey === `${key}:revoke`}
                            onClick={() => run(`${key}:revoke`, () => postJson(`/api/tokens/${token.id}/holders/${key}/revoke`))}
                          >
                            Revoke
                          </Button>
                        )}
                        {holder.activeScheduleId && (
                          <Button
                            variant="ghost"
                            disabled={busyKey === `${key}:cancel`}
                            onClick={() => run(`${key}:cancel`, () => postJson(`/api/tokens/${token.id}/holders/${key}/cancel-schedule`))}
                          >
                            Cancel schedule
                          </Button>
                        )}
                        {canReclaim && (
                          <Button
                            variant="danger"
                            disabled={busyKey === `${key}:reclaim`}
                            onClick={() => {
                              if (!confirm(`Reclaim ${holder.accountId}'s entire balance to the treasury now?`)) return;
                              run(`${key}:reclaim`, () => postJson(`/api/tokens/${token.id}/holders/${key}/reclaim-now`));
                            }}
                          >
                            Reclaim now
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Dot({ ok = false }: { ok?: boolean }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-black" : "bg-neutral-300"}`} />;
}

function StatusBadge({ status }: { status: HolderRecord["status"] }) {
  if (status === "WHITELISTED") return <Badge tone="emerald">Whitelisted</Badge>;
  if (status === "REVOKED") return <Badge tone="red">Revoked</Badge>;
  return <Badge tone="amber">Pending</Badge>;
}

function LivenessBadge({ state }: { state: HolderRecord["livenessState"] }) {
  if (state === "OK") return <Badge tone="emerald">OK</Badge>;
  if (state === "AT_RISK") return <Badge tone="amber">At risk</Badge>;
  if (state === "EXPIRED") return <Badge tone="red">Expired</Badge>;
  return <Badge>—</Badge>;
}
