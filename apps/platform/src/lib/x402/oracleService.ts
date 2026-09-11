import crypto from "node:crypto";
import { logHcsAuditEvent, type HcsAuditReceipt } from "../hedera/hcsAudit";
import { verifyHederaPaymentTransaction } from "../hedera/mirrorNode";

export type VerificationMode = "LIVE_USPS" | "SIMULATED_USPS";

export interface PropertyAddressInput {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface PaymentProof {
  paymentTx?: string | null;
  invoiceId?: string;
  provenance?: "LIVE_ONCHAIN" | "SIMULATED";
}

export interface OracleRequestOptions {
  mode?: "LIVE_USPS" | "SIMULATED_USPS" | "AUTO";
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
  status: "UNPAID" | "CONFIRMED" | "SIMULATED";
  paymentTxId: string | null;
  provenance: "LIVE_ONCHAIN" | "SIMULATED";
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
  const invoiceId = `inv_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const payeeAccount = payee || process.env.HEDERA_OPERATOR_ID || "0.0.4491823";
  getActiveInvoices().set(invoiceId, {
    invoiceId,
    amountTinybars,
    displayAmount: "0.5 HBAR",
    payee: payeeAccount,
    createdAt: Date.now(),
    status: "UNPAID",
    paymentTxId: null,
    provenance: "SIMULATED",
  });

  return {
    version: "1.0",
    network: "hedera-testnet",
    facilitator: "blocky402",
    payee: payeeAccount,
    amount: amountTinybars,
    unit: "tinybar",
    displayAmount: "0.5 HBAR",
    token: "0.0.0",
    invoiceId,
    auditTopicId: process.env.HEDERA_AUDIT_TOPIC_ID || "0.0.4491823",
    instructions:
      "Submit 0.5 HBAR payment to payee on Hedera Testnet with invoiceId in transaction memo, then retry with X-Payment-Tx and X-Payment-Invoice headers.",
  };
}

export function recordInvoiceSettlement(
  invoiceId: string,
  txId: string | null,
  provenance: "LIVE_ONCHAIN" | "SIMULATED",
  amountTinybars?: string
): InvoiceRecord {
  const invoices = getActiveInvoices();
  const existing = invoices.get(invoiceId);
  if (!existing) {
    throw new Error("Cannot settle an unknown x402 invoice.");
  }

  // A live receipt is the only evidence that can make an invoice CONFIRMED. In
  // particular, never turn a client-supplied formatted transaction ID into a
  // paid invoice merely because it looks like a Hedera transaction ID.
  if (provenance === "LIVE_ONCHAIN" && !txId) {
    throw new Error("A live x402 settlement requires a confirmed transaction ID.");
  }
  if (provenance === "SIMULATED" && txId) {
    throw new Error("A simulated x402 settlement must not contain a transaction ID.");
  }
  if (amountTinybars && amountTinybars !== existing.amountTinybars) {
    throw new Error("Settlement amount does not match the invoice amount.");
  }

  existing.status = provenance === "LIVE_ONCHAIN" ? "CONFIRMED" : "SIMULATED";
  existing.paymentTxId = txId;
  existing.provenance = provenance;
  existing.verifiedAmountTinybars = existing.amountTinybars;
  existing.settledAt = Date.now();
  return existing;
}

export interface OracleVerificationResult {
  isValid: boolean;
  dpvConfirmation: "Y" | "N" | "D" | "S";
  verificationMode: VerificationMode;
  provenance: "LIVE_ONCHAIN" | "SIMULATED";
  paymentProvenance: "LIVE_ONCHAIN" | "SIMULATED";
  paymentTxId: string | null;
  isSimulated: boolean;
  simulationNotice?: string;
  error?: string;
  standardizedAddress: PropertyAddressInput;
  addressHash: string;
  hcsAudit: HcsAuditReceipt;
  verificationTimestamp: string;
}

export interface OracleResponse {
  status: 200 | 400 | 402 | 503;
  error?: string;
  x402?: X402Challenge;
  data?: OracleVerificationResult;
}

// Whitelisted deterministic demo fixtures for SIMULATED_USPS mode
export const DEMO_PROPERTY_FIXTURES: Array<{
  matchNumber: string;
  matchStreet: string;
  city: string;
  state: string;
  zip: string;
  standardizedStreet: string;
}> = [
  {
    matchNumber: "456",
    matchStreet: "OAK",
    city: "MIAMI",
    state: "FL",
    zip: "33101",
    standardizedStreet: "456 OAK AVE",
  },
  {
    matchNumber: "100",
    matchStreet: "OCEAN",
    city: "MIAMI BEACH",
    state: "FL",
    zip: "33139",
    standardizedStreet: "100 OCEAN DR",
  },
  {
    matchNumber: "1200",
    matchStreet: "BRICKELL",
    city: "MIAMI",
    state: "FL",
    zip: "33131",
    standardizedStreet: "1200 BRICKELL AVE",
  },
  {
    matchNumber: "100",
    matchStreet: "BISCAYNE",
    city: "MIAMI",
    state: "FL",
    zip: "33132",
    standardizedStreet: "100 BISCAYNE BLVD",
  },
];

export function computeAddressHash(address: PropertyAddressInput): string {
  const normalized = `${address.street.trim().toUpperCase()}|${address.city.trim().toUpperCase()}|${address.state.trim().toUpperCase()}|${address.zip.trim()}`;
  return `0x${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

export function standardizeAddressString(street: string): string {
  return street
    .trim()
    .toUpperCase()
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bPLACE\b/g, "PL");
}

export function isDemoFixture(address: PropertyAddressInput): {
  matched: boolean;
  standardizedStreet?: string;
} {
  const upperStreet = address.street.trim().toUpperCase();
  const upperCity = address.city.trim().toUpperCase();
  const upperState = address.state.trim().toUpperCase();
  const zip = address.zip.trim().slice(0, 5);

  for (const fixture of DEMO_PROPERTY_FIXTURES) {
    if (
      upperCity === fixture.city &&
      upperState === fixture.state &&
      zip === fixture.zip &&
      upperStreet.includes(fixture.matchNumber) &&
      upperStreet.includes(fixture.matchStreet)
    ) {
      return { matched: true, standardizedStreet: fixture.standardizedStreet };
    }
  }

  return { matched: false };
}

export interface ParsedUspsXml {
  isValid: boolean;
  dpvConfirmation: "Y" | "N" | "D" | "S";
  error?: string;
  standardizedAddress?: PropertyAddressInput;
}

export function parseUspsXmlResponse(xmlText: string): ParsedUspsXml {
  // Check for root or nested error tags
  const errorMatch = xmlText.match(/<Error>[\s\S]*?<Description>(.*?)<\/Description>[\s\S]*?<\/Error>/i);
  if (errorMatch) {
    return {
      isValid: false,
      dpvConfirmation: "N",
      error: `USPS Web Tools error: ${errorMatch[1].trim()}`,
    };
  }

  // Check for DPVConfirmation code
  const dpvMatch = xmlText.match(/<DPVConfirmation>([YNDS])<\/DPVConfirmation>/i);
  const dpvCode = (dpvMatch ? dpvMatch[1].toUpperCase() : "N") as "Y" | "N" | "D" | "S";

  // Extract address elements if returned
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

  // Check for ReturnText warnings / notices
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
  options?: OracleRequestOptions
): Promise<OracleResponse> {
  if (!body.street || !body.city || !body.state || !body.zip) {
    return {
      status: 400,
      error: "Missing required address fields (street, city, state, zip)",
    };
  }

  // Step 1: Check for payment proof and invoice
  const invoiceId = proof?.invoiceId;
  const paymentTx = proof?.paymentTx ?? null;
  const requestedProvenance = proof?.provenance;

  if (!proof || !invoiceId) {
    const challenge = createX402Invoice();
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
    };
  }

