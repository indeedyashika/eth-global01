import crypto from "node:crypto";
import { verifyTypedData, verifyMessage, getAddress, isAddress, AbiCoder, recoverAddress } from "ethers";

export interface SessionSpendingLimits {
  maxSpendHbar: number;
  maxFlowRateMonthlyUsd: number;
}

export interface SessionPolicyConstraints {
  maxSpend: number;
  maxFlow: number;
  allowedTargets: string[];
  allowedSelectors: string[];
  validAfter: number;
  validUntil: number;
  durationHours?: number;
  allowedActions?: string[];
  // Backwards compatibility mappings:
  maxSpendHbar?: number;
  maxFlowRateMonthlyUsd?: number;
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
  allowedTargets: string[];
  allowedSelectors: string[];
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

export const DEFAULT_ALLOWED_TARGETS = [
  VALIDATOR_CONTRACT_ADDRESS,
  "0x1111111111111111111111111111111111111111", // PropertyRegistry
  "0x2222222222222222222222222222222222222222", // YieldVault
  "0x3333333333333333333333333333333333333333", // USPSChainlinkConsumer
];

export const DEFAULT_ALLOWED_SELECTORS = [
  "0xb4b46617", // registerProperty(bytes32,string,uint256,bool)
  "0x401826f6", // setVerificationStatus(bytes32,bytes32,bool)
  "0x19273c68", // updatePropertyStatus(bytes32,uint8)
  "0xd4116492", // depositRent(bytes32,uint256)
  "0x7a83d73a", // createInvestorStream(bytes32,address,uint256)
  "0x90f5c9ef", // calculateFlowRate(uint256,uint256)
  "0x38ba6156", // x402 settlement / custom actions
  "0x12345678", // demo action
];

export const SESSION_KEY_EIP712_DOMAIN = {
  name: "Prism8SessionValidator",
  version: "1",
  chainId: 11155111, // Sepolia
  verifyingContract: VALIDATOR_CONTRACT_ADDRESS,
};

// Full 9-field EIP-712 SessionPolicy schema enforced on-chain
export const SESSION_KEY_EIP712_TYPES = {
  SessionPolicy: [
    { name: "grantor", type: "address" },
    { name: "agent", type: "address" },
    { name: "allowedTargets", type: "address[]" },
    { name: "allowedSelectors", type: "bytes4[]" },
    { name: "maxSpend", type: "uint256" },
    { name: "maxFlow", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

// Legacy schema for backwards-compatible signature parsing fallback
const LEGACY_SESSION_KEY_EIP712_TYPES = {
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

export interface SessionPolicyValues {
  grantor?: string;
  agent?: string;
  allowedTargets?: string[];
  allowedSelectors?: string[];
  maxSpend?: number | bigint;
  maxFlow?: number | bigint;
  validAfter?: number;
  validUntil?: number;
  nonce?: number;
  maxSpendHbar?: number;
  maxFlowMonthlyUsd?: number;
  chainId?: number;
  verifyingContract?: string;
}

export function verifySessionSignature(
  grantor: string,
  signature: string,
  policyValues?: SessionPolicyValues,
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
      const validAfter = policyValues.validAfter ?? Math.floor(Date.now() / 1000);
      const validAfterSec = validAfter > 1e11 ? Math.floor(validAfter / 1000) : validAfter;

      const validUntil = policyValues.validUntil ?? Math.floor((Date.now() + 86400000) / 1000);
      const validUntilSec = validUntil > 1e11 ? Math.floor(validUntil / 1000) : validUntil;

      const rawMaxSpend = policyValues.maxSpend ?? policyValues.maxSpendHbar ?? 5.0;
      const maxSpend = typeof rawMaxSpend === "bigint" ? rawMaxSpend : (rawMaxSpend >= 1e12 ? BigInt(rawMaxSpend) : BigInt(Math.floor(rawMaxSpend * 1e18)));

      const rawMaxFlow = policyValues.maxFlow ?? policyValues.maxFlowMonthlyUsd ?? 5000;
      const maxFlow = typeof rawMaxFlow === "bigint" ? rawMaxFlow : BigInt(Math.floor(Number(rawMaxFlow)));

      const allowedTargets = (policyValues.allowedTargets && policyValues.allowedTargets.length > 0)
        ? policyValues.allowedTargets.map((t) => getAddress(t))
        : DEFAULT_ALLOWED_TARGETS.map((t) => getAddress(t));

      const allowedSelectors = (policyValues.allowedSelectors && policyValues.allowedSelectors.length > 0)
        ? policyValues.allowedSelectors.map((s) => s.toLowerCase())
        : DEFAULT_ALLOWED_SELECTORS.map((s) => s.toLowerCase());

      const domain = {
        ...SESSION_KEY_EIP712_DOMAIN,
        ...(policyValues.chainId !== undefined ? { chainId: policyValues.chainId } : {}),
        ...(policyValues.verifyingContract !== undefined ? { verifyingContract: policyValues.verifyingContract } : {}),
      };

      // 1A. Primary: 9-field schema
      const typedValue = {
        grantor,
        agent: policyValues.agent || HERMES_AGENT_ADDRESS,
        allowedTargets,
        allowedSelectors,
        maxSpend,
        maxFlow,
        validAfter: BigInt(validAfterSec),
        validUntil: BigInt(validUntilSec),
        nonce: BigInt(policyValues.nonce ?? 1),
      };

      try {
        const recovered = verifyTypedData(
          domain,
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
        // Fall through to try legacy format
      }

      // 1B. Fallback: Legacy 6-field schema
      const legacyTypedValue = {
        grantor,
        agent: policyValues.agent || HERMES_AGENT_ADDRESS,
        maxSpendHbar: maxSpend,
        maxFlowMonthlyUsd: maxFlow,
        validUntil: BigInt(validUntilSec),
        nonce: BigInt(policyValues.nonce ?? 1),
      };

      try {
        const legacyRecovered = verifyTypedData(
          domain,
          LEGACY_SESSION_KEY_EIP712_TYPES,
          legacyTypedValue,
          signature
        );

        if (legacyRecovered.toLowerCase() === expected) {
          return {
            verified: true,
            signer: legacyRecovered,
            signatureType: "EIP712",
          };
        }
      } catch {
        // Fall through
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
    validUntil?: number;
    agent?: string;
    allowedTargets?: string[];
    allowedSelectors?: string[];
    chainId?: number;
    verifyingContract?: string;
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

  const rawTargets = options?.allowedTargets ?? customConstraints?.allowedTargets ?? DEFAULT_ALLOWED_TARGETS;
  const allowedTargets = rawTargets.map((t) => {
    if (!isAddress(t)) throw new Error(`Invalid target address: ${t}`);
    return getAddress(t);
  });

  const rawSelectors = options?.allowedSelectors ?? customConstraints?.allowedSelectors ?? DEFAULT_ALLOWED_SELECTORS;
  const allowedSelectors = rawSelectors.map((s) => {
    if (!/^0x[0-9a-fA-F]{8}$/.test(s)) throw new Error(`Invalid function selector: ${s}`);
    return s.toLowerCase();
  });

  const maxSpend = customConstraints?.maxSpend ?? customConstraints?.maxSpendHbar ?? 5.0;
  const maxFlow = customConstraints?.maxFlow ?? customConstraints?.maxFlowRateMonthlyUsd ?? 5000;
  const now = Date.now();
  const validAfter = options?.validAfter ?? customConstraints?.validAfter ?? now;
  const durationHours = customConstraints?.durationHours ?? 24;
  const validUntil = options?.validUntil ?? customConstraints?.validUntil ?? (validAfter + durationHours * 3600000);

  if (validAfter >= validUntil) {
    throw new Error("Invalid policy validity: validAfter must be strictly earlier than validUntil.");
  }

  const constraints: SessionPolicyConstraints = {
    maxSpend,
    maxFlow,
    allowedTargets,
    allowedSelectors,
    validAfter,
    validUntil,
    durationHours,
    allowedActions: customConstraints?.allowedActions ?? [
      "ORACLE_USPS_X402",
      "HCS_CONSENSUS_AUDIT",
      "SUBGRAPH_HOLDER_DISCOVERY",
      "CFA_YIELD_STREAM_START",
      "CFA_YIELD_STREAM_ADJUST",
      "COMPLIANCE_FREEZE",
    ],
    maxSpendHbar: maxSpend,
    maxFlowRateMonthlyUsd: maxFlow,
  };

  const targetAgent = options?.agent || HERMES_AGENT_ADDRESS;
  const validAfterSec = validAfter > 1e11 ? Math.floor(validAfter / 1000) : validAfter;
  const validUntilSec = validUntil > 1e11 ? Math.floor(validUntil / 1000) : validUntil;

  const verification = verifySessionSignature(
    grantor,
    signature,
    {
      agent: targetAgent,
      allowedTargets,
      allowedSelectors,
      maxSpend,
      maxFlow,
      validAfter: validAfterSec,
      validUntil: validUntilSec,
      nonce,
      chainId: options?.chainId,
      verifyingContract: options?.verifyingContract,
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
    allowedTargets,
    allowedSelectors,
    allowedActions: [...(constraints.allowedActions || [])],
    constraints,
    spendingLimits: {
      maxSpendHbar: maxSpend,
      maxFlowRateMonthlyUsd: maxFlow,
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
  actionOrParams: string | {
    action?: string;
    target?: string;
    selector?: string;
    spend?: number;
    flow?: number;
  },
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

  const action = typeof actionOrParams === "string" ? actionOrParams : actionOrParams.action;
  const target = typeof actionOrParams === "object" ? actionOrParams.target : undefined;
  const selector = typeof actionOrParams === "object" ? actionOrParams.selector : undefined;
  const spend = typeof actionOrParams === "object" && actionOrParams.spend !== undefined ? actionOrParams.spend : spendHbar;
  const flow = typeof actionOrParams === "object" && actionOrParams.flow !== undefined ? actionOrParams.flow : flowRateMonthly;

  const now = Date.now();

  // 1. Check Not-Yet-Valid (validAfter)
  if (session.validAfter && now < session.validAfter) {
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
    now > session.validUntil ||
    (session.expiresAt && now > session.expiresAt)
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

  // 4. Check Target Address Allowlist
  if (target) {
    const isTargetAllowed = session.constraints.allowedTargets.some(
      (t) => t.toLowerCase() === target.toLowerCase()
    );
    if (!isTargetAllowed) {
      return {
        allowed: false,
        status: 403,
        reason: `Cryptographic Policy Violation: Target '${target}' is not in the delegated whitelist.`,
        remainingHbar: Math.max(0, session.constraints.maxSpend - session.spentHbar),
        session,
      };
    }
  }

  // 5. Check Function Selector Allowlist
  if (selector) {
    const isSelectorAllowed = session.constraints.allowedSelectors.some(
      (s) => s.toLowerCase() === selector.toLowerCase()
    );
    if (!isSelectorAllowed) {
      return {
        allowed: false,
        status: 403,
        reason: `Cryptographic Policy Violation: Selector '${selector}' is not in the delegated whitelist.`,
        remainingHbar: Math.max(0, session.constraints.maxSpend - session.spentHbar),
        session,
      };
    }
  }

  // 6. Check Action Whitelist (if no target/selector provided)
  if (action && !target && !selector) {
    const allowed = (session.constraints.allowedActions || []).includes(action) ||
      (session.allowedActions || []).includes(action);
    if (!allowed) {
      return {
        allowed: false,
        status: 403,
        reason: `Cryptographic Policy Violation: Action '${action}' is not in the delegated whitelist.`,
        remainingHbar: Math.max(0, session.constraints.maxSpend - session.spentHbar),
        session,
      };
    }
  }

  // 7. Check Spend Budget Constraint
  const maxSpend = session.constraints.maxSpend ?? session.constraints.maxSpendHbar ?? 5.0;
  const remaining = maxSpend - session.spentHbar;
  if (spend > 0 && spend > remaining) {
    return {
      allowed: false,
      status: 403,
      reason: `Budget Cap Exceeded: Requested ${spend} HBAR exceeds remaining session allowance (${remaining.toFixed(2)} HBAR).`,
      remainingHbar: remaining,
      session,
    };
  }

  // 8. Check Flow Rate Ceiling Constraint
  const maxFlow = session.constraints.maxFlow ?? session.constraints.maxFlowRateMonthlyUsd ?? 5000;
  if (flow > 0 && flow > maxFlow) {
    return {
      allowed: false,
      status: 403,
      reason: `Yield Ceiling Violation: Requested monthly stream of $${flow} exceeds permitted maximum of $${maxFlow}.`,
      remainingHbar: remaining,
      session,
    };
  }

  return {
    allowed: true,
    remainingHbar: remaining - spend,
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

/**
 * Standard ERC-4337 / ERC-7579 UserOperation off-chain validation with complete parity to SessionKeyValidator.sol.
 */
export function validateUserOp(
  userOp: {
    sender: string;
    nonce: number | bigint;
    initCode?: string;
    callData: string;
    signature: string;
  },
  userOpHash: string
): { valid: boolean; validationData: number; error?: string } {
  try {
    const abiCoder = AbiCoder.defaultAbiCoder();
    const [policyTuple, grantorSig, agentSig] = abiCoder.decode(
      [
        "tuple(address grantor, address agent, address[] allowedTargets, bytes4[] allowedSelectors, uint256 maxSpend, uint256 maxFlow, uint256 validAfter, uint256 validUntil, uint256 nonce)",
        "bytes",
        "bytes"
      ],
      userOp.signature
    );

    const policy = {
      grantor: policyTuple[0],
      agent: policyTuple[1],
      allowedTargets: policyTuple[2],
      allowedSelectors: policyTuple[3],
      maxSpend: policyTuple[4],
      maxFlow: policyTuple[5],
      validAfter: Number(policyTuple[6]),
      validUntil: Number(policyTuple[7]),
      nonce: Number(policyTuple[8]),
    };

    if (userOp.sender.toLowerCase() !== policy.grantor.toLowerCase()) {
      return { valid: false, validationData: 1, error: "userOp.sender does not match policy grantor." };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < policy.validAfter) {
      return { valid: false, validationData: 1, error: "Session policy not yet valid." };
    }
    if (nowSec > policy.validUntil) {
      return { valid: false, validationData: 1, error: "Session policy expired." };
    }

    if (isGrantorNonceUsed(policy.grantor, policy.nonce)) {
      return { valid: false, validationData: 1, error: "Session policy nonce already used." };
    }

    // Verify grantor signature over policy
    const verification = verifySessionSignature(policy.grantor, grantorSig, policy);
    if (!verification.verified) {
      return { valid: false, validationData: 1, error: "Grantor signature over policy invalid." };
    }

    // Verify agent signature over userOpHash
    const recoveredAgent = recoverAddress(userOpHash, agentSig);
    if (recoveredAgent.toLowerCase() !== policy.agent.toLowerCase()) {
      return { valid: false, validationData: 1, error: "Agent signature over userOpHash invalid." };
    }

    // Inspect execution callData
    if (userOp.callData && userOp.callData.length >= 10) {
      const execSelector = userOp.callData.slice(0, 10).toLowerCase();
      let callTarget: string | undefined;
      let callValue = 0n;
      let callSelector: string | undefined;

      // execute(address,uint256,bytes) -> 0xb61d27f6
      if (execSelector === "0xb61d27f6") {
        const decoded = abiCoder.decode(["address", "uint256", "bytes"], "0x" + userOp.callData.slice(10));
        callTarget = decoded[0];
        callValue = decoded[1];
        if (decoded[2].length >= 10) {
          callSelector = decoded[2].slice(0, 10).toLowerCase();
        }
      }
      // execute(bytes32,bytes) -> 0xe9ae5c53
      else if (execSelector === "0xe9ae5c53") {
        const decoded = abiCoder.decode(["bytes32", "bytes"], "0x" + userOp.callData.slice(10));
        const execCalldata = decoded[1];
        if (execCalldata.length >= 106) {
          callTarget = getAddress("0x" + execCalldata.slice(2, 42));
          callValue = BigInt("0x" + execCalldata.slice(42, 106));
          if (execCalldata.length >= 114) {
            callSelector = "0x" + execCalldata.slice(106, 114).toLowerCase();
          }
        }
      }

      if (callTarget) {
        const isAllowed = policy.allowedTargets.some((t: string) => t.toLowerCase() === callTarget!.toLowerCase());
        if (!isAllowed) {
          return { valid: false, validationData: 1, error: `Target ${callTarget} not in allowedTargets.` };
        }
      }

      if (callSelector) {
        const isAllowed = policy.allowedSelectors.some((s: string) => s.toLowerCase() === callSelector!.toLowerCase());
        if (!isAllowed) {
          return { valid: false, validationData: 1, error: `Selector ${callSelector} not in allowedSelectors.` };
        }
      }

      if (callValue > policy.maxSpend) {
        return { valid: false, validationData: 1, error: `Spend ${callValue} exceeds policy maxSpend ${policy.maxSpend}.` };
      }
    }

    return { valid: true, validationData: 0 };
  } catch (err: any) {
    return { valid: false, validationData: 1, error: err.message };
  }
}
