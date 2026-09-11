"use client";

import {
  IDKitRequestWidget,
  identityCheck,
  selfieCheckLegacy,
  type IdentityAttribute,
  type Preset,
  type RpContext,
} from "@worldcoin/idkit";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IdentityPolicy, RwaToken } from "@/lib/rwaCatalog";

type VerificationKind = "selfie" | "identity-age" | "identity-us";
type VerificationStatus = "idle" | "preparing" | "verifying" | "error";

type WorldConfig = {
  appId: string;
  isConfigured: boolean;
  selfieEnvironment: "production";
  identityEnvironment: "staging";
  selfieSignal: string;
};

type ProofState = {
  selfieVerifiedAt?: string;
  ageVerifiedAt?: string;
  usIdentityVerifiedAt?: string;
};

type SignatureResponse = RpContext & {
  action: string;
};

type ActiveVerification = {
  kind: VerificationKind;
  action: string;
  rpContext: RpContext;
};

type ApiError = {
  error?: string;
  code?: string;
  details?: string;
};

const PROOF_STORAGE_KEY = "rwa-world-id-proofs-v1";

const ACCENT_STYLES: Record<
  RwaToken["accent"],
  { chip: string; glow: string; mark: string }
> = {
  ocean: {
    chip: "border-cyan-200 bg-cyan-50 text-cyan-800",
    glow: "from-cyan-300/40 via-sky-100/20 to-transparent",
    mark: "bg-cyan-600",
  },
  sun: {
    chip: "border-amber-200 bg-amber-50 text-amber-800",
    glow: "from-amber-300/40 via-orange-100/20 to-transparent",
    mark: "bg-amber-500",
  },
  clay: {
    chip: "border-rose-200 bg-rose-50 text-rose-800",
    glow: "from-rose-300/35 via-orange-100/20 to-transparent",
    mark: "bg-rose-500",
  },
  ink: {
    chip: "border-slate-300 bg-slate-100 text-slate-800",
    glow: "from-slate-400/35 via-slate-100/20 to-transparent",
    mark: "bg-slate-800",
  },
  violet: {
    chip: "border-violet-200 bg-violet-50 text-violet-800",
    glow: "from-violet-300/40 via-fuchsia-100/20 to-transparent",
    mark: "bg-violet-600",
  },
};

function identityKind(policy: IdentityPolicy): VerificationKind {
  return policy.nationality === "USA" ? "identity-us" : "identity-age";
}

function hasProof(proofs: ProofState, kind: VerificationKind) {
  if (kind === "selfie") return Boolean(proofs.selfieVerifiedAt);
  if (kind === "identity-us") return Boolean(proofs.usIdentityVerifiedAt);
  return Boolean(proofs.ageVerifiedAt || proofs.usIdentityVerifiedAt);
}

function proofDate(proofs: ProofState, kind: VerificationKind) {
  if (kind === "selfie") return proofs.selfieVerifiedAt;
  if (kind === "identity-us") return proofs.usIdentityVerifiedAt;
  return proofs.ageVerifiedAt ?? proofs.usIdentityVerifiedAt;
}

function requiredChecks(token: RwaToken): VerificationKind[] {
  const checks: VerificationKind[] = [];
  if (token.requirements.selfie) checks.push("selfie");
  if (token.requirements.identity) {
    checks.push(identityKind(token.requirements.identity));
  }
  return checks;
}