  // Step 2: Server-side Payment Verification
  // Requirement 4: Verify the payment amount server-side.
  // Requirement 5: Do not trust the client to claim that payment was completed.
  // Requirement 6: Do not mark the oracle request as paid until settlement is actually confirmed.
  let effectivePaymentTxId: string | null = null;
  let effectivePaymentProvenance: "LIVE_ONCHAIN" | "SIMULATED" = "SIMULATED";

  if (invoice.status === "CONFIRMED") {
    // Already confirmed by server-side settlement engine (/api/x402/settle)
    effectivePaymentTxId = invoice.paymentTxId;
    effectivePaymentProvenance = "LIVE_ONCHAIN";
  } else if (invoice.status === "SIMULATED") {
    // Explicit simulation mode confirmed server-side via /api/x402/settle: enforce txId must be null
    // Requirement 3: If actual settlement cannot be performed: return SIMULATED, txId must be null, do not generate a fake transaction ID.
    effectivePaymentTxId = null;
    effectivePaymentProvenance = "SIMULATED";
  } else if (paymentTx) {
    // Client claims live on-chain payment with external transaction ID
    // Requirement 5: Do not trust the client to claim that payment was completed.
    // Verify against Hedera Mirror Node
    const verifyResult = await verifyHederaPaymentTransaction({
      txId: paymentTx,
      expectedPayee: invoice.payee,
      minimumAmountTinybars: BigInt(invoice.amountTinybars),
    });

    if (!verifyResult.verified) {
      return {
        status: 402,
        error: `Payment verification failed: ${verifyResult.error || "Transaction not confirmed on Hedera Testnet"}`,
      };
    }

    if (verifyResult.actualAmountTinybars !== BigInt(invoice.amountTinybars)) {
      return {
        status: 402,
        error: `Payment verification failed: payment amount does not exactly match the required ${invoice.amountTinybars} tinybars.`,
      };
    }

    effectivePaymentTxId = paymentTx;
    effectivePaymentProvenance = "LIVE_ONCHAIN";
    recordInvoiceSettlement(
      invoiceId,
      paymentTx,
      "LIVE_ONCHAIN",
      verifyResult.actualAmountTinybars?.toString()
    );
  } else {
    // Invoice exists but is UNPAID and no valid payment proof was provided
    return {
      status: 402,
      error: "Payment Required: Invoice has not been settled.",
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
        auditTopicId: process.env.HEDERA_AUDIT_TOPIC_ID || "0.0.4491823",
        instructions:
          "Submit 0.5 HBAR payment to payee on Hedera Testnet with invoiceId in transaction memo, then retry with X-Payment-Tx and X-Payment-Invoice headers.",
      },
    };
  }

