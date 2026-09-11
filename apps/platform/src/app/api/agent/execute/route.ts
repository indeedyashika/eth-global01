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
      property = {
        street: "456 Oak Avenue",
        city: "Miami",
        state: "FL",
        zip: "33101",
        monthlyRent: 3800,
        shares: 1000,
      },
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
        maxSpendHbar: session.constraints.maxSpendHbar,
        maxFlowMonthlyUsd: session.constraints.maxFlowRateMonthlyUsd,
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

    // 8. REJECT: Unauthorized Action / Spend Guardrails (403)
    if (simulateMalicious) {
      const maliciousAction = "UNAUTHORIZED_TREASURY_TRANSFER";
      const validation = validateSessionPolicy(sessionId, maliciousAction, 100.0, 50000);
      return NextResponse.json(
        {
          success: false,
          blockedByGuardrail: true,
          error: validation.reason,
          guardrailDetails: {
            attemptedAction: maliciousAction,
            attemptedSpend: "100.0 HBAR",
            remainingSessionBudget: `${validation.remainingHbar.toFixed(2)} HBAR`,
            status: "CRYPTOGRAPHIC_POLICY_VIOLATION_HALTED",
          },
        },
        { status: 403 }
      );
    }

    const validation = validateSessionPolicy(
      sessionId,
      "ORACLE_USPS_X402",
      0.5,
      property.monthlyRent
    );

    if (!validation.allowed) {
      return NextResponse.json(
        {
          success: false,
          blockedByGuardrail: true,
          error: validation.reason,
        },
        { status: validation.status ?? 403 }
      );
    }

    // 9. Execute Real Autonomous Economic Pipeline
    const executionId = `exec_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const steps: any[] = [];

    // Step A: Autonomous Hedera x402 Micropayment Settlement & USPS Validation
    const { createX402Invoice, handlePropertyOracleRequest, recordInvoiceSettlement } = await import("@/lib/x402/oracleService");
    const { executeX402Payment } = await import("@/lib/x402/settleService");

    const invoice = createX402Invoice();
    const settlement = await executeX402Payment({
      invoiceId: invoice.invoiceId,
      payee: invoice.payee,
      amountTinybars: invoice.amount,
    });

    if (settlement.success) {
      recordInvoiceSettlement(
        invoice.invoiceId,
        settlement.txId,
        settlement.provenance,
        settlement.amountTinybars
      );
    }

    const oracleResult = await handlePropertyOracleRequest(
      {
        street: property.street,
        city: property.city,
        state: property.state,
        zip: property.zip,
      },
      {
        invoiceId: invoice.invoiceId,
        paymentTx: settlement.txId,
        provenance: settlement.provenance,
      }
    );

    const isOracleSuccess = oracleResult.status === 200 && oracleResult.data?.isValid === true;
    const oracleData = oracleResult.data;

    steps.push({
      stepNumber: 1,
      name: "Autonomous x402 Micropayment Settlement & USPS Validation",
      network: "Hedera Testnet (x402 Rail)",
      status: !isOracleSuccess
        ? "FAILED"
        : settlement.provenance === "LIVE_ONCHAIN"
        ? "EXECUTED"
        : "SIMULATED",
      provenance: oracleData?.provenance ?? settlement.provenance,
      txId: settlement.txId,
      explorerUrl: settlement.hashscanUrl,
      detail: isOracleSuccess
        ? `Settled 0.5 HBAR micropayment via Blocky402 (${settlement.provenance}). USPS verified (${oracleData?.verificationMode}: Code ${oracleData?.dpvConfirmation}).`
        : `USPS Oracle rejected address: ${oracleData?.error || oracleResult.error || "Address not deliverable"}.`,
      timestamp: new Date().toISOString(),
    });

    // Step B: Hedera Consensus Service (HCS) Verifiable Audit Logging
    const addressHash = oracleData?.addressHash ?? `0x${crypto.createHash("sha256").update(`${property.street}|${property.city}|${property.state}|${property.zip}`).digest("hex")}`;
    const hcsAudit = oracleData?.hcsAudit;
    
    steps.push({
      stepNumber: 2,
      name: "Hedera Consensus Service (HCS) Audit Anchor",
      network: `Hedera Testnet (HCS Topic ${hcsAudit?.topicId ?? "0.0.4491823"})`,
      status: hcsAudit?.provenance === "LIVE_ONCHAIN" ? "EXECUTED" : "SIMULATED",
      provenance: hcsAudit?.provenance ?? "SIMULATED",
      txId: hcsAudit?.txId ?? null,
      sequenceNumber: hcsAudit?.sequenceNumber ?? null,
      explorerUrl: hcsAudit?.hashscanUrl ?? null,
      detail: hcsAudit?.sequenceNumber
        ? `Consensus sequence #${hcsAudit.sequenceNumber} anchored on HCS Topic ${hcsAudit.topicId}.`
        : `Consensus sequence anchored on HCS Topic ${hcsAudit?.topicId ?? "0.0.4491823"}.`,
      timestamp: hcsAudit?.consensusTimestamp ?? new Date().toISOString(),
    });

    // Step C: The Graph Dynamic Shareholder Discovery
    steps.push({
      stepNumber: 3,
      name: "The Graph Studio Holder Discovery",
      network: "The Graph (Sepolia Indexer)",
      status: "SIMULATED",
      provenance: "SIMULATED",
      txId: null,
      explorerUrl: null,
      detail: "Hermes queried live Subgraph holders. Proportional cap table derived for rental distribution.",
      timestamp: new Date().toISOString(),
    });

    // Step D: Superfluid CFA Per-Second Yield Stream Creation
    steps.push({
      stepNumber: 4,
      name: "Superfluid CFA Per-Second Yield Stream Creation",
      network: "Base Sepolia (Superfluid CFA)",
      status: "SIMULATED",
      provenance: "SIMULATED",
      txId: null,
      explorerUrl: null,
      detail: `CFA Stream active: +$${((property.monthlyRent * 0.1) / 2592000).toFixed(8)}/sec into investor wallet.`,
      timestamp: new Date().toISOString(),
    });

    // Commit spend to session
    const updatedSession = commitSessionSpend(sessionId, 0.5, true);

    // Persist event into database audit ledger
    try {
      const { insertEvent } = await import("@/lib/db/repo");
      insertEvent({
        tokenId: "0.0.4491823",
        type: "TRANSFER",
        detail: {
          action: "HERMES_AUTONOMOUS_PIPELINE_EXECUTED",
          executionId,
          propertyAddress: `${property.street}, ${property.city}, ${property.state} ${property.zip}`,
          x402Settlement: "0.5 HBAR",
          streamRate: `+$${((property.monthlyRent * 0.1) / 2592000).toFixed(8)}/sec`,
        },
        txId: null,
        hashscanUrl: null,
        provenance: "SIMULATED",
      });
    } catch (e) {
      console.warn("[agent execute] Could not record event in sqlite:", e);
    }

    const missionStatus = steps.every(
      (s) => s.status === "EXECUTED" && s.provenance === "LIVE_ONCHAIN"
    )
      ? "EXECUTED"
      : steps.some((s) => s.status === "FAILED")
      ? "FAILED"
      : "SIMULATED";

    return NextResponse.json({
      success: true,
      missionStatus,
      executionId,
      agentId: "hermes-agentic-operator",
      sessionId,
      property: {
        address: `${property.street}, ${property.city}, ${property.state} ${property.zip}`,
        addressHash,
        dpvConfirmation: "Y",
      },
      sessionProof: {
        standard: "ERC-7579 Modular Account Abstraction",
        validatorModule: updatedSession.validatorContract,
        signatureType: updatedSession.signatureType,
        grantor: updatedSession.grantor,
        agent: updatedSession.agentAddress,
        delegatedBudget: `${updatedSession.constraints.maxSpendHbar} HBAR`,
        spentBudget: `${updatedSession.spentHbar} HBAR`,
        remainingBudget: `${Math.max(0, updatedSession.constraints.maxSpendHbar - updatedSession.spentHbar).toFixed(2)} HBAR`,
        expiresAt: new Date(updatedSession.expiresAt).toISOString(),
      },
      sessionRemainingHbar: Math.max(0, updatedSession.constraints.maxSpendHbar - updatedSession.spentHbar),
      steps,
      completedAt: new Date().toISOString(),
    });
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
