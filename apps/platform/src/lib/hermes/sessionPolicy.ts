import crypto from "node:crypto";
import { verifyTypedData, verifyMessage } from "ethers";

export interface SessionSpendingLimits {
  maxSpendHbar: number;
  maxFlowRateMonthlyUsd: number;
}

export interface SessionPolicyConstraints {
  maxSpendHbar: number;
  maxFlowRateMonthlyUsd: number;
  allowedActions: string[];
  durationHours: number;
}

export interface AgentSessionRecord {
  sessionId: string;
  policyIdentifier: string;
  grantor: string;
  agent: string;
  agentId: string;
  agentAddress: string;
  nonce: number;
  validAfter: number;
  validUntil: number;
  createdAt: number;
  expiresAt: number;
  allowedActions: string[];
  constraints: SessionPolicyConstraints;
  spendingLimits: SessionSpendingLimits;
  spentHbar: number;
  activeStreamsCount: number;
  signature: string;
  signatureType: "EIP712" | "PERSONAL_SIGN" | "DEMO_MOCK";
  validatorContract: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  rawMessage?: string;
}

export interface PolicyValidationResult {
  allowed: boolean;
  status?: number;
  reason?: string;
  remainingHbar: number;
  session?: AgentSessionRecord;
}

// Canonical addresses and EIP-712 Schema
export const VALIDATOR_CONTRACT_ADDRESS = "0x7579C0de00000000000000000000000000007579";
export const HERMES_AGENT_ADDRESS = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";

export const SESSION_KEY_EIP712_DOMAIN = {
  name: "Prism8SessionValidator",
  version: "1",
  chainId: 11155111, // Sepolia
  verifyingContract: VALIDATOR_CONTRACT_ADDRESS,
};