  // Determine verification mode
  const uspsUserId = process.env.USPS_USER_ID || process.env.USPS_API_KEY || "";
  const requestedMode = options?.mode ?? "AUTO";

  let effectiveMode: VerificationMode;
  if (requestedMode === "LIVE_USPS") {
    if (!uspsUserId) {
      return {
        status: 503,
        error: "LIVE_USPS mode requested, but USPS API credentials (USPS_USER_ID) are not configured on this server.",
      };
    }
    effectiveMode = "LIVE_USPS";
  } else if (requestedMode === "SIMULATED_USPS") {
    effectiveMode = "SIMULATED_USPS";
  } else {
    // AUTO: Prefer LIVE_USPS if credentials exist; otherwise SIMULATED_USPS
    effectiveMode = uspsUserId ? "LIVE_USPS" : "SIMULATED_USPS";
  }

  // Execute Verification based on effective mode
  let isValid = false;
  let dpvConfirmation: "Y" | "N" | "D" | "S" = "N";
  let standardizedAddress: PropertyAddressInput;
  let simulationNotice: string | undefined;
  let verificationError: string | undefined;

  if (effectiveMode === "LIVE_USPS") {
    const liveResult = await queryLiveUspsApi(body, uspsUserId, process.env.USPS_API_URL);
    isValid = liveResult.isValid;
    dpvConfirmation = liveResult.dpvConfirmation;
    verificationError = liveResult.error;
    standardizedAddress = liveResult.standardizedAddress ?? {
      street: standardizeAddressString(body.street),
      city: body.city.trim().toUpperCase(),
      state: body.state.trim().toUpperCase(),
      zip: body.zip.trim(),
    };
  } else {
    // SIMULATED_USPS mode: Deterministic demo fixture verification
    const isExplicitlyInvalid =
      body.street.toLowerCase().includes("invalid") ||
      body.street.toLowerCase().includes("fake") ||
      body.zip === "00000" ||
      body.zip.trim().length < 5;

    if (isExplicitlyInvalid) {
      isValid = false;
      dpvConfirmation = "N";
      verificationError = "Invalid address format or non-deliverable test address indicator.";
      standardizedAddress = {
        street: standardizeAddressString(body.street),
        city: body.city.trim().toUpperCase(),
        state: body.state.trim().toUpperCase(),
        zip: body.zip.trim(),
      };
    } else {
      const fixtureCheck = isDemoFixture(body);
      if (fixtureCheck.matched) {
        isValid = true;
        dpvConfirmation = "Y";
        standardizedAddress = {
          street: fixtureCheck.standardizedStreet || standardizeAddressString(body.street),
          city: body.city.trim().toUpperCase(),
          state: body.state.trim().toUpperCase(),
          zip: body.zip.trim(),
        };
        simulationNotice = "Simulated USPS address verification for registered demo fixture. Live USPS Web Tools credentials required for arbitrary address verification.";
      } else {
        // Arbitrary 5-digit ZIPs do NOT automatically return DPV Y!
        isValid = false;
        dpvConfirmation = "N";
        verificationError = "Address not in simulated demo fixture catalog. Arbitrary address validation requires LIVE_USPS mode with configured USPS_USER_ID.";
        standardizedAddress = {
          street: standardizeAddressString(body.street),
          city: body.city.trim().toUpperCase(),
          state: body.state.trim().toUpperCase(),
          zip: body.zip.trim(),
        };
        simulationNotice = "Simulated USPS verification: Arbitrary non-catalog address rejected.";
      }
    }
  }

