"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/hooks/useWalletConnect";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { postJson } from "@/lib/apiClient";
import { Badge, Button, Card, ErrorText, TextInput } from "@/components/ui";
import HolderWorldIdCheck from "@/components/HolderWorldIdCheck";
import { hasRequiredWorldIdSubmission } from "@/lib/worldid/policy";
import type {
  HolderRecord,
  TokenRecord,
  TokenRequestRecord,
  WorldIdVerificationRecord,
  WorldIdClientConfig,
} from "@/types";

const OPERATOR_HINT = "the token's treasury account";

export default function HolderPanel({
  token,
  holders,
  requests,
  worldConfig,
}: {
  token: TokenRecord;
  holders: HolderRecord[];
  requests: TokenRequestRecord[];
  worldConfig: WorldIdClientConfig;
}) {
  const hederaWallet = useWallet();
  const evmWallet = useEvmWallet();
  const activeWallet = token.blockchain === "EVM" ? evmWallet : hederaWallet;
  const { accountId, connect, connecting } = activeWallet;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [allowanceAmount, setAllowanceAmount] = useState(token.maxSupply ? Number(token.maxSupply) : 1_000_000_000);

  const holder = useMemo(
    () => holders.find((h) => h.accountId.toLowerCase() === accountId?.toLowerCase()) ?? null,
    [holders, accountId],
  );
  const tokenRequest = useMemo(
    () => requests.find((request) => request.accountId.toLowerCase() === accountId?.toLowerCase()) ?? null,
    [requests, accountId]
  );
  const worldIdReadyForHermes = hasRequiredWorldIdSubmission(token, holder);
  const worldVerificationInFlight = [
    holder?.worldIdSelfieVerification?.status,
    holder?.worldIdIdentityVerification?.status,
  ].some((status) => status === "PENDING" || status === "PROCESSING" || status === "FAILED");
  const selfieCurrent =
    !!holder?.worldIdSelfieVerifiedAt &&
    (!token.compliance.livenessEnabled || holder.livenessState !== "EXPIRED");

  useEffect(() => {
    const requestInFlight =
      !!tokenRequest &&
      tokenRequest.triggerStatus === "TRIGGERED" &&
      !tokenRequest.processingError &&
      ["PENDING", "PROCESSING"].includes(tokenRequest.status);
    if (!requestInFlight && !worldVerificationInFlight) return;
    const interval = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(interval);
  }, [router, tokenRequest, worldVerificationInFlight]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (!accountId) {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="font-semibold">Join as a holder</h2>
        <p className="text-sm text-zinc-500">
          Connect a {token.blockchain === "EVM" ? "Sepolia" : "Hedera"} wallet to pass compliance checks and receive a balance.
        </p>
        <Button onClick={() => connect()} disabled={connecting} className="self-start">
          {connecting ? "Connecting…" : "Connect wallet"}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Your wallet — {accountId}</h2>
        {holder && <StatusBadge status={holder.status} />}
      </div>

      {!holder && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-500">You haven&apos;t registered for this token yet.</p>
          <Button
            className="self-start"
            disabled={busy === "register"}
            onClick={() => run("register", () => postJson(`/api/tokens/${token.id}/holders`, { accountId }))}
          >
            {busy === "register" ? "Registering…" : "Join this token"}
          </Button>
        </div>
      )}

      {holder && (
        <div className="flex flex-col gap-3">
          {token.blockchain === "EVM" ? (
            <ChecklistRow
              label="Wallet ready on Sepolia"
              done={holder.associated}
              action={<Badge tone="emerald">ERC-20</Badge>}
            />
          ) : (
            <ChecklistRow
              label="Associate token to your account"
              done={holder.associated}
              action={
                <AssociateButton tokenId={token.id} accountId={accountId} onDone={() => router.refresh()} onError={setError} />
              }
            />
          )}
          {token.compliance.worldIdSelfieCheck && (
            <ChecklistRow
              label={token.compliance.livenessEnabled ? "Keep World ID Selfie Check current" : "Complete World ID Selfie Check"}
              done={selfieCurrent}
              extra={
                <>
                  <WorldIdVerificationNote
                    verification={holder.worldIdSelfieVerification}
                    fallback="World verifies fresh presence in the official World App."
                  />
                  {token.compliance.livenessEnabled && (
                    <LivenessSummary holder={holder} periodSeconds={token.compliance.livenessPeriodSeconds} />
                  )}
                </>
              }
              action={
                <HolderWorldIdCheck
                  token={token}
                  accountId={accountId}
                  check="selfie"
                  done={!!holder.worldIdSelfieVerifiedAt}
                  allowRepeat={token.compliance.livenessEnabled}
                  expired={
                    token.compliance.livenessEnabled &&
                    !!holder.lastCheckinAt &&
                    holder.livenessState === "EXPIRED"
                  }
                  pendingVerification={holder.worldIdSelfieVerification}
                  worldConfig={worldConfig}
                  onDone={() => router.refresh()}
                  onError={setError}
                />
              }
            />
          )}
          {(token.compliance.worldIdMinimumAge != null ||
            token.compliance.worldIdNationality != null) && (
            <ChecklistRow
              label={identityCheckLabel(token)}
              done={!!holder.worldIdIdentityVerifiedAt}
              extra={
                <WorldIdVerificationNote
                  verification={holder.worldIdIdentityVerification}
                  fallback="Hermes verifies the requested attributes with World."
                />
              }
              action={
                <HolderWorldIdCheck
                  token={token}
                  accountId={accountId}
                  check="identity"
                  done={!!holder.worldIdIdentityVerifiedAt}
                  pendingVerification={holder.worldIdIdentityVerification}
                  worldConfig={worldConfig}
                  onDone={() => router.refresh()}
                  onError={setError}
                />
              }
            />
          )}
          {token.compliance.livenessEnabled && (
            <ChecklistRow
              label={`Approve automatic return to ${OPERATOR_HINT}`}
              done={holder.allowanceGranted}
              extra={<span className="text-xs text-zinc-500">Required before the token can be sent.</span>}
              action={
                holder.allowanceGranted ? (
                  <Badge tone="emerald">Granted</Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    <TextInput
                      type="number"
                      className="w-32"
                      value={allowanceAmount}
                      onChange={(e) => setAllowanceAmount(Number(e.target.value))}
                    />
                    <AllowanceButton
                      token={token}
                      accountId={accountId}
                      treasuryAccountId={token.treasuryAccountId}
                      amount={allowanceAmount}
                      onDone={() => router.refresh()}
                      onError={setError}
                    />
                  </div>
                )
              }
            />
          )}
          {token.tokenType === "FUNGIBLE" && (
            <ChecklistRow
              label={`Request 1 ${token.symbol}`}
              done={tokenRequest?.status === "FULFILLED"}
              extra={<TokenRequestSummary request={tokenRequest} />}
              action={
                <TokenRequestAction
                  request={tokenRequest}
                  disabled={
                    !holder.associated ||
                    token.paused ||
                    !worldIdReadyForHermes ||
                    (token.compliance.livenessEnabled && !holder.allowanceGranted)
                  }
                  busy={busy === "token-request"}
                  onRequest={() =>
                    run("token-request", async () => {
                      const result = await postJson<{
                        triggered: boolean;
                        warning?: string;
                      }>(`/api/tokens/${token.id}/requests`, { accountId });
                      if (!result.triggered && result.warning) {
                        setNotice(`Request saved. Hermes could not start yet: ${result.warning}`);
                      }
                    })
                  }
                />
              }
            />
          )}
        </div>
      )}

      <ErrorText>{error}</ErrorText>
      {notice && <p className="text-sm text-black font-mono">{notice}</p>}
    </Card>
  );
}

