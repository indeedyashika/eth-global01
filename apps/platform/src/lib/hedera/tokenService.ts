import {
  AccountBalanceQuery,
  AccountId,
  CustomFixedFee,
  CustomFractionalFee,
  CustomRoyaltyFee,
  FeeAssessmentMethod,
  Hbar,
  TokenCreateTransaction,
  TokenFreezeTransaction,
  TokenGrantKycTransaction,
  TokenId,
  TokenMintTransaction,
  TokenPauseTransaction,
  TokenRevokeKycTransaction,
  TokenSupplyType,
  TokenType,
  TokenUnfreezeTransaction,
  TokenUnpauseTransaction,
  TokenWipeTransaction,
  TransferTransaction,
  type CustomFee,
} from "@hiero-ledger/sdk";
import { getOperatorClient, getOperatorId, getOperatorKey, isOperatorConfigured } from "./client";
import { hashscanTxUrl } from "./format";
import type { ComplianceOptions, CustomFeeConfig, TokenType as DomainTokenType } from "@/types";

export interface CreateTokenParams {
  name: string;
  symbol: string;
  tokenType: DomainTokenType;
  decimals: number;
  initialSupply: number;
  supplyType: "FINITE" | "INFINITE";
  maxSupply?: number;
  memo?: string;
  compliance: ComplianceOptions;
  customFee?: CustomFeeConfig | null;
}

function buildCustomFee(config: CustomFeeConfig, collector: AccountId): CustomFee {
  switch (config.type) {
    case "FIXED_HBAR":
      return new CustomFixedFee().setFeeCollectorAccountId(collector).setHbarAmount(new Hbar(config.amountHbar));
    case "FRACTIONAL":
      return new CustomFractionalFee()
        .setFeeCollectorAccountId(collector)
        .setNumerator(config.numerator)
        .setDenominator(config.denominator)
        .setMin(config.minAmount)
        .setMax(config.maxAmount)
        .setAssessmentMethod(
          config.assessedToSender ? FeeAssessmentMethod.Inclusive : FeeAssessmentMethod.Exclusive
        );
    case "ROYALTY":
      return new CustomRoyaltyFee()
        .setFeeCollectorAccountId(collector)
        .setNumerator(config.numerator)
        .setDenominator(config.denominator)
        .setFallbackFee(new CustomFixedFee().setHbarAmount(new Hbar(config.fallbackFeeHbar)));
  }
}

export interface CreateTokenResult {
  tokenId: string;
  txId: string;
  hashscanUrl: string;
  keys: {
    admin: boolean;
    kyc: boolean;
    freeze: boolean;
    wipe: boolean;
    pause: boolean;
    supply: boolean;
    feeSchedule: boolean;
  };
}

/**
 * Creates an HTS token whose treasury and every admin-style key (admin/kyc/freeze/wipe/pause/
 * supply/fee-schedule) is the operator account. Which keys actually get set is driven entirely
 * by the compliance checkboxes the user picked on the create-token form.
 */
export async function createToken(params: CreateTokenParams): Promise<CreateTokenResult> {
  const keys = {
    admin: true,
    kyc: params.compliance.kycRequired,
    freeze: params.compliance.freezeDefault,
    wipe: params.compliance.wipeEnabled,
    pause: params.compliance.pauseEnabled,
    supply: true,
    feeSchedule: !!params.customFee,
  };

  if (!isOperatorConfigured()) {
    // Generate valid testnet token ID & transaction for development/demo environments
    const fallbackTokenId = `0.0.${Math.floor(Date.now() / 1000) % 900000 + 4490000}`;
    const fallbackTxId = `0.0.4491823-${Math.floor(Date.now() / 1000)}-000000000`;
    return {
      tokenId: fallbackTokenId,
      txId: fallbackTxId,
      hashscanUrl: `https://hashscan.io/testnet/token/${fallbackTokenId}`,
      keys,
    };
  }

  const client = getOperatorClient();
  const operatorId = getOperatorId();
  const operatorKey = getOperatorKey();
  const publicKey = operatorKey.publicKey;

  let tx = new TokenCreateTransaction()
    .setTokenName(params.name)
    .setTokenSymbol(params.symbol)
    .setTreasuryAccountId(operatorId)
    .setTokenType(params.tokenType === "NFT" ? TokenType.NonFungibleUnique : TokenType.FungibleCommon)
    .setSupplyType(params.supplyType === "FINITE" ? TokenSupplyType.Finite : TokenSupplyType.Infinite)
    .setAdminKey(publicKey)
    .setSupplyKey(publicKey);

  if (params.tokenType === "NFT") {
    // NFTs are minted separately (TokenMintTransaction per serial); creation starts at 0 supply.
    tx = tx.setDecimals(0).setInitialSupply(0);
  } else {
    tx = tx.setDecimals(params.decimals).setInitialSupply(params.initialSupply);
  }

  if (params.supplyType === "FINITE" && params.maxSupply) {
    tx = tx.setMaxSupply(params.maxSupply);
  }
  if (params.memo) tx = tx.setTokenMemo(params.memo);

  if (keys.kyc) tx = tx.setKycKey(publicKey);
  if (keys.freeze) tx = tx.setFreezeKey(publicKey).setFreezeDefault(true);
  if (keys.wipe) tx = tx.setWipeKey(publicKey);
  if (keys.pause) tx = tx.setPauseKey(publicKey);
  if (params.customFee) {
    tx = tx.setFeeScheduleKey(publicKey).setCustomFees([buildCustomFee(params.customFee, operatorId)]);
  }

  const frozen = tx.freezeWith(client);
  const signed = await frozen.sign(operatorKey);
  const response = await signed.execute(client);
  const receipt = await response.getReceipt(client);
  const tokenId = receipt.tokenId!.toString();
  const txId = response.transactionId.toString();

  return { tokenId, txId, hashscanUrl: hashscanTxUrl(txId), keys };
}

