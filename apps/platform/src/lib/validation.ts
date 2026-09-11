import { z } from "zod";

const assetCategorySchema = z.enum([
  "securities",
  "real-estate",
  "invoices",
  "carbon-credits",
  "commodities",
  "other",
]);

const worldIdNationalitySchema = z.enum([
  "ARG",
  "AUS",
  "CHL",
  "COL",
  "CRI",
  "GBR",
  "HRV",
  "ITA",
  "JPN",
  "KOR",
  "MEX",
  "MYS",
  "PAN",
  "PRT",
  "SGP",
  "USA",
]);

const customFeeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("FIXED_HBAR"), amountHbar: z.number().positive() }),
  z.object({
    type: z.literal("FRACTIONAL"),
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
    minAmount: z.number().nonnegative(),
    maxAmount: z.number().positive(),
    assessedToSender: z.boolean(),
  }),
  z.object({
    type: z.literal("ROYALTY"),
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
    fallbackFeeHbar: z.number().nonnegative(),
  }),
]);

export const complianceSchema = z
  .object({
    kycRequired: z.boolean(),
    freezeDefault: z.boolean(),
    wipeEnabled: z.boolean(),
    pauseEnabled: z.boolean(),
    worldIdRequired: z.boolean(),
    worldIdSelfieCheck: z.boolean().default(false),
    worldIdMinimumAge: z.number().int().min(1).max(120).optional(),
    worldIdNationality: worldIdNationalitySchema.optional(),
    livenessEnabled: z.boolean(),
    livenessPeriodSeconds: z.number().int().min(60).optional(),
  })
  .refine((c) => !c.livenessEnabled || !!c.livenessPeriodSeconds, {
    message: "livenessPeriodSeconds is required when livenessEnabled is true",
    path: ["livenessPeriodSeconds"],
  })
  .refine(
    (c) =>
      !c.livenessEnabled ||
      (c.worldIdRequired && c.worldIdSelfieCheck),
    {
      message: "Recurring liveness requires World ID Selfie Check",
      path: ["livenessEnabled"],
    }
  )
  .refine((c) => !c.worldIdRequired || c.kycRequired || c.freezeDefault, {
    message:
      "World ID verification needs a whitelisting mechanism to gate — enable KYC and/or freeze-by-default too",
    path: ["worldIdRequired"],
  })
  .refine(
    (c) =>
      !c.worldIdRequired ||
      c.worldIdSelfieCheck ||
      c.worldIdMinimumAge != null ||
      c.worldIdNationality != null,
    {
      message: "World ID requires Selfie Check, a minimum age, and/or a nationality condition",
      path: ["worldIdRequired"],
    }
  )
  .refine(
    (c) =>
      c.worldIdRequired ||
      (!c.worldIdSelfieCheck &&
        c.worldIdMinimumAge == null &&
        c.worldIdNationality == null),
    {
      message: "Enable worldIdRequired when configuring a World ID check",
      path: ["worldIdRequired"],
    }
  );

export const createTokenSchema = z
  .object({
    blockchain: z.enum(["HEDERA", "EVM"]).default("HEDERA"),
    name: z.string().trim().min(1).max(100),
    symbol: z.string().trim().min(1).max(20),
    tokenType: z.enum(["FUNGIBLE", "NFT"]),
    decimals: z.number().int().min(0).max(18),
    initialSupply: z.number().int().min(0),
    supplyType: z.enum(["FINITE", "INFINITE"]),
    maxSupply: z.number().int().positive().optional(),
    assetCategory: assetCategorySchema,
    memo: z.string().trim().max(100).optional(),
    compliance: complianceSchema,
    customFee: customFeeSchema.optional(),
    existingTokenId: z.string().optional(),
    createTxId: z.string().optional(),
    treasuryAccountId: z.string().optional(),
    walletSignature: z.string().optional(),
  })
  .refine((v) => v.supplyType === "INFINITE" || !!v.maxSupply, {
    message: "maxSupply is required for a finite supply token",
    path: ["maxSupply"],
  })
  .refine((v) => !v.compliance.livenessEnabled || v.tokenType === "FUNGIBLE", {
    message: "Recurring Selfie Check currently supports fungible tokens only",
    path: ["tokenType"],
  })
  .refine((v) => v.tokenType === "NFT" || v.initialSupply >= 0, { message: "invalid initialSupply" });

export const createEvmTokenSchema = createTokenSchema
  .refine((v) => v.blockchain === "EVM", {
    message: "blockchain must be EVM for the Sepolia deployment endpoint",
    path: ["blockchain"],
  })
  .refine((v) => v.tokenType === "FUNGIBLE", {
    message: "Sepolia V1 supports fungible ERC-20 tokens only",
    path: ["tokenType"],
  })
  .refine((v) => !v.customFee, {
    message: "HTS custom fees are not available on the Sepolia ERC-20 adapter",
    path: ["customFee"],
  });

export const accountIdSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, "must be a Hedera account id like 0.0.1234");

export const evmAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 20-byte EVM address");

export const walletIdentifierSchema = z.union([accountIdSchema, evmAddressSchema]);

export const registerHolderSchema = z.object({
  accountId: walletIdentifierSchema,
  evmAddress: z.string().trim().optional(),
});

export const createTokenRequestSchema = z.object({
  accountId: walletIdentifierSchema,
});

export const tokenRequestStatusSchema = z.enum(["PENDING", "PROCESSING", "FULFILLED", "REJECTED"]);

export const rejectTokenRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const txReceiptSchema = z.object({
  txId: z.string().trim().min(1),
});

export const allowanceReceiptSchema = txReceiptSchema.extend({
  amount: z.number().int().positive(),
});

export const transferSchema = z.object({
  accountId: walletIdentifierSchema,
  amount: z.number().int().positive(),
});

export const pauseSchema = z.object({
  paused: z.boolean(),
});
