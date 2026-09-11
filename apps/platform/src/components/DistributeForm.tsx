"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/apiClient";
import { Button, Card, ErrorText, Field, Select, TextInput } from "@/components/ui";
import type { HolderRecord, TokenRecord } from "@/types";

export default function DistributeForm({ token, holders }: { token: TokenRecord; holders: HolderRecord[] }) {
  const router = useRouter();
  const whitelisted = holders.filter((h) => h.status === "WHITELISTED");
  const [accountId, setAccountId] = useState(whitelisted[0]?.accountId ?? "");
  const [amount, setAmount] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (token.tokenType !== "FUNGIBLE") {
    return (
      <Card>
        <h2 className="font-semibold mb-1">Distribute</h2>
        <p className="text-sm text-zinc-500">
          NFT serial minting &amp; transfer management isn&apos;t wired up in this build yet — see README.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-semibold">Distribute from treasury</h2>
      {whitelisted.length === 0 ? (
        <p className="text-sm text-zinc-500">No whitelisted holders yet.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Holder">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-48">
              {whitelisted.map((h) => (
                <option key={h.accountId} value={h.accountId}>{h.accountId}</option>
              ))}
            </Select>
          </Field>
          <Field label={`Amount (base units, decimals=${token.decimals})`}>
            <TextInput type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="w-56" />
          </Field>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setOk(null);
              try {
                await postJson(`/api/tokens/${token.id}/transfer`, { accountId, amount });
                setOk(`Sent ${amount} to ${accountId}`);
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Transfer failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {ok && <p className="text-sm text-black font-mono">{ok}</p>}
    </Card>
  );
}