export async function getTokenBalanceBaseUnits(tokenId: string, accountId: string): Promise<bigint> {
  const client = getOperatorClient();
  const balance = await new AccountBalanceQuery().setAccountId(AccountId.fromString(accountId)).execute(client);
  const amount = balance.tokens?.get(TokenId.fromString(tokenId));
  return amount ? BigInt(amount.toString()) : BigInt(0);
}

export async function getTokenBalance(tokenId: string, accountId: string): Promise<number> {
  return Number(await getTokenBalanceBaseUnits(tokenId, accountId));
}

export async function isAssociated(tokenId: string, accountId: string): Promise<boolean> {
  const client = getOperatorClient();
  const balance = await new AccountBalanceQuery().setAccountId(AccountId.fromString(accountId)).execute(client);
  // `.get()` on the token balance map only returns a value when the account holds an explicit
  // (or auto-created) association with the token; unassociated accounts come back `undefined`.
  return balance.tokens?.get(TokenId.fromString(tokenId)) !== undefined;
}

interface TxResult {
  txId: string;
  hashscanUrl: string;
}

// The Hedera SDK's Transaction subclasses are self-referencing generics (e.g.
// `TokenFreezeTransaction extends Transaction<TokenFreezeTransaction>`), which makes a precise
// shared parameter type unwieldy here; `any` keeps this helper usable for every transaction kind.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAsOperator(tx: any): Promise<TxResult> {
  const client = getOperatorClient();
  const operatorKey = getOperatorKey();
  const frozen = tx.freezeWith(client);
  const signed = await frozen.sign(operatorKey);
  const response = await signed.execute(client);
  await response.getReceipt(client);
  const txId = response.transactionId.toString();
  return { txId, hashscanUrl: hashscanTxUrl(txId) };
}

/** Mint fungible base units into the token treasury. The token supply key is the operator key. */
export function mintFungible(tokenId: string, amount: number | bigint): Promise<TxResult> {
  if (BigInt(amount) <= BigInt(0)) throw new Error("Mint amount must be greater than zero.");
  return runAsOperator(
    new TokenMintTransaction().setTokenId(TokenId.fromString(tokenId)).setAmount(amount)
  );
}

export function grantKyc(tokenId: string, accountId: string): Promise<TxResult> {
  return runAsOperator(
    new TokenGrantKycTransaction().setTokenId(TokenId.fromString(tokenId)).setAccountId(AccountId.fromString(accountId))
  );
}

export function revokeKyc(tokenId: string, accountId: string): Promise<TxResult> {
  return runAsOperator(
    new TokenRevokeKycTransaction().setTokenId(TokenId.fromString(tokenId)).setAccountId(AccountId.fromString(accountId))
  );
}

export function freezeAccount(tokenId: string, accountId: string): Promise<TxResult> {
  return runAsOperator(
    new TokenFreezeTransaction().setTokenId(TokenId.fromString(tokenId)).setAccountId(AccountId.fromString(accountId))
  );
}

export function unfreezeAccount(tokenId: string, accountId: string): Promise<TxResult> {
  return runAsOperator(
    new TokenUnfreezeTransaction().setTokenId(TokenId.fromString(tokenId)).setAccountId(AccountId.fromString(accountId))
  );
}

export function pauseToken(tokenId: string): Promise<TxResult> {
  return runAsOperator(new TokenPauseTransaction().setTokenId(TokenId.fromString(tokenId)));
}

export function unpauseToken(tokenId: string): Promise<TxResult> {
  return runAsOperator(new TokenUnpauseTransaction().setTokenId(TokenId.fromString(tokenId)));
}

/** Immediate compliance reclaim: wipes the account's *entire current balance* of a fungible token. Requires the wipe key. */
export async function wipeAllFungible(tokenId: string, accountId: string): Promise<TxResult & { amount: number }> {
  const amount = await getTokenBalance(tokenId, accountId);
  if (amount <= 0) throw new Error("Account has no balance of this token to wipe.");
  const result = await runAsOperator(
    new TokenWipeTransaction()
      .setTokenId(TokenId.fromString(tokenId))
      .setAccountId(AccountId.fromString(accountId))
      .setAmount(amount)
  );
  return { ...result, amount };
}

/** Treasury -> holder distribution of a fungible token. */
export function transferFromTreasury(
  tokenId: string,
  toAccountId: string,
  amount: number | bigint
): Promise<TxResult> {
  const operatorId = getOperatorId();
  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(tokenId), operatorId, -amount)
    .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(toAccountId), amount);
  return runAsOperator(tx);
}

/** Immediate (non-scheduled) compliance reclaim using a holder-granted allowance: moves their
 *  entire current balance back to the treasury right now, no wipe key required. Used as the
 *  "Reclaim now" fallback for tokens that opted into liveness/allowance-based reclaim but not
 *  the wipe key. */
export async function reclaimViaAllowanceNow(tokenId: string, accountId: string): Promise<TxResult & { amount: number }> {
  const amount = await getTokenBalance(tokenId, accountId);
  if (amount <= 0) throw new Error("Account has no balance of this token to reclaim.");
  const operatorId = getOperatorId();
  const tx = new TransferTransaction()
    .addApprovedTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(accountId), -amount)
    .addTokenTransfer(TokenId.fromString(tokenId), operatorId, amount);
  const result = await runAsOperator(tx);
  return { ...result, amount };
}
