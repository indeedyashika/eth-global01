"use client";

import {
  IDKitRequestWidget,
  identityCheck,
  selfieCheckLegacy,
  type IDKitResult,
  type IdentityAttribute,
  type Preset,
  type RpContext,
} from "@worldcoin/idkit";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { postJson } from "@/lib/apiClient";
import { withTokenizationBasePath } from "@/lib/paths";
import { worldIdHolderSignal } from "@/lib/worldid/policy";
import type {
  TokenRecord,
  WorldIdClientConfig,
  WorldIdVerificationRecord,
} from "@/types";

type CheckKind = "selfie" | "identity";
type SignatureResponse = RpContext & { action: string };
type ApiError = { error?: string; code?: string; details?: string };

export default function HolderWorldIdCheck({
  token,
  accountId,
  check,
  done,
  allowRepeat = false,
  expired = false,
  pendingVerification,
  worldConfig,
  onDone,
  onError,
}: {
  token: TokenRecord;
  accountId: string;
  check: CheckKind;
  done: boolean;
  allowRepeat?: boolean;
  expired?: boolean;
  pendingVerification: WorldIdVerificationRecord | null;
  worldConfig: WorldIdClientConfig;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [verification, setVerification] = useState<{
    action: string;
    rpContext: RpContext;
  } | null>(null);
  const serverError = useRef<string | null>(null);
  const signal = worldIdHolderSignal(token, accountId);
  const submitted =
    pendingVerification?.status === "PENDING" ||
    pendingVerification?.status === "PROCESSING" ||
    pendingVerification?.status === "FAILED";

  const preset = useMemo<Preset>(() => {
    if (check === "selfie") return selfieCheckLegacy({ signal });

    const attributes: IdentityAttribute[] = [];
    if (token.compliance.worldIdMinimumAge != null) {
      attributes.push({
        type: "minimum_age",
        value: token.compliance.worldIdMinimumAge,
      });
    }
    if (token.compliance.worldIdNationality) {
      attributes.push({
        type: "nationality",
        value: token.compliance.worldIdNationality,
      });
    }
    return identityCheck({ attributes, legacy_signal: signal });
  }, [check, signal, token.compliance.worldIdMinimumAge, token.compliance.worldIdNationality]);

  async function startVerification() {
    setPreparing(true);
    setVerification(null);
    serverError.current = null;
    onError("");
    try {
      const response = await fetch(withTokenizationBasePath("/api/worldid/rp-signature"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flow: check,
          policy: check === "selfie" ? "selfie" : "identity",
        }),
      });
      const payload = (await response.json()) as SignatureResponse | ApiError;
      if (!response.ok || !("signature" in payload)) {
        throw new Error(readApiError(payload as ApiError, "Unable to start World ID."));
      }

      const { action, ...rpContext } = payload;
      setVerification({ action, rpContext });
      setWidgetOpen(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to start World ID.");
    } finally {
      setPreparing(false);
    }
  }

  async function retryHermes() {
    if (!pendingVerification) return;
    setPreparing(true);
    onError("");
    try {
      await postJson(
        `/api/tokens/${token.id}/holders/${accountId}/worldid-retry`,
        { verificationId: pendingVerification.id }
      );
      onDone();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Hermes could not be restarted.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        disabled={
          (done && !allowRepeat) ||
          expired ||
          pendingVerification?.status === "PROCESSING" ||
          preparing ||
          !worldConfig.isConfigured
        }
        onClick={submitted ? retryHermes : startVerification}
        title={!worldConfig.isConfigured ? "World ID credentials are not configured." : undefined}
      >
        {expired
          ? "Expired"
          : pendingVerification?.status === "PROCESSING"
          ? "Hermes verifying…"
          : submitted
            ? preparing
              ? "Starting Hermes…"
              : "Retry Hermes"
          : done && allowRepeat
            ? "Renew Selfie Check"
          : done
            ? "Verified"
          : preparing
            ? "Preparing…"
            : !worldConfig.isConfigured
              ? "World ID unavailable"
              : check === "selfie"
                ? "Start Selfie Check"
                : "Start Identity Check"}
      </Button>

      {verification ? (
        <IDKitRequestWidget
          open={widgetOpen}
          onOpenChange={setWidgetOpen}
          app_id={(worldConfig.appId || "app_xxxxx") as `app_${string}`}
          action={verification.action}
          rp_context={verification.rpContext}
          allow_legacy_proofs={check === "selfie"}
          require_user_presence={check === "selfie"}
          environment={
            check === "selfie"
              ? worldConfig.selfieEnvironment
              : worldConfig.identityEnvironment
          }
          preset={preset}
          handleVerify={async (result: IDKitResult) => {
            try {
              await postJson(
                `/api/tokens/${token.id}/holders/${accountId}/worldid-verify`,
                { check, result }
              );
              serverError.current = null;
            } catch (error) {
              const message = error instanceof Error ? error.message : "World rejected the proof.";
              serverError.current = message;
              onError(message);
              throw error;
            }
          }}
          onSuccess={() => {
            setWidgetOpen(false);
            onError("");
            onDone();
          }}
          onError={(code) => {
            onError(serverError.current ?? `World ID stopped the verification: ${code}`);
          }}
        />
      ) : null}
    </>
  );
}

function readApiError(payload: ApiError, fallback: string): string {
  return [payload.error, payload.code, payload.details].filter(Boolean).join(" · ") || fallback;
}
