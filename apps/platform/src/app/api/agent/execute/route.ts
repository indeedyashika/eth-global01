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

    let invoice: any = null;
    let settlement: any = {
      success: false,
      txId: null,
      provenance: "LIVE_ONCHAIN",
      hashscanUrl: null,
      error: "x402 settlement unconfigured",
    };
    let oracleResult: any = {
      status: 503,
      error: "x402 settlement unconfigured",
      data: null,
    };

    try {
      invoice = createX402Invoice();
      settlement = await executeX402Payment({
        invoiceId: invoice.invoiceId,
        payee: invoice.payee,
        amountTinybars: invoice.amount,
      });

      if (settlement.success && settlement.txId) {
        recordInvoiceSettlement(
          invoice.invoiceId,
          settlement.txId,
          settlement.provenance,
          settlement.amountTinybars
        );
      }

      oracleResult = await handlePropertyOracleRequest(
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
    } catch (err: any) {
      oracleResult = {
        status: 503,
        error: err?.message || "x402 payment unconfigured or execution failed",
        data: null,
      };
    }

    const isOracleSuccess = oracleResult.status === 200 && oracleResult.data?.isValid === true;
    const oracleData = oracleResult.data;

    steps.push({
      stepNumber: 1,
      name: "Autonomous x402 Micropayment Settlement & USPS Validation",
      network: "Hedera Testnet (x402 Rail)",
      status: !isOracleSuccess || settlement.provenance !== "LIVE_ONCHAIN"
        ? "FAILED"
        : "EXECUTED",
      provenance: isOracleSuccess && settlement.provenance === "LIVE_ONCHAIN" ? "LIVE_ONCHAIN" : null,
      txId: settlement.txId,
      explorerUrl: settlement.hashscanUrl,
      detail: isOracleSuccess && settlement.provenance === "LIVE_ONCHAIN"
        ? `Settled 0.5 HBAR micropayment via Blocky402 (${settlement.provenance}). USPS verified (${oracleData?.verificationMode}: Code ${oracleData?.dpvConfirmation}).`
        : `USPS Oracle or settlement failed: ${oracleData?.error || oracleResult.error || "Live settlement failed"}.`,
      timestamp: new Date().toISOString(),
    });

    // Step B: Hedera Consensus Service (HCS) Verifiable Audit Logging
    const addressHash = oracleData?.addressHash ?? `0x${crypto.createHash("sha256").update(`${property.street}|${property.city}|${property.state}|${property.zip}`).digest("hex")}`;
    const hcsAudit = oracleData?.hcsAudit;
    const isHcsConfirmed = hcsAudit?.status === "CONFIRMED" && hcsAudit?.provenance === "LIVE_ONCHAIN";
    
    steps.push({
      stepNumber: 2,
      name: "Hedera Consensus Service (HCS) Audit Anchor",
      network: hcsAudit?.topicId
        ? `Hedera Testnet (HCS Topic ${hcsAudit.topicId})`
        : "Hedera Testnet (HCS Unconfigured)",
      status: isHcsConfirmed ? "EXECUTED" : "FAILED",
      provenance: isHcsConfirmed ? "LIVE_ONCHAIN" : null,
      txId: hcsAudit?.txId ?? null,
      sequenceNumber: hcsAudit?.sequenceNumber ?? null,
      explorerUrl: hcsAudit?.hashscanUrl ?? null,
      detail: isHcsConfirmed
        ? `Consensus sequence #${hcsAudit.sequenceNumber} anchored on HCS Topic ${hcsAudit.topicId}.`
        : hcsAudit?.topicId
        ? `Failed to anchor consensus message on HCS Topic ${hcsAudit.topicId}.`
        : "HCS Topic unconfigured (HEDERA_AUDIT_TOPIC_ID missing).",
      timestamp: hcsAudit?.consensusTimestamp ?? new Date().toISOString(),
    });

    // Step C: The Graph Dynamic Shareholder Discovery
    let step3Status = "FAILED";
    let step3Detail = "The Graph endpoint unconfigured (SUBGRAPH_URL missing).";
    let step3Provenance: "LIVE_ONCHAIN" | null = null;
    if (process.env.SUBGRAPH_URL) {
      try {
        const query = `{
          tokens(first: 5) {
            id
            symbol
            totalSupply
          }
        }`;
        const resp = await fetch(process.env.SUBGRAPH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json.data) {
            step3Status = "EXECUTED";
            step3Provenance = "LIVE_ONCHAIN";
            step3Detail = `Discovered ${json.data.tokens?.length ?? 0} indexed tokens on Subgraph.`;
          } else {
            step3Detail = `Subgraph query returned GraphQL errors: ${JSON.stringify(json.errors)}`;
          }
        } else {
          step3Detail = `Subgraph endpoint HTTP error: ${resp.status}`;
        }
      } catch (err: any) {
        step3Detail = `Subgraph query failed: ${err.message}`;
      }
    }

    steps.push({
      stepNumber: 3,
      name: "The Graph Studio Holder Discovery",
      network: "The Graph (Sepolia Indexer)",
      status: step3Status,
      provenance: step3Provenance,
      txId: null,
      explorerUrl: null,
      detail: step3Detail,
      timestamp: new Date().toISOString(),
    });

    // Step D: Superfluid CFA Per-Second Yield Stream Creation
    let step4Status = "FAILED";
    let step4Detail = "Superfluid CFA Forwarder unconfigured (SUPERFLUID_CFA_FORWARDER_ADDRESS missing).";
    let step4Provenance: "LIVE_ONCHAIN" | null = null;
    if (process.env.SUPERFLUID_CFA_FORWARDER_ADDRESS && process.env.BASE_SEPOLIA_RPC_URL && process.env.AGENT_PRIVATE_KEY) {
      step4Detail = "Superfluid stream configuration present but requires on-chain execution with agent key.";
    }

    steps.push({
      stepNumber: 4,
      name: "Superfluid CFA Per-Second Yield Stream Creation",
      network: "Base Sepolia (Superfluid CFA)",
      status: step4Status,
      provenance: step4Provenance,
      txId: null,
      explorerUrl: null,
      detail: step4Detail,
      timestamp: new Date().toISOString(),
    });

    // Commit spend to session only if live payment succeeded
    let updatedSession = session;
    if (settlement.success && settlement.provenance === "LIVE_ONCHAIN") {
      updatedSession = commitSessionSpend(sessionId, 0.5, true);
    }

    // Persist event into database audit ledger only for real execution
    if (settlement.success && settlement.provenance === "LIVE_ONCHAIN") {
      try {
        const { insertEvent } = await import("@/lib/db/repo");
        insertEvent({
          tokenId: property.tokenId || "UNASSIGNED",
          type: "TRANSFER",
          detail: {
            action: "HERMES_AUTONOMOUS_PIPELINE_EXECUTED",
            executionId,
            propertyAddress: `${property.street}, ${property.city}, ${property.state} ${property.zip}`,
            x402Settlement: "0.5 HBAR",
          },
          txId: settlement.txId,
          hashscanUrl: settlement.hashscanUrl,
          provenance: "LIVE_ONCHAIN",
        });
      } catch (e) {
        console.warn("[agent execute] Could not record event in sqlite:", e);
      }
    }

    const missionStatus = steps.every(
      (s) => s.status === "EXECUTED" && s.provenance === "LIVE_ONCHAIN"
    )
      ? "EXECUTED"
      : "FAILED";

    if (missionStatus === "EXECUTED") {
      try {
        const { recordStep7Hermes } = await import("@/lib/workflow/judgeWorkflow");
        recordStep7Hermes({
          sessionId,
          executionId,
          txHash: settlement.txId || null,
          action,
          success: true,
        });
      } catch (e) {
        console.warn("[agent execute] could not record step 7 in workflow state:", e);
      }
    }

    return NextResponse.json({
      success: missionStatus === "EXECUTED",
      missionStatus,
      executionId,
      agentId: "hermes-agentic-operator",
      sessionId,
      property: {
        address: `${property.street}, ${property.city}, ${property.state} ${property.zip}`,
        addressHash,
        dpvConfirmation: oracleData?.dpvConfirmation ?? null,
      },
      sessionProof: {
        standard: "ERC-7579 Modular Account Abstraction",
        validatorModule: updatedSession.validatorContract,
        signatureType: updatedSession.signatureType,
        grantor: updatedSession.grantor,
        agent: updatedSession.agentAddress,
        delegatedBudget: `${updatedSession.constraints.maxSpendHbar ?? updatedSession.constraints.maxSpend ?? 0} HBAR`,
        spentBudget: `${updatedSession.spentHbar} HBAR`,
        remainingBudget: `${Math.max(0, (updatedSession.constraints.maxSpendHbar ?? updatedSession.constraints.maxSpend ?? 0) - updatedSession.spentHbar).toFixed(2)} HBAR`,
        expiresAt: new Date(updatedSession.expiresAt).toISOString(),
      },
      sessionRemainingHbar: Math.max(0, (updatedSession.constraints.maxSpendHbar ?? updatedSession.constraints.maxSpend ?? 0) - updatedSession.spentHbar),
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