export const SESSION_KEY_EIP712_TYPES = {
  SessionPolicy: [
    { name: "grantor", type: "address" },
    { name: "agent", type: "address" },
    { name: "maxSpendHbar", type: "uint256" },
    { name: "maxFlowMonthlyUsd", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

// In-memory session registry (attached to globalThis for Next.js cross-route persistence)
const globalForHermes = globalThis as unknown as {
  sessionRegistry?: Map<string, AgentSessionRecord>;
  usedGrantorNonces?: Map<string, Set<number>>;
  executedSessionNonces?: Map<string, Set<number>>;
};

export const sessionRegistry = globalForHermes.sessionRegistry ?? new Map<string, AgentSessionRecord>();
if (!globalForHermes.sessionRegistry) {
  globalForHermes.sessionRegistry = sessionRegistry;
}

// Replay protection tracking
export const usedGrantorNonces = globalForHermes.usedGrantorNonces ?? new Map<string, Set<number>>();
if (!globalForHermes.usedGrantorNonces) {
  globalForHermes.usedGrantorNonces = usedGrantorNonces;
}

export const executedSessionNonces = globalForHermes.executedSessionNonces ?? new Map<string, Set<number>>();
if (!globalForHermes.executedSessionNonces) {
  globalForHermes.executedSessionNonces = executedSessionNonces;
}

export function isGrantorNonceUsed(grantor: string, nonce: number): boolean {
  const set = usedGrantorNonces.get(grantor.toLowerCase());
  return set ? set.has(nonce) : false;
}

export function recordGrantorNonce(grantor: string, nonce: number): void {
  const key = grantor.toLowerCase();
  let set = usedGrantorNonces.get(key);
  if (!set) {
    set = new Set<number>();
    usedGrantorNonces.set(key, set);
  }
  set.add(nonce);
}

export function isExecutionNonceUsed(sessionId: string, nonce: number): boolean {
  const set = executedSessionNonces.get(sessionId);
  return set ? set.has(nonce) : false;
}

export function recordExecutionNonce(sessionId: string, nonce: number): void {
  let set = executedSessionNonces.get(sessionId);
  if (!set) {
    set = new Set<number>();
    executedSessionNonces.set(sessionId, set);
  }
  set.add(nonce);
}

export function resetSessionRegistryForTesting(): void {
  sessionRegistry.clear();
  usedGrantorNonces.clear();
  executedSessionNonces.clear();
}

export function getActiveSession(grantorAddress?: string): AgentSessionRecord | null {
  if (grantorAddress) {
    const found = sessionRegistry.get(grantorAddress.toLowerCase());
    if (
      found &&
      found.status === "ACTIVE" &&
      found.validUntil > Date.now() &&
      (!found.validAfter || found.validAfter <= Date.now())
    ) {
      return found;
    }
  }
  return null;
}

export function getSessionById(sessionId?: string): AgentSessionRecord | null {
  if (!sessionId) return null;
  return sessionRegistry.get(sessionId) ?? null;
}

export interface SessionVerificationDetail {
  verified: boolean;
  signer: string;
  signatureType: "EIP712" | "PERSONAL_SIGN" | "DEMO_MOCK" | "INVALID";
  reason?: string;
}

// Only used for isolated test/dev when explicitly enabled via env flag. NEVER active in production!
export const DEMO_MOCK_SIGNATURE =
  "0x38ba6156ac3f289611f7c11f421e9c8f01b50e0d17dc79c8a9f4c3217b58a129d21e843f5451e944738590172bf4212a1c";

export function verifySessionSignature(
  grantor: string,
  signature: string,
  policyValues?: {
    agent?: string;
    maxSpendHbar?: number;
    maxFlowMonthlyUsd?: number;
    validUntil?: number;
    nonce?: number;
  },
  rawMessage?: string
): SessionVerificationDetail {
  if (!grantor || !signature || typeof signature !== "string" || typeof grantor !== "string") {
    return {
      verified: false,
      signer: "",
      signatureType: "INVALID",
      reason: "Missing grantor or signature",
    };
  }

  const expected = grantor.toLowerCase();

  // 1. Try EIP-712 Typed Data Verification
  if (policyValues) {
    try {
      const validUntil = policyValues.validUntil ?? Math.floor((Date.now() + 86400000) / 1000);
      const validUntilSec = validUntil > 1e11 ? Math.floor(validUntil / 1000) : validUntil;
      const rawMaxSpend = policyValues.maxSpendHbar ?? 5.0;
      const maxSpendHbar = rawMaxSpend >= 1e12 ? BigInt(rawMaxSpend) : BigInt(Math.floor(rawMaxSpend * 1e18));

      const typedValue = {
        grantor,
        agent: policyValues.agent || HERMES_AGENT_ADDRESS,
        maxSpendHbar,
        maxFlowMonthlyUsd: BigInt(policyValues.maxFlowMonthlyUsd ?? 5000),
        validUntil: BigInt(validUntilSec),
        nonce: BigInt(policyValues.nonce ?? 1),
      };

      const recovered = verifyTypedData(
        SESSION_KEY_EIP712_DOMAIN,
        SESSION_KEY_EIP712_TYPES,
        typedValue,
        signature
      );

      if (recovered.toLowerCase() === expected) {
        return {
          verified: true,
          signer: recovered,
          signatureType: "EIP712",
        };
      }
    } catch {
      // Fall through to test personal_sign or demo flag
    }
  }

  // 2. Try raw message personal_sign verification
  if (rawMessage) {
    try {
      const recovered = verifyMessage(rawMessage, signature);
      if (recovered.toLowerCase() === expected) {
        return {
          verified: true,
          signer: recovered,
          signatureType: "PERSONAL_SIGN",
        };
      }
    } catch {
      // Fall through
    }
  }

  // 3. Fallback for demo signature: strictly isolated behind an explicit development/demo flag.
  // Must NEVER activate in production, and NEVER accepts arbitrary strings with length > 50!
  const isProduction = process.env.NODE_ENV === "production";
  const allowDemoSignatures = process.env.ALLOW_DEMO_SIGNATURES === "true";

  if (!isProduction && allowDemoSignatures && signature === DEMO_MOCK_SIGNATURE) {
    return {
      verified: true,
      signer: grantor,
      signatureType: "DEMO_MOCK",
    };
  }

  return {
    verified: false,
    signer: "",
    signatureType: "INVALID",
    reason: "Cryptographic signature verification failed",
  };
}

export class NonceReplayError extends Error {
  constructor(message = "Nonce already used for this grantor.") {
    super(message);
    this.name = "NonceReplayError";
  }
}

export class AuthenticationError extends Error {
  constructor(message = "Cryptographic signature verification failed.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function createSessionGrant(
  grantor: string,
  signature: string,
  customConstraints?: Partial<SessionPolicyConstraints>,
  nonce: number = Date.now(),
  rawMessage?: string,
  options?: {
    validAfter?: number;
    agent?: string;
  }
): AgentSessionRecord {
  if (!grantor || !signature) {
    throw new AuthenticationError("Missing required grantor address or signature.");
  }

  if (typeof nonce !== "number" || !Number.isInteger(nonce) || nonce < 0) {
    throw new Error("Invalid nonce: nonce must be a non-negative integer.");
  }

  // Check nonce replay
  if (isGrantorNonceUsed(grantor, nonce)) {
    throw new NonceReplayError(`Nonce ${nonce} has already been registered for grantor ${grantor}.`);
  }

  const constraints: SessionPolicyConstraints = {
    maxSpendHbar: customConstraints?.maxSpendHbar ?? 5.0,
    maxFlowRateMonthlyUsd: customConstraints?.maxFlowRateMonthlyUsd ?? 5000,
    allowedActions: customConstraints?.allowedActions ?? [
      "ORACLE_USPS_X402",
      "HCS_CONSENSUS_AUDIT",
      "SUBGRAPH_HOLDER_DISCOVERY",
      "CFA_YIELD_STREAM_START",
      "CFA_YIELD_STREAM_ADJUST",
      "COMPLIANCE_FREEZE",
    ],
    durationHours: customConstraints?.durationHours ?? 24,
  };

  const targetAgent = options?.agent || HERMES_AGENT_ADDRESS;
  const now = Date.now();
  const validAfter = options?.validAfter ?? now;
  const validUntil = validAfter + constraints.durationHours * 3600000;
  const validUntilSec = Math.floor(validUntil / 1000);

  const verification = verifySessionSignature(
    grantor,
    signature,
    {
      agent: targetAgent,
      maxSpendHbar: constraints.maxSpendHbar,
      maxFlowMonthlyUsd: constraints.maxFlowRateMonthlyUsd,
      validUntil: validUntilSec,
      nonce,
    },
    rawMessage
  );

  if (!verification.verified || verification.signatureType === "INVALID") {
    throw new AuthenticationError("Invalid cryptographic signature: signer does not match grantor.");
  }

  const verifiedGrantor = verification.signer.toLowerCase();
  const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  const record: AgentSessionRecord = {
    sessionId,
    policyIdentifier: sessionId,
    grantor: verifiedGrantor,
    agent: targetAgent.toLowerCase(),
    agentId: "hermes-agentic-operator",
    agentAddress: targetAgent,
    nonce,
    validAfter,
    validUntil,
    createdAt: now,
    expiresAt: validUntil,
    allowedActions: [...constraints.allowedActions],
    constraints,
    spendingLimits: {
      maxSpendHbar: constraints.maxSpendHbar,
      maxFlowRateMonthlyUsd: constraints.maxFlowRateMonthlyUsd,
    },
    spentHbar: 0,
    activeStreamsCount: 0,
    signature,
    signatureType: verification.signatureType,
    validatorContract: VALIDATOR_CONTRACT_ADDRESS,
    status: "ACTIVE",
    rawMessage,
  };

  recordGrantorNonce(verifiedGrantor, nonce);
  sessionRegistry.set(verifiedGrantor, record);
  sessionRegistry.set(sessionId, record);
  return record;
}

export function validateSessionPolicy(
  sessionId: string,
  action: string,
  spendHbar: number = 0,
  flowRateMonthly: number = 0
): PolicyValidationResult {
  if (!sessionId || typeof sessionId !== "string") {
    return {
      allowed: false,
      status: 401,
      reason: "Authentication required: No session ID provided.",
      remainingHbar: 0,
    };
  }

  const session = sessionRegistry.get(sessionId);
  if (!session) {
    return {
      allowed: false,
      status: 401,
      reason: "Authentication required: Session key not found or expired. Re-authorization required.",
      remainingHbar: 0,
    };
  }

  // 1. Check Not-Yet-Valid (validAfter)
  if (session.validAfter && Date.now() < session.validAfter) {
    return {
      allowed: false,
      status: 401,
      reason: "Authentication required: Session key is not yet valid.",
      remainingHbar: 0,
      session,
    };
  }

  // 2. Check Expiration & Status (validUntil)
  if (
    session.status !== "ACTIVE" ||
    Date.now() > session.validUntil ||
    (session.expiresAt && Date.now() > session.expiresAt)
  ) {
    return {
      allowed: false,
      status: 401,
      reason: "Authentication required: Session key has expired or was revoked. Re-authorization required.",
      remainingHbar: 0,
      session,
    };
  }

  // 3. Check Agent Target
  if (
    session.agentAddress.toLowerCase() !== HERMES_AGENT_ADDRESS.toLowerCase() &&
    session.agent.toLowerCase() !== HERMES_AGENT_ADDRESS.toLowerCase()
  ) {
    return {
      allowed: false,
      status: 403,
      reason: "Cryptographic Policy Violation: Session is not granted to Hermes agent.",
      remainingHbar: 0,
      session,
    };
  }

  // 4. Check Action Whitelist
  if (!session.constraints.allowedActions.includes(action) && !session.allowedActions.includes(action)) {
    return {
      allowed: false,
      status: 403,
      reason: `Cryptographic Policy Violation: Action '${action}' is not in the delegated whitelist.`,
      remainingHbar: Math.max(0, session.constraints.maxSpendHbar - session.spentHbar),
      session,
    };
  }

  // 5. Check Spend Budget Constraint
  const remaining = session.constraints.maxSpendHbar - session.spentHbar;
  if (spendHbar > 0 && spendHbar > remaining) {
    return {
      allowed: false,
      status: 403,
      reason: `Budget Cap Exceeded: Requested ${spendHbar} HBAR exceeds remaining session allowance (${remaining.toFixed(2)} HBAR).`,
      remainingHbar: remaining,
      session,
    };
  }

  // 6. Check Flow Rate Ceiling Constraint
  if (
    flowRateMonthly > 0 &&
    flowRateMonthly > session.constraints.maxFlowRateMonthlyUsd
  ) {
    return {
      allowed: false,
      status: 403,
      reason: `Yield Ceiling Violation: Requested monthly stream of $${flowRateMonthly} exceeds permitted maximum of $${session.constraints.maxFlowRateMonthlyUsd}.`,
      remainingHbar: remaining,
      session,
    };
  }

  return {
    allowed: true,
    remainingHbar: remaining - spendHbar,
    session,
  };
}

export function commitSessionSpend(
  sessionId: string,
  spendHbar: number = 0,
  newStreamOpened: boolean = false
): AgentSessionRecord {
  const session = sessionRegistry.get(sessionId);
  if (!session) {
    throw new Error(`Cannot commit spend: Session ${sessionId} not found.`);
  }
  session.spentHbar = Number((session.spentHbar + spendHbar).toFixed(4));
  if (newStreamOpened) {
    session.activeStreamsCount += 1;
  }
  return session;
}
