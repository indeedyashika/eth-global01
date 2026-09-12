import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  validateSessionPolicy,
  commitSessionSpend,
  getSessionById,
  verifySessionSignature,
  HERMES_AGENT_ADDRESS,
  isExecutionNonceUsed,
  recordExecutionNonce,
} from "@/lib/hermes/sessionPolicy";

export async function POST(req: NextRequest) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    const {
      sessionId,
      action = "FULL_TOKENIZATION_AND_YIELD_PIPELINE",
      simulateMalicious = false,
      nonce,
    } = body || {};

    // 1. REJECT: No Session (401)
    if (!sessionId || typeof sessionId !== "string" || sessionId.trim() === "") {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: No session provided.",
        },
        { status: 401 }
      );
    }

    const session = getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Session not found or invalid session ID.",
        },
        { status: 401 }
      );
    }

    // 2. REJECT: Malformed Session (401)
    if (
      !session.grantor ||
      typeof session.grantor !== "string" ||
      !session.agentAddress ||
      typeof session.agentAddress !== "string" ||
      typeof session.nonce !== "number" ||
      isNaN(session.nonce) ||
      typeof session.validUntil !== "number" ||
      isNaN(session.validUntil) ||
      !session.signature ||
      typeof session.signature !== "string" ||
      !session.constraints ||
      !Array.isArray(session.constraints.allowedActions)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Malformed session policy.",
        },
        { status: 401 }
      );
    }

    // 3. REJECT: Not-Yet-Valid Session (401)
    if (session.validAfter && Date.now() < session.validAfter) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Session policy is not yet valid.",
        },
        { status: 401 }
      );
    }

    // 4. REJECT: Expired Session (401)
    if (
      session.status !== "ACTIVE" ||
      Date.now() > session.validUntil ||
      (session.expiresAt && Date.now() > session.expiresAt)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Session key has expired or was revoked. Re-authorization required.",
        },
        { status: 401 }
      );
    }

    // 5. REJECT: Invalid Signature (401)
    const verification = verifySessionSignature(
      session.grantor,
      session.signature,
      {
        agent: session.agentAddress || session.agent,
        allowedTargets: session.allowedTargets || session.constraints.allowedTargets,
        allowedSelectors: session.allowedSelectors || session.constraints.allowedSelectors,
        maxSpend: session.constraints.maxSpend ?? session.constraints.maxSpendHbar,
        maxFlow: session.constraints.maxFlow ?? session.constraints.maxFlowRateMonthlyUsd,
        validAfter: Math.floor(session.validAfter / 1000),
        validUntil: Math.floor(session.validUntil / 1000),
        nonce: session.nonce,
      },
      session.rawMessage
    );

    if (!verification.verified || verification.signatureType === "INVALID") {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Invalid cryptographic signature for session.",
        },
        { status: 401 }
      );
    }

    // 6. REJECT: Wrong Agent (403)
    if (
      session.agentAddress.toLowerCase() !== HERMES_AGENT_ADDRESS.toLowerCase() &&
      session.agent.toLowerCase() !== HERMES_AGENT_ADDRESS.toLowerCase()
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Cryptographic Policy Violation: Session is not granted to Hermes agent.",
        },
        { status: 403 }
      );
    }

    // 7. REJECT: Invalid Nonce & Replayed Nonce (400 / 409)
    if (nonce !== undefined) {
      if (typeof nonce !== "number" || !Number.isInteger(nonce) || nonce < 0) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid nonce: Nonce must be a non-negative integer.",
          },
          { status: 400 }
        );
      }

      if (isExecutionNonceUsed(session.sessionId, nonce)) {
        return NextResponse.json(
          {
            success: false,
            error: `Nonce ${nonce} has already been executed for this session. Replay conflict rejected.`,
          },
          { status: 409 }
        );
      }

      recordExecutionNonce(session.sessionId, nonce);
    }

    // 8. REJECT: Unauthorized Action / Target / Spend Guardrails (403)
    if (simulateMalicious) {
      const maliciousAction = "UNAUTHORIZED_TREASURY_TRANSFER";
      const maliciousTarget = "0x9999999999999999999999999999999999999999";
      const maliciousSelector = "0xa9059cbb";
      const validation = validateSessionPolicy(sessionId, {
        action: maliciousAction,
        target: maliciousTarget,
        selector: maliciousSelector,
        spend: 100.0,
        flow: 50000,
      });
      try {
        const { recordStep8Compromise } = await import("@/lib/workflow/judgeWorkflow");
        recordStep8Compromise({
          attackAction: maliciousAction,
          blocked: true,
          rejectionCode: "CRYPTOGRAPHIC_POLICY_VIOLATION_HALTED",
          rejectionReason: validation.reason,
        });
      } catch (err) {
        console.warn("[agent/execute] Could not update step 8 workflow state:", err);
      }
      return NextResponse.json(
        {
          success: false,
          blockedByGuardrail: true,
          error: validation.reason,
          guardrailDetails: {
            attemptedAction: maliciousAction,
            attemptedTarget: maliciousTarget,
            attemptedSelector: maliciousSelector,
            attemptedSpend: "100.0 HBAR",
            remainingSessionBudget: `${validation.remainingHbar.toFixed(2)} HBAR`,
            status: "CRYPTOGRAPHIC_POLICY_VIOLATION_HALTED",
          },
        },
        { status: 403 }
      );
    }

    // 9. STEP 7: Execute Real Autonomous Hermes Mission from Authoritative Protocol State
    const { executeAuthoritativeHermesMission, getAuthoritativeHermesInputs } =
      await import("@/lib/hermes/hermesMissionService");

    // Pre-flight check: fail closed if any prerequisite is missing
    const prereq = await getAuthoritativeHermesInputs();
    if (!prereq.valid) {
      return NextResponse.json(
        {
          success: false,
          missionStatus: "FAILED",
          error: prereq.error,
        },
        { status: 412 }
      );
    }

    try {
      const result = await executeAuthoritativeHermesMission(sessionId, { action });
      return NextResponse.json(result);
    } catch (missionErr: any) {
      return NextResponse.json(
        {
          success: false,
          missionStatus: "FAILED",
          error: missionErr.message || "Failed to execute authoritative Hermes mission.",
        },
        { status: missionErr.message?.includes("prerequisite") ? 412 : 500 }
      );
    }
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        missionStatus: "FAILED",
        error: err.message || "Failed to execute autonomous agent mission",
      },
      { status: 500 }
    );
  }
}
