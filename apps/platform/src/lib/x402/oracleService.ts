import crypto from "node:crypto";
import { logHcsAuditEvent, getAuditTopicId, type HcsAuditReceipt } from "../hedera/hcsAudit";
import { verifyHederaPaymentTransaction } from "../hedera/mirrorNode";

export type VerificationMode = "LIVE_USPS";

export interface PropertyAddressInput {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface PaymentProof {
  paymentTx?: string | null;
  invoiceId?: string;
  provenance?: "LIVE_ONCHAIN";
}

export interface OracleRequestOptions {
  mode?: "LIVE_USPS";
}

export interface X402Challenge {
  version: string;
  network: string;
  facilitator: string;
  payee: string;
  amount: string;
  unit: string;
  displayAmount: string;
  token: string;
  invoiceId: string;
  auditTopicId: string;
  instructions: string;
}

export interface InvoiceRecord {
  invoiceId: string;
  amountTinybars: string;
  displayAmount: string;
  payee: string;
  createdAt: number;
  status: "UNPAID" | "CONFIRMED";
  paymentTxId: string | null;
  provenance: "LIVE_ONCHAIN";
  verifiedAmountTinybars?: string;
  settledAt?: number;
}

declare global {
  var __x402ActiveInvoices: Map<string, InvoiceRecord> | undefined;
}

export function getActiveInvoices(): Map<string, InvoiceRecord> {
  if (!globalThis.__x402ActiveInvoices) {
    globalThis.__x402ActiveInvoices = new Map<string, InvoiceRecord>();
  }
  return globalThis.__x402ActiveInvoices;
}

export function getInvoice(invoiceId: string): InvoiceRecord | undefined {
  return getActiveInvoices().get(invoiceId);
}

export function createX402Invoice(payee?: string, amountTinybars = "50000000"): X402Challenge {
  const configuredPayee = (payee || process.env.X402_PAYEE_ACCOUNT || process.env.HEDERA_OPERATOR_ID)?.trim();
  if (!configuredPayee) {
    throw new Error("X402_CONFIG_MISSING: Hedera operator or payee account is not configured in environment (HEDERA_OPERATOR_ID or X402_PAYEE_ACCOUNT required).");
  }
  const invoiceId = `inv_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const auditTopicId = getAuditTopicId() ?? "";

  getActiveInvoices().set(invoiceId, {
    invoiceId,
    amountTinybars,
    displayAmount: "0.5 HBAR",
    payee: configuredPayee,
    createdAt: Date.now(),
    status: "UNPAID",
    paymentTxId: null,
    provenance: "LIVE_ONCHAIN",
  });

  return {
    version: "1.0",
    network: "hedera-testnet",
    facilitator: "blocky402",
    payee: configuredPayee,
    amount: amountTinybars,
    unit: "tinybar",
    displayAmount: "0.5 HBAR",
    token: "0.0.0",
    invoiceId,
    auditTopicId,
    instructions:
      "Submit 0.5 HBAR payment to payee on Hedera Testnet with invoiceId in transaction memo, then retry with X-Payment-Tx and X-Payment-Invoice headers.",
  };
}

export function recordInvoiceSettlement(
  invoiceId: string,
  txId: string,
  provenance: "LIVE_ONCHAIN" = "LIVE_ONCHAIN",
  amountTinybars?: string
): InvoiceRecord {
  const invoices = getActiveInvoices();
  const existing = invoices.get(invoiceId);
  if (!existing) {
    throw new Error("Cannot settle an unknown x402 invoice.");
  }

  if (!txId) {
    throw new Error("A live x402 settlement requires a confirmed transaction ID.");
  }
  if (amountTinybars && amountTinybars !== existing.amountTinybars) {
    throw new Error("Settlement amount does not match the invoice amount.");
  }

  existing.status = "CONFIRMED";
  existing.paymentTxId = txId;
  existing.provenance = "LIVE_ONCHAIN";
  existing.verifiedAmountTinybars = existing.amountTinybars;
  existing.settledAt = Date.now();
  return existing;
}

export interface OracleVerificationResult {
  isValid: boolean;
  dpvConfirmation: "Y" | "N" | "D" | "S";
  verificationMode: VerificationMode;
  provenance: "LIVE_ONCHAIN";
  paymentProvenance: "LIVE_ONCHAIN";
  paymentTxId: string | null;
  error?: string;
  standardizedAddress: PropertyAddressInput;
  addressHash: string;
  hcsTopicId?: string | null;
  hcsSequenceNumber?: number | null;
  hcsTxId?: string | null;
  consensusTimestamp?: string;
  network?: string;
  ownershipDisclaimer: string;
  hcsAudit: HcsAuditReceipt;
  verificationTimestamp: string;
}

export interface OracleResponse {
  status: number;
  data?: OracleVerificationResult;
  error?: string;
  code?: string;
  x402?: X402Challenge;
}

export function computeAddressHash(address: PropertyAddressInput): string {
  const canonical = [
    address.street.trim().toUpperCase(),
    address.city.trim().toUpperCase(),
    address.state.trim().toUpperCase(),
    address.zip.trim(),
  ].join("|");
  return `0x${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

export function standardizeAddressString(street: string): string {
  return street
    .trim()
    .toUpperCase()
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bROAD\b/g, "RD");
}

export interface ParsedUspsXml {
  isValid: boolean;
  dpvConfirmation: "Y" | "N" | "D" | "S";
  error?: string;
  standardizedAddress?: PropertyAddressInput;
}

export function parseUspsXmlResponse(xmlText: string): ParsedUspsXml {
  const errorMatch = xmlText.match(/<Error>[\s\S]*?<Description>(.*?)<\/Description>[\s\S]*?<\/Error>/i);
  if (errorMatch) {
    return {
      isValid: false,
      dpvConfirmation: "N",
      error: `USPS Web Tools error: ${errorMatch[1].trim()}`,
    };
  }

  const dpvMatch = xmlText.match(/<DPVConfirmation>([YNDS])<\/DPVConfirmation>/i);
  const dpvCode = (dpvMatch ? dpvMatch[1].toUpperCase() : "N") as "Y" | "N" | "D" | "S";

  const streetMatch = xmlText.match(/<Address2>(.*?)<\/Address2>/i);
  const cityMatch = xmlText.match(/<City>(.*?)<\/City>/i);
  const stateMatch = xmlText.match(/<State>(.*?)<\/State>/i);
  const zip5Match = xmlText.match(/<Zip5>(.*?)<\/Zip5>/i);
  const zip4Match = xmlText.match(/<Zip4>(.*?)<\/Zip4>/i);

  let standardizedAddress: PropertyAddressInput | undefined;
  if (streetMatch && cityMatch && stateMatch && zip5Match) {
    const zipCombined = zip4Match && zip4Match[1] ? `${zip5Match[1]}-${zip4Match[1]}` : zip5Match[1];
    standardizedAddress = {
      street: streetMatch[1].trim(),
      city: cityMatch[1].trim(),
      state: stateMatch[1].trim(),
      zip: zipCombined.trim(),
    };
  }

  const returnTextMatch = xmlText.match(/<ReturnText>(.*?)<\/ReturnText>/i);
  const returnText = returnTextMatch ? returnTextMatch[1].trim() : undefined;

  if (dpvCode === "Y") {
    return {
      isValid: true,
      dpvConfirmation: "Y",
      standardizedAddress,
    };
  } else if (dpvCode === "D") {
    return {
      isValid: false,
      dpvConfirmation: "D",
      error: returnText || "USPS DPV Code D: Primary address confirmed, but secondary unit (apartment/suite) is missing or unverified.",
      standardizedAddress,
    };
  } else if (dpvCode === "S") {
    return {
      isValid: false,
      dpvConfirmation: "S",
      error: returnText || "USPS DPV Code S: Primary address confirmed, but secondary unit was not found.",
      standardizedAddress,
    };
  } else {
    return {
      isValid: false,
      dpvConfirmation: "N",
      error: returnText || "USPS DPV Code N: Address is not deliverable by USPS.",
      standardizedAddress,
    };
  }
}

export async function queryLiveUspsApi(
  address: PropertyAddressInput,
  userId: string,
  apiUrl = "https://secure.shippingapis.com/ShippingAPI.dll"
): Promise<ParsedUspsXml> {
  const xmlPayload =
    `<AddressValidateRequest USERID="${userId}">` +
    `<Revision>1</Revision>` +
    `<Address ID="0">` +
    `<Address1></Address1>` +
    `<Address2>${address.street.trim()}</Address2>` +
    `<City>${address.city.trim()}</City>` +
    `<State>${address.state.trim()}</State>` +
    `<Zip5>${address.zip.trim().slice(0, 5)}</Zip5>` +
    `<Zip4></Zip4>` +
    `</Address>` +
    `</AddressValidateRequest>`;

  const url = `${apiUrl}?API=Verify&XML=${encodeURIComponent(xmlPayload)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        isValid: false,
        dpvConfirmation: "N",
        error: `USPS Web Tools HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const xmlResponse = await res.text();
    return parseUspsXmlResponse(xmlResponse);
  } catch (err: any) {
    if (err.name === "AbortError") {
      return {
        isValid: false,
        dpvConfirmation: "N",
        error: "USPS Web Tools API request timed out after 10 seconds.",
      };
    }
    return {
      isValid: false,
      dpvConfirmation: "N",
      error: `USPS Web Tools network error: ${err.message || String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function handlePropertyOracleRequest(
  body: PropertyAddressInput,
  proof?: PaymentProof,
  _options?: OracleRequestOptions
): Promise<OracleResponse> {
  if (!body.street || !body.city || !body.state || !body.zip) {
    return {
      status: 400,
      error: "Missing required address fields (street, city, state, zip)",
      code: "MISSING_ADDRESS_FIELDS",
    };
  }

  // Stage 1: x402 Configuration Verification
  const configuredPayee = (process.env.X402_PAYEE_ACCOUNT || process.env.HEDERA_OPERATOR_ID)?.trim();
  if (!configuredPayee) {
    return {
      status: 503,
      error: "x402 payment configuration missing: HEDERA_OPERATOR_ID or X402_PAYEE_ACCOUNT must be configured in environment.",
      code: "X402_CONFIG_MISSING",
    };
  }

  // Stage 2: Challenge vs. Payment Proof
  const invoiceId = proof?.invoiceId;
  const paymentTx = proof?.paymentTx ?? null;

  if (!proof || !invoiceId) {
    const challenge = createX402Invoice(configuredPayee);
    return {
      status: 402,
      error: "Payment Required",
      x402: challenge,
    };
  }

  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return {
      status: 402,
      error: "Payment Required: Unknown or expired invoice ID. Request a new 402 challenge.",
      code: "INVALID_INVOICE",
    };
  }

  // Stage 3: Real On-Chain Payment Verification
  let effectivePaymentTxId: string | null = null;

  if (invoice.status === "CONFIRMED") {
    effectivePaymentTxId = invoice.paymentTxId;
  } else if (paymentTx) {
    const verifyResult = await verifyHederaPaymentTransaction({
      txId: paymentTx,
      expectedPayee: invoice.payee,
      minimumAmountTinybars: BigInt(invoice.amountTinybars),
    });

    if (!verifyResult.verified) {
      return {
        status: 402,
        error: `Payment verification failed: ${verifyResult.error || "Transaction not confirmed on Hedera Testnet"}`,
        code: "UNCONFIRMED_PAYMENT",
      };
    }

    if (verifyResult.actualAmountTinybars !== BigInt(invoice.amountTinybars)) {
      return {
        status: 402,
        error: `Payment verification failed: payment amount does not exactly match the required ${invoice.amountTinybars} tinybars.`,
        code: "INVALID_PAYMENT_AMOUNT",
      };
    }

    effectivePaymentTxId = paymentTx;
    recordInvoiceSettlement(
      invoiceId,
      paymentTx,
      "LIVE_ONCHAIN",
      verifyResult.actualAmountTinybars?.toString()
    );
  } else {
    return {
      status: 402,
      error: "Payment Required: Invoice has not been settled.",
      code: "UNPAID_INVOICE",
      x402: {
        version: "1.0",
        network: "hedera-testnet",
        facilitator: "blocky402",
        payee: invoice.payee,
        amount: invoice.amountTinybars,
        unit: "tinybar",
        displayAmount: invoice.displayAmount,
        token: "0.0.0",
        invoiceId: invoice.invoiceId,
        auditTopicId: getAuditTopicId() ?? "",
        instructions:
          "Submit 0.5 HBAR payment to payee on Hedera Testnet with invoiceId in transaction memo, then retry with X-Payment-Tx and X-Payment-Invoice headers.",
      },
    };
  }

  // Stage 4: USPS Credentials Check
  const uspsUserId = process.env.USPS_USER_ID || process.env.USPS_API_KEY || "";
  if (!uspsUserId) {
    return {
      status: 503,
      error: "USPS API credentials (USPS_USER_ID) are not configured. Physical property deliverability verification requires real USPS Web Tools credentials.",
      code: "USPS_CREDENTIALS_REQUIRED",
    };
  }

  // Stage 5: Real USPS Address Verification
  const liveResult = await queryLiveUspsApi(body, uspsUserId, process.env.USPS_API_URL);
  const standardizedAddress = liveResult.standardizedAddress ?? {
    street: standardizeAddressString(body.street),
    city: body.city.trim().toUpperCase(),
    state: body.state.trim().toUpperCase(),
    zip: body.zip.trim(),
  };
  const addressHash = computeAddressHash(standardizedAddress);

  // Stage 6: Verify Actual USPS DPV Confirmation - ONLY DPV "Y" May Continue
  if (!liveResult.isValid || liveResult.dpvConfirmation !== "Y") {
    const dpvError = liveResult.error || `USPS DPV deliverability check failed with code ${liveResult.dpvConfirmation}`;
    try {
      const { recordStep1Oracle } = await import("@/lib/workflow/judgeWorkflow");
      recordStep1Oracle({
        propertyId: addressHash,
        propertyAddress: `${standardizedAddress.street}, ${standardizedAddress.city} ${standardizedAddress.state} ${standardizedAddress.zip}`,
        dpvConfirmation: liveResult.dpvConfirmation,
        paymentTxId: effectivePaymentTxId,
        isValid: false,
        error: dpvError,
      });
    } catch (err) {
      console.warn("[oracleService] Could not update workflow state on DPV failure:", err);
    }

    return {
      status: 422,
      error: dpvError,
      code: "USPS_DPV_FAILED",
      data: {
        isValid: false,
        dpvConfirmation: liveResult.dpvConfirmation,
        error: dpvError,
        standardizedAddress,
        addressHash,
        verificationMode: "LIVE_USPS",
        provenance: "LIVE_ONCHAIN",
        paymentProvenance: "LIVE_ONCHAIN",
        paymentTxId: effectivePaymentTxId,
        ownershipDisclaimer: "address deliverability verification is NOT proof of property ownership",
        hcsAudit: {
          topicId: null,
          sequenceNumber: null,
          consensusTimestamp: new Date().toISOString(),
          txId: null,
          hashscanUrl: null,
          event: "X402_PROPERTY_DPV_REJECTED",
          provenance: "LIVE_ONCHAIN",
          status: "FAILED",
          error: "DPV check failed; HCS message skipped.",
        },
        verificationTimestamp: new Date().toISOString(),
      },
    };
  }

  // Stage 7: Hedera HCS Topic & Operator Pre-Check
  const auditTopicId = getAuditTopicId();
  if (!auditTopicId) {
    const topicError = "HCS audit topic is not configured in environment (HEDERA_AUDIT_TOPIC_ID). Real HCS attestation unavailable.";
    try {
      const { recordStep1Oracle } = await import("@/lib/workflow/judgeWorkflow");
      recordStep1Oracle({
        propertyId: addressHash,
        propertyAddress: `${standardizedAddress.street}, ${standardizedAddress.city} ${standardizedAddress.state} ${standardizedAddress.zip}`,
        dpvConfirmation: "Y",
        paymentTxId: effectivePaymentTxId,
        isValid: false,
        error: topicError,
      });
    } catch {}
    return {
      status: 503,
      error: topicError,
      code: "HCS_TOPIC_UNCONFIGURED",
    };
  }

  const { isOperatorConfigured } = await import("../hedera/client");
  if (!isOperatorConfigured()) {
    const opError = "Hedera operator credentials are not configured in environment (HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY). Real HCS attestation unavailable.";
    try {
      const { recordStep1Oracle } = await import("@/lib/workflow/judgeWorkflow");
      recordStep1Oracle({
        propertyId: addressHash,
        propertyAddress: `${standardizedAddress.street}, ${standardizedAddress.city} ${standardizedAddress.state} ${standardizedAddress.zip}`,
        dpvConfirmation: "Y",
        paymentTxId: effectivePaymentTxId,
        isValid: false,
        error: opError,
      });
    } catch {}
    return {
      status: 503,
      error: opError,
      code: "HEDERA_OPERATOR_UNCONFIGURED",
    };
  }

  // Stage 8: Real HCS Message Submission & Consensus Wait
  let hcsAudit: HcsAuditReceipt;
  try {
    hcsAudit = await logHcsAuditEvent(
      {
        event: "X402_PROPERTY_DPV_VERIFIED",
        propertyId: addressHash,
        addressHash,
        actor: proof.invoiceId,
        token: "OAK-RWA",
        network: "Hedera Testnet",
        txId: effectivePaymentTxId || undefined,
        payer: proof.invoiceId,
        amount: "0.5 HBAR",
        memo: "USPS DPV physical deliverability confirmed (0.5 HBAR micropayment)",
        metadata: {
          standardizedAddress,
          dpvConfirmation: "Y",
          isValid: true,
          verificationMode: "LIVE_USPS",
          invoiceId: proof.invoiceId,
          paymentProvenance: "LIVE_ONCHAIN",
          ownershipDisclaimer: "address deliverability verification is NOT proof of property ownership",
        },
      },
      { requireLive: true }
    );
  } catch (hcsErr: any) {
    const submitError = `HCS transaction submission failed: ${hcsErr.message || String(hcsErr)}`;
    try {
      const { recordStep1Oracle } = await import("@/lib/workflow/judgeWorkflow");
      recordStep1Oracle({
        propertyId: addressHash,
        propertyAddress: `${standardizedAddress.street}, ${standardizedAddress.city} ${standardizedAddress.state} ${standardizedAddress.zip}`,
        dpvConfirmation: "Y",
        paymentTxId: effectivePaymentTxId,
        isValid: false,
        error: submitError,
      });
    } catch {}
    return {
      status: 502,
      error: submitError,
      code: "HCS_SUBMISSION_FAILED",
    };
  }

  if (hcsAudit.status !== "CONFIRMED" || !hcsAudit.sequenceNumber || !hcsAudit.txId) {
    const unconfirmedError = `HCS consensus receipt unconfirmed: ${hcsAudit.error || "Missing sequence number or transaction ID"}`;
    try {
      const { recordStep1Oracle } = await import("@/lib/workflow/judgeWorkflow");
      recordStep1Oracle({
        propertyId: addressHash,
        propertyAddress: `${standardizedAddress.street}, ${standardizedAddress.city} ${standardizedAddress.state} ${standardizedAddress.zip}`,
        dpvConfirmation: "Y",
        paymentTxId: effectivePaymentTxId,
        isValid: false,
        error: unconfirmedError,
      });
    } catch {}
    return {
      status: 502,
      error: unconfirmedError,
      code: "HCS_SUBMISSION_FAILED",
    };
  }

  // Stage 9: Persist Verification Evidence Server-Side
  const ownershipDisclaimer = "address deliverability verification is NOT proof of property ownership";

  const resultData: OracleVerificationResult = {
    isValid: true,
    dpvConfirmation: "Y",
    verificationMode: "LIVE_USPS",
    provenance: "LIVE_ONCHAIN",
    paymentProvenance: "LIVE_ONCHAIN",
    paymentTxId: effectivePaymentTxId,
    hcsTopicId: hcsAudit.topicId,
    hcsSequenceNumber: hcsAudit.sequenceNumber,
    hcsTxId: hcsAudit.txId,
    consensusTimestamp: hcsAudit.consensusTimestamp,
    network: "hedera-testnet",
    ownershipDisclaimer,
    standardizedAddress,
    addressHash,
    hcsAudit,
    verificationTimestamp: hcsAudit.consensusTimestamp,
  };

  try {
    const { recordStep1Oracle } = await import("@/lib/workflow/judgeWorkflow");
    recordStep1Oracle({
      propertyId: addressHash,
      propertyAddress: `${standardizedAddress.street}, ${standardizedAddress.city} ${standardizedAddress.state} ${standardizedAddress.zip}`,
      dpvConfirmation: "Y",
      paymentTxId: effectivePaymentTxId,
      hcsTopicId: hcsAudit.topicId,
      hcsSequenceNumber: hcsAudit.sequenceNumber,
      hcsTxId: hcsAudit.txId,
      consensusTimestamp: hcsAudit.consensusTimestamp,
      network: "hedera-testnet",
      provenance: "LIVE_ONCHAIN",
      uspsMetadata: {
        dpvConfirmation: "Y",
        standardizedAddress,
      },
      isValid: true,
    });
  } catch (err) {
    console.warn("[oracleService] Could not update workflow state:", err);
  }

  return {
    status: 200,
    data: resultData,
  };
}