function formatProofDate(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function readApiError(payload: ApiError, fallback: string) {
  return [payload.error, payload.code, payload.details]
    .filter(Boolean)
    .join(" · ") || fallback;
}

function CheckIcon({ checked }: { checked: boolean }) {
  return (
    <span
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
        checked
          ? "border-emerald-500 bg-emerald-500 text-white"
          : "border-zinc-300 bg-white text-transparent"
      }`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
        <path
          d="m3.25 8.25 2.9 2.9 6.6-6.6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path
        d="M4 10h12m-5-5 5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function RwaMarketplace({
  tokens,
  worldConfig,
}: {
  tokens: RwaToken[];
  worldConfig: WorldConfig;
}) {
  const [selectedToken, setSelectedToken] = useState<RwaToken | null>(null);
  const [proofs, setProofs] = useState<ProofState>({});
  const [status, setStatus] = useState<VerificationStatus>("idle");
  const [message, setMessage] = useState("");
  const [requestedKind, setRequestedKind] =
    useState<VerificationKind | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [activeVerification, setActiveVerification] =
    useState<ActiveVerification | null>(null);
  const activeKindRef = useRef<VerificationKind | null>(null);
  const serverErrorRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(PROOF_STORAGE_KEY);
      if (saved) {
        const savedProofs = JSON.parse(saved) as ProofState;
        queueMicrotask(() => setProofs(savedProofs));
      }
    } catch {
      window.sessionStorage.removeItem(PROOF_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!selectedToken) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !widgetOpen) setSelectedToken(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedToken, widgetOpen]);

  const preset = useMemo<Preset | null>(() => {
    if (!activeVerification) return null;
    if (activeVerification.kind === "selfie") {
      return selfieCheckLegacy({ signal: worldConfig.selfieSignal });
    }

    const attributes: IdentityAttribute[] = [
      { type: "minimum_age", value: 18 },
    ];
    if (activeVerification.kind === "identity-us") {
      attributes.push({ type: "nationality", value: "USA" });
    }
    return identityCheck({ attributes });
  }, [activeVerification, worldConfig.selfieSignal]);

  function persistProof(kind: VerificationKind) {
    const verifiedAt = new Date().toISOString();
    setProofs((current) => {
      const next: ProofState =
        kind === "selfie"
          ? { ...current, selfieVerifiedAt: verifiedAt }
          : kind === "identity-us"
            ? {
                ...current,
                ageVerifiedAt: verifiedAt,
                usIdentityVerifiedAt: verifiedAt,
              }
            : { ...current, ageVerifiedAt: verifiedAt };
      window.sessionStorage.setItem(PROOF_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function openAccessPanel(token: RwaToken) {
    setSelectedToken(token);
    setStatus("idle");
    setMessage("");
  }

  async function startVerification(kind: VerificationKind) {
    setRequestedKind(kind);
    setStatus("preparing");
    setMessage(
      kind === "selfie"
        ? "Preparing a production Selfie Check…"
        : "Preparing an Identity Check for the World Simulator…",
    );
    setActiveVerification(null);
    activeKindRef.current = kind;
    serverErrorRef.current = null;

    try {
      const response = await fetch("/api/worldid/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flow: kind === "selfie" ? "selfie" : "identity",
          policy: kind,
        }),
      });
      const payload = (await response.json()) as SignatureResponse | ApiError;
      if (!response.ok || !("signature" in payload)) {
        throw new Error(
          readApiError(payload as ApiError, "Unable to sign the World ID request."),
        );
      }

      const { action, ...rpContext } = payload;
      setActiveVerification({ kind, action, rpContext });
      setStatus("verifying");
      setMessage(
        kind === "selfie"
          ? "Continue in the official World App."
          : "Open “Use the simulator” below the QR code.",
      );
      setWidgetOpen(true);
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : "Unable to start verification.",
      );
    }
  }

  const selectedChecks = selectedToken ? requiredChecks(selectedToken) : [];
  const selectedComplete = selectedChecks.every((kind) => hasProof(proofs, kind));

  return (
    <>
      <section className="rwa-hero">
        <div className="max-w-3xl">
          <p className="rwa-eyebrow">Hedera RWA access desk</p>
          <h1>
            Prove eligibility.
            <br />
            <span>Keep the document private.</span>
          </h1>
          <p className="rwa-lede">
            Explore five tokenized asset policies and run the required World ID
            checks. This demo verifies access only — purchasing is intentionally
            disabled.
          </p>
        </div>
        <div className="rwa-proof-key" aria-label="Verification environments">
          <div>
            <span className="proof-live-dot" aria-hidden="true" />
            <p>Selfie Check</p>
            <strong>Production</strong>
          </div>
          <div>
            <span className="proof-sim-dot" aria-hidden="true" />
            <p>Identity Check</p>
            <strong>World Simulator</strong>
          </div>
        </div>
      </section>

      <div className="rwa-catalog-head">
        <div>
          <p className="rwa-kicker">Demo market</p>
          <h2>Available instruments</h2>
        </div>
        <span className="rwa-no-payment">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
            <path
              d="M3 5.5h10v7H3zM5 5.5V4.25A2.75 2.75 0 0 1 10.4 3.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Verification only · payments off
        </span>
      </div>

      <div className="rwa-grid">
        {tokens.map((token, index) => {
          const checks = requiredChecks(token);
          const completed = checks.filter((kind) => hasProof(proofs, kind)).length;
          const eligible = completed === checks.length;
          const accent = ACCENT_STYLES[token.accent];

          return (
            <article key={token.id} className="rwa-card">
              <div
                className={`pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-br ${accent.glow}`}
                aria-hidden="true"
              />
              <div className="relative flex h-full flex-col">
                <div className="flex items-start justify-between gap-4">
                  <div className={`rwa-symbol ${accent.mark}`}>{token.symbol}</div>
                  <span className="font-mono text-[10px] tracking-[0.14em] text-zinc-400">
                    {String(index + 1).padStart(2, "0")} / {token.reference}
                  </span>
                </div>

                <div className="mt-7">
                  <span className={`rwa-asset-chip ${accent.chip}`}>
                    {token.assetType}
                  </span>
                  <h3>{token.name}</h3>
                  <p className="rwa-description">{token.description}</p>
                </div>

                <dl className="rwa-meta">
                  <div>
                    <dt>Jurisdiction</dt>
                    <dd>{token.jurisdiction}</dd>
                  </div>
                  <div>
                    <dt>Term</dt>
                    <dd>{token.maturity}</dd>
                  </div>
                </dl>

                <div className="rwa-requirements">
                  <div className="flex items-center justify-between gap-3">
                    <span>Access conditions</span>
                    <span className={eligible ? "text-emerald-700" : "text-zinc-500"}>
                      {checks.length === 0
                        ? "Open"
                        : eligible
                          ? "Verified"
                          : `${completed}/${checks.length}`}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {checks.length === 0 ? (
                      <span className="rwa-condition is-open">No conditions</span>
                    ) : (
                      <>
                        {token.requirements.selfie ? (
                          <span
                            className={`rwa-condition ${
                              hasProof(proofs, "selfie") ? "is-done" : ""
                            }`}
                          >
                            <CheckIcon checked={hasProof(proofs, "selfie")} />
                            Live selfie
                          </span>
                        ) : null}
                        {token.requirements.identity ? (
                          <>
                            <span
                              className={`rwa-condition ${
                                hasProof(
                                  proofs,
                                  identityKind(token.requirements.identity),
                                )
                                  ? "is-done"
                                  : ""
                              }`}
                            >
                              <CheckIcon
                                checked={hasProof(
                                  proofs,
                                  identityKind(token.requirements.identity),
                                )}
                              />
                              ID Check
                            </span>
                            <span className="rwa-condition is-attribute">18+</span>
                            {token.requirements.identity.nationality === "USA" ? (
                              <span className="rwa-condition is-attribute">USA</span>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className="rwa-card-action"
                  onClick={() => openAccessPanel(token)}
                >
                  <span>{eligible ? "Review access" : "Complete checks"}</span>
                  <ArrowIcon />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {selectedToken ? (
        <div
          className="rwa-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !widgetOpen) {
              setSelectedToken(null);
            }
          }}
        >
          <section
            className="rwa-access-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="access-panel-title"
          >
            <div className="rwa-panel-head">
              <div>
                <p className="rwa-kicker">
                  {selectedToken.symbol} · Access passport
                </p>
                <h2 id="access-panel-title">{selectedToken.name}</h2>
              </div>
              <button
                type="button"
                className="rwa-close"
                aria-label="Close access panel"
                onClick={() => setSelectedToken(null)}
                disabled={widgetOpen}
              >
                ×
              </button>
            </div>

            <div className="rwa-policy-strip">
              <div>
                <span>Policy</span>
                <strong>{selectedToken.reference}</strong>
              </div>
              <div>
                <span>Proofs required</span>
                <strong>{selectedChecks.length}</strong>
              </div>
              <div>
                <span>Data exposed</span>
                <strong>None</strong>
              </div>
            </div>

            <div className="rwa-check-list">
              {selectedChecks.length === 0 ? (
                <div className="rwa-empty-check">
                  <CheckIcon checked />
                  <div>
                    <strong>No identity condition</strong>
                    <p>This demo instrument is accessible without a World ID proof.</p>
                  </div>
                </div>
              ) : (
                selectedChecks.map((kind, index) => {
                  const checked = hasProof(proofs, kind);
                  const isSelfie = kind === "selfie";
                  return (
                    <div className="rwa-check-row" key={kind}>
                      <div className="rwa-check-index">
                        {checked ? <CheckIcon checked /> : index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>
                            {isSelfie
                              ? "Live selfie check"
                              : kind === "identity-us"
                                ? "ID Check · 18+ · USA"
                                : "ID Check · 18+"}
                          </strong>
                          <span className={isSelfie ? "env-production" : "env-simulator"}>
                            {isSelfie ? "production" : "simulator"}
                          </span>
                        </div>
                        <p>
                          {isSelfie
                            ? "World confirms a fresh liveness and face check. No selfie reaches this app."
                            : kind === "identity-us"
                              ? "World attests minimum age and US nationality without revealing the document."
                              : "World attests that the document holder is at least 18."}
                        </p>
                        {checked ? (
                          <span className="rwa-proof-time">
                            Proof accepted at {formatProofDate(proofDate(proofs, kind))}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className={checked ? "rwa-check-button is-complete" : "rwa-check-button"}
                        disabled={
                          checked ||
                          status === "preparing" ||
                          status === "verifying" ||
                          !worldConfig.isConfigured
                        }
                        onClick={() => startVerification(kind)}
                      >
                        {checked
                          ? "Verified"
                          : status === "preparing" && requestedKind === kind
                            ? "Preparing…"
                            : "Start check"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {!worldConfig.isConfigured && selectedChecks.length > 0 ? (
              <div className="rwa-config-warning" role="alert">
                World ID credentials are not configured on this deployment yet.
              </div>
            ) : null}

            {message ? (
              <div
                className={`rwa-verification-message ${
                  status === "error" ? "is-error" : ""
                }`}
                role="status"
                aria-live="polite"
              >
                <span aria-hidden="true" />
                {message}
              </div>
            ) : null}

            <div className={selectedComplete ? "rwa-access-result is-ready" : "rwa-access-result"}>
              <div>
                <span>{selectedComplete ? "ELIGIBLE" : "PENDING"}</span>
                <strong>
                  {selectedComplete
                    ? "All access conditions are satisfied."
                    : "Complete the checks above to prove eligibility."}
                </strong>
              </div>
              <button type="button" disabled title="Payments are out of scope for this demo">
                Payment disabled
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {activeVerification && preset ? (
        <IDKitRequestWidget
          open={widgetOpen}
          onOpenChange={(open) => {
            setWidgetOpen(open);
            if (!open && status === "verifying") {
              setRequestedKind(null);
              setStatus("idle");
              setMessage("Verification closed. You can start it again.");
            }
          }}
          app_id={(worldConfig.appId || "app_xxxxx") as `app_${string}`}
          action={activeVerification.action}
          rp_context={activeVerification.rpContext}
          allow_legacy_proofs={activeVerification.kind === "selfie"}
          require_user_presence={activeVerification.kind === "selfie"}
          environment={
            activeVerification.kind === "selfie"
              ? worldConfig.selfieEnvironment
              : worldConfig.identityEnvironment
          }
          preset={preset}
          handleVerify={async (result) => {
            const current = activeKindRef.current;
            if (!current) throw new Error("Missing verification policy.");

            const endpoint =
              current === "selfie"
                ? "/api/worldid/verify-selfie"
                : "/api/worldid/verify-identity";
            const response = await fetch(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                current === "selfie" ? result : { result, policy: current },
              ),
            });
            const payload = (await response.json()) as ApiError;
            if (!response.ok) {
              const diagnostic = readApiError(
                payload,
                "World rejected the verification proof.",
              );
              serverErrorRef.current = diagnostic;
              setStatus("error");
              setMessage(diagnostic);
              throw new Error(diagnostic);
            }
            serverErrorRef.current = null;
          }}
          onSuccess={() => {
            const current = activeKindRef.current;
            if (!current) return;
            persistProof(current);
            setRequestedKind(null);
            setStatus("idle");
            setMessage(
              current === "selfie"
                ? "Production Selfie Check accepted."
                : "Simulator Identity Check accepted.",
            );
          }}
          onError={(errorCode) => {
            setStatus("error");
            setMessage(
              serverErrorRef.current ??
                `World ID stopped the verification: ${errorCode}`,
            );
          }}
        />
      ) : null}
    </>
  );
}