function WorldIdVerificationNote({
  verification,
  fallback,
}: {
  verification: WorldIdVerificationRecord | null;
  fallback: string;
}) {
  if (!verification) return <span className="text-xs text-neutral-500 font-mono">{fallback}</span>;
  if (verification.status === "PENDING") {
    return <span className="text-xs text-neutral-700 font-mono">Proof ready for Hermes verification.</span>;
  }
  if (verification.status === "PROCESSING") {
    return <span className="text-xs text-neutral-700 font-mono">Hermes is checking this proof with World…</span>;
  }
  if (verification.status === "FAILED") {
    return (
      <span className="text-xs text-black font-mono">
        World was temporarily unavailable. Hermes can retry this proof.
      </span>
    );
  }
  if (verification.status === "REJECTED") {
    return (
      <span className="text-xs text-black font-mono">
        {verification.errorDetail ?? "World rejected this proof. Please complete a new check."}
      </span>
    );
  }
  return <span className="text-xs text-black font-mono">Verified by Hermes through World.</span>;
}

function identityCheckLabel(token: TokenRecord): string {
  const conditions = [
    token.compliance.worldIdMinimumAge != null
      ? `age ${token.compliance.worldIdMinimumAge}+`
      : null,
    token.compliance.worldIdNationality
      ? `nationality ${token.compliance.worldIdNationality}`
      : null,
  ].filter(Boolean);
  return `Complete World ID Identity Check (${conditions.join(", ")})`;
}

function TokenRequestAction({
  request,
  disabled,
  busy,
  onRequest,
}: {
  request: TokenRequestRecord | null;
  disabled: boolean;
  busy: boolean;
  onRequest: () => void;
}) {
  if (request?.status === "FULFILLED") {
    return request.fulfillmentHashscanUrl ? (
      <a
        href={request.fulfillmentHashscanUrl}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-medium text-black hover:underline font-mono"
      >
        View transfer ↗
      </a>
    ) : (
      <Badge tone="emerald">Sent</Badge>
    );
  }
  if (request?.status === "REJECTED") {
    return (
      <Button variant="secondary" disabled={disabled || busy} onClick={onRequest}>
        {busy ? "Requesting…" : "Request again"}
      </Button>
    );
  }
  if (request?.status === "PROCESSING") {
    return request.processingError ? (
      <Badge tone="red">Review needed</Badge>
    ) : (
      <Badge tone="violet">Hermes sending</Badge>
    );
  }
  if (request?.status === "PENDING" && request.triggerStatus === "TRIGGERED") {
    return (
      <Button variant="secondary" disabled={disabled || busy} onClick={onRequest}>
        {busy ? "Triggering…" : "Retry Hermes"}
      </Button>
    );
  }

  return (
    <Button disabled={disabled || busy} onClick={onRequest}>
      {busy ? "Requesting…" : request?.triggerStatus === "FAILED" ? "Retry Hermes" : "Request"}
    </Button>
  );
}