  const addressHash = computeAddressHash(standardizedAddress);

  // Generate verifiable HCS audit receipt on Hedera Consensus Service
  const hcsAudit = await logHcsAuditEvent({
    event: "X402_PAYMENT_VERIFIED",
    propertyId: addressHash,
    addressHash,
    txId: effectivePaymentTxId,
    payer: proof.invoiceId,
    amount: "0.5 HBAR",
    metadata: {
      standardizedAddress,
      dpvConfirmation,
      isValid,
      verificationMode: effectiveMode,
      invoiceId: proof.invoiceId,
      paymentProvenance: effectivePaymentProvenance,
    },
  });

  const provenance = effectiveMode === "LIVE_USPS" && effectivePaymentProvenance === "LIVE_ONCHAIN" && hcsAudit.provenance === "LIVE_ONCHAIN"
    ? "LIVE_ONCHAIN"
    : "SIMULATED";

  const resultData: OracleVerificationResult = {
    isValid,
    dpvConfirmation,
    verificationMode: effectiveMode,
    provenance,
    paymentProvenance: effectivePaymentProvenance,
    paymentTxId: effectivePaymentTxId,
    isSimulated: effectiveMode === "SIMULATED_USPS" || effectivePaymentProvenance === "SIMULATED",
    simulationNotice,
    error: verificationError,
    standardizedAddress,
    addressHash,
    hcsAudit,
    verificationTimestamp: new Date().toISOString(),
  };

  return {
    status: 200,
    data: resultData,
  };
}