function TokenRequestSummary({ request }: { request: TokenRequestRecord | null }) {
  if (!request) return <span className="text-xs text-neutral-500 font-mono">Hermes reviews and sends from treasury.</span>;
  if (request.status === "FULFILLED") {
    return <span className="text-xs text-black font-mono">1 token sent.</span>;
  }
  if (request.status === "REJECTED") {
    return (
      <span className="text-xs text-black font-mono">
        {request.rejectionReason ?? "Hermes rejected this request."}
      </span>
    );
  }
  if (request.status === "PROCESSING") {
    if (request.processingError) {
      return (
        <span className="text-xs text-black font-mono">
          Transfer result is uncertain; operator review required.
        </span>
      );
    }
    return <span className="text-xs text-neutral-700 font-mono">Transfer in progress…</span>;
  }
  if (request.processingError) {
    return (
      <span className="text-xs text-black font-mono">
        Last on-chain attempt failed safely; retry Hermes.
      </span>
    );
  }
  if (request.triggerStatus === "FAILED") {
    return <span className="text-xs text-neutral-700 font-mono">Saved; Hermes needs a retry.</span>;
  }
  return <span className="text-xs text-neutral-500 font-mono">Hermes is reviewing the request…</span>;
}

function ChecklistRow({
  label,
  done,
  action,
  extra,
}: {
  label: string;
  done: boolean;
  action: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-neutral-200 pt-3 first:border-none first:pt-0">
      <div className="flex flex-col">
        <span className="text-sm flex items-center gap-2 font-mono text-black">
          <span className={`h-1.5 w-1.5 rounded-full ${done ? "bg-black" : "bg-neutral-300"}`} />
          {label}
        </span>
        {extra}
      </div>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: HolderRecord["status"] }) {
  if (status === "WHITELISTED") return <Badge tone="emerald">Whitelisted</Badge>;
  if (status === "REVOKED") return <Badge tone="red">Revoked</Badge>;
  return <Badge tone="amber">Pending review</Badge>;
}

function LivenessSummary({ holder, periodSeconds }: { holder: HolderRecord; periodSeconds?: number }) {
  if (!holder.lastCheckinAt || !periodSeconds) {
    return <span className="text-xs text-neutral-500 font-mono">The first verified selfie starts the renewal period.</span>;
  }
  const last = new Date(holder.lastCheckinAt).toLocaleString();
  const deadline = new Date(new Date(holder.lastCheckinAt).getTime() + periodSeconds * 1000).toLocaleString();
  return (
    <span className={`text-xs font-mono ${holder.livenessState === "EXPIRED" ? "text-black font-bold" : "text-neutral-600"}`}>
      Selfie verified {last} · renew by {deadline}
      {holder.livenessState === "EXPIRED" && " · expired; automatic return is processing"}
      {holder.livenessReclaimError && ` · return failed: ${holder.livenessReclaimError}`}
    </span>
  );
}

function AssociateButton({
  tokenId,
  accountId,
  onDone,
  onError,
}: {
  tokenId: string;
  accountId: string;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const { associateToken } = useWallet();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        onError("");
        try {
          const txId = await associateToken(tokenId);
          await postJson(`/api/tokens/${tokenId}/holders/${accountId}/associate`, { txId });
          onDone();
        } catch (err) {
          onError(err instanceof Error ? err.message : "Association failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Associating…" : "Associate"}
    </Button>
  );
}

function AllowanceButton({
  token,
  accountId,
  treasuryAccountId,
  amount,
  onDone,
  onError,
}: {
  token: TokenRecord;
  accountId: string;
  treasuryAccountId: string;
  amount: number;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const { approveAllowance } = useWallet();
  const evmWallet = useEvmWallet();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy || amount <= 0}
      onClick={async () => {
        setBusy(true);
        onError("");
        try {
          const txId = token.blockchain === "EVM"
            ? await evmWallet.approveAllowance(token.id, treasuryAccountId, amount)
            : await approveAllowance(token.id, treasuryAccountId, amount);
          await postJson(`/api/tokens/${token.id}/holders/${accountId}/allowance`, { txId, amount });
          onDone();
        } catch (err) {
          onError(err instanceof Error ? err.message : "Allowance approval failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Approving…" : "Approve"}
    </Button>
  );
}
