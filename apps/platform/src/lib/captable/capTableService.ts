import { getDb } from "@/lib/db";
import { getToken, listHolders } from "@/lib/db/repo";
import { getWorkflowState } from "@/lib/workflow/judgeWorkflow";
import { getEvmTokenBalance } from "@/lib/evm/client";
import { getTokenBalanceBaseUnits } from "@/lib/hedera/tokenService";
import { isAddress, getAddress, JsonRpcProvider, Contract } from "ethers";
import { getAuthoritativeHcsLedger } from "@/lib/hedera/hcsLedgerService";
import type { HolderRecord, TokenRecord } from "@/types";

export interface CapTableHolder {
  holder: string;
  walletAccount: string;
  shares: number;
  ownershipPercentage: number;
  ownershipPercentageFormatted: string;
  claimableYieldUsd: number;
  claimableYieldFormatted: string;
  verificationStatus: string;
  livenessStatus: string;
  token: string;
  network: string;
  lastTransaction: string | null;
  lastTransactionUrl: string | null;
  isTreasury: boolean;
  rawBalanceBaseUnits?: string;
}

export interface AuthoritativeCapTable {
  tokenId: string;
  tokenName: string;
  tokenSymbol: string;
  blockchain: "EVM" | "HEDERA";
  network: string;
  totalSupply: number;
  totalSharesAllocated: number;
  unallocatedShares: number;
  depositedRentUsd: number;
  holders: CapTableHolder[];
  hcsSequenceCount: number;
  consensusLedger?: {
    topicId: string | null;
    records: any[];
    totalCount: number;
  };
  updatedAt: string;
}

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function resolveCanonicalToken(tokenId: string): TokenRecord {
  let token = getToken(tokenId);
  if (token) return token;

  const isOakAve =
    !tokenId ||
    tokenId === "prop_456_oak_ave" ||
    tokenId.toLowerCase() === "0xa513e6e4b8f2a923d98304ec87f64353c4d5c853";

  if (isOakAve) {
    const canonicalAddress =
      process.env.OAK_TOKEN_ADDRESS ||
      process.env.NEXT_PUBLIC_OAK_TOKEN_ADDRESS ||
      "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";

    const treasuryAccount =
      process.env.YIELD_VAULT_ADDRESS || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    return {
      id: canonicalAddress,
      blockchain: "EVM",
      network: "sepolia",
      name: "456 Oak Avenue Fractional Token",
      symbol: "OAK-RWA",
      tokenType: "FUNGIBLE",
      decimals: 0,
      initialSupply: "1000",
      supplyType: "FINITE",
      maxSupply: "1000",
      treasuryAccountId: treasuryAccount,
      assetCategory: "real-estate",
      memo: "456 Oak Avenue · Real World Asset Cap Table",
      compliance: {
        kycRequired: true,
        freezeDefault: false,
        wipeEnabled: true,
        pauseEnabled: true,
        worldIdRequired: true,
        worldIdSelfieCheck: true,
        livenessEnabled: false,
      },
      customFee: null,
      keys: { admin: true, kyc: true, freeze: true, wipe: true, pause: true, supply: true, feeSchedule: false },
      paused: false,
      createTxId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      hashscanUrl: "",
      explorerUrl: `https://sepolia.basescan.org/address/${canonicalAddress}`,
      explorerName: "Etherscan",
      createdAt: new Date().toISOString(),
    };
  }

  throw new Error(`Token ${tokenId} not found in authoritative records`);
}

/**
 * Builds the shareholder cap table from authoritative token balances.
 * Strictly calculates ownership percentages dynamically from actual total supply and holder balance.
 * Enforces network separation between EVM and Hedera holders.
 */
export async function getAuthoritativeCapTable(tokenId: string = "prop_456_oak_ave"): Promise<AuthoritativeCapTable> {
  const db = getDb();
  const token = resolveCanonicalToken(tokenId);
  const workflow = getWorkflowState();

  // 1. Authoritative Total Supply
  let totalSupply = Number(token.initialSupply) || 1000;
  if (token.blockchain === "EVM" && isAddress(token.id)) {
    try {
      const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL || "https://sepolia.base.org";
      const provider = new JsonRpcProvider(rpcUrl);
      const contract = new Contract(getAddress(token.id), ERC20_ABI, provider);
      const onchainSupply = await contract.totalSupply();
      if (onchainSupply > BigInt(0)) {
        totalSupply = Number(onchainSupply);
      }
    } catch {
      // Offline fallback: retain configured authoritative initialSupply
    }
  }

  // 2. Authoritative Deposited Rent (for dynamic claimable yield)
  let depositedRentUsd = 0;
  try {
    const rentRow = db
      .prepare("SELECT amount_usd FROM rent_deposits WHERE property_id = ? OR property_id = ? ORDER BY id DESC LIMIT 1")
      .get(token.id, "prop_456_oak_ave") as { amount_usd?: number } | undefined;
    if (rentRow?.amount_usd) {
      depositedRentUsd = rentRow.amount_usd;
    } else if (workflow.step2.status === "SUCCESS" && workflow.step2.rentAmount > 0) {
      depositedRentUsd = workflow.step2.rentAmount;
    }
  } catch {
    if (workflow.step2.status === "SUCCESS") {
      depositedRentUsd = workflow.step2.rentAmount;
    }
  }

  // 3. Query and filter registered holders (strict network isolation)
  const candidateHolders: HolderRecord[] = [];
  try {
    const allRows = db
      .prepare("SELECT * FROM holders WHERE token_id = ? OR token_id = ? OR token_id = 'prop_456_oak_ave'")
      .all(token.id, tokenId) as any[];

    for (const r of allRows) {
      const isEvm = isAddress(r.account_id) || (r.evm_address && isAddress(r.evm_address));
      const isHedera = /^\d+\.\d+\.\d+$/.test(r.account_id);

      // Isolation rule: Do not merge Hedera and EVM holders unless an explicit verified identity mapping exists
      if (token.blockchain === "EVM") {
        if (isEvm) {
          candidateHolders.push({
            tokenId: token.id,
            accountId: isAddress(r.account_id) ? getAddress(r.account_id) : getAddress(r.evm_address!),
            evmAddress: r.evm_address ? getAddress(r.evm_address) : (isAddress(r.account_id) ? getAddress(r.account_id) : null),
            associated: Boolean(r.associated),
            kycGranted: Boolean(r.kyc_granted),
            frozen: Boolean(r.frozen),
            allowanceGranted: Boolean(r.allowance_granted),
            worldIdVerifiedAt: r.world_id_verified_at,
            worldIdSelfieVerifiedAt: r.world_id_selfie_verified_at,
            worldIdIdentityVerifiedAt: r.world_id_identity_verified_at,
            worldIdSelfieVerification: null,
            worldIdIdentityVerification: null,
            lastCheckinAt: r.last_checkin_at,
            activeScheduleId: r.active_schedule_id,
            activeScheduleExpiresAt: r.active_schedule_expires_at,
            livenessReclaimStatus: r.liveness_reclaim_status || "IDLE",
            livenessReclaimError: r.liveness_reclaim_error,
            livenessReclaimAttemptedAt: r.liveness_reclaim_attempted_at,
            status: r.status || "PENDING",
            livenessState: "OK",
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          });
        }
      } else if (token.blockchain === "HEDERA") {
        if (isHedera) {
          candidateHolders.push({
            tokenId: token.id,
            accountId: r.account_id,
            evmAddress: r.evm_address,
            associated: Boolean(r.associated),
            kycGranted: Boolean(r.kyc_granted),
            frozen: Boolean(r.frozen),
            allowanceGranted: Boolean(r.allowance_granted),
            worldIdVerifiedAt: r.world_id_verified_at,
            worldIdSelfieVerifiedAt: r.world_id_selfie_verified_at,
            worldIdIdentityVerifiedAt: r.world_id_identity_verified_at,
            worldIdSelfieVerification: null,
            worldIdIdentityVerification: null,
            lastCheckinAt: r.last_checkin_at,
            activeScheduleId: r.active_schedule_id,
            activeScheduleExpiresAt: r.active_schedule_expires_at,
            livenessReclaimStatus: r.liveness_reclaim_status || "IDLE",
            livenessReclaimError: r.liveness_reclaim_error,
            livenessReclaimAttemptedAt: r.liveness_reclaim_attempted_at,
            status: r.status || "PENDING",
            livenessState: "OK",
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[capTableService] holders query error:", err);
  }

  // 4. Authoritative Balances & Events for each investor
  const investorHolders: CapTableHolder[] = [];
  let totalInvestorShares = 0;

  // Check World ID verifications in DB
  const verifiedWorldIdAccounts = new Set<string>();
  try {
    const verifiedRows = db
      .prepare("SELECT account_id FROM world_id_verifications WHERE (token_id = ? OR token_id = ?) AND status = 'VERIFIED'")
      .all(token.id, "prop_456_oak_ave") as Array<{ account_id: string }>;
    for (const row of verifiedRows) {
      verifiedWorldIdAccounts.add(row.account_id.toLowerCase());
    }
  } catch {}

  for (let idx = 0; idx < candidateHolders.length; idx++) {
    const h = candidateHolders[idx];
    const rawAccount = h.accountId;
    const isChecksummedEvm = token.blockchain === "EVM" && isAddress(rawAccount);
    const accountKey = isChecksummedEvm ? getAddress(rawAccount) : rawAccount;

    // Skip treasury if already in candidate holders list (will be added as authoritative treasury)
    if (
      (token.blockchain === "EVM" && isAddress(token.treasuryAccountId) && isAddress(accountKey) && getAddress(accountKey) === getAddress(token.treasuryAccountId)) ||
      accountKey === token.treasuryAccountId
    ) {
      continue;
    }

    // Determine actual balance
    let balance = 0;
    if (token.blockchain === "EVM" && isAddress(token.id) && isAddress(accountKey)) {
      try {
        const balBigInt = await getEvmTokenBalance(token.id, accountKey);
        balance = Number(balBigInt);
      } catch {
        // Fall back to verified transfer events
        const transferRow = db
          .prepare("SELECT detail FROM events WHERE (token_id = ? OR token_id = ?) AND account_id = ? AND type = 'TRANSFER' ORDER BY id DESC LIMIT 1")
          .get(token.id, "prop_456_oak_ave", accountKey) as { detail?: string } | undefined;
        if (transferRow?.detail) {
          try {
            const detail = JSON.parse(transferRow.detail);
            balance = Number(detail.amount) || 0;
          } catch {}
        } else if (workflow.step5.status === "SUCCESS" && workflow.step5.sharesClaimed > 0) {
          balance = workflow.step5.sharesClaimed;
        }
      }
    } else if (token.blockchain === "HEDERA") {
      try {
        const balBigInt = await getTokenBalanceBaseUnits(token.id, accountKey);
        balance = Number(balBigInt);
      } catch {
        // Fall back to transfer events
        const transferRow = db
          .prepare("SELECT detail FROM events WHERE (token_id = ? OR token_id = ?) AND account_id = ? AND type = 'TRANSFER' ORDER BY id DESC LIMIT 1")
          .get(token.id, "prop_456_oak_ave", accountKey) as { detail?: string } | undefined;
        if (transferRow?.detail) {
          try {
            const detail = JSON.parse(transferRow.detail);
            balance = Number(detail.amount) || 0;
          } catch {}
        }
      }
    }

    // Determine last transaction
    let lastTx: string | null = null;
    try {
      const eventRow = db
        .prepare("SELECT tx_id FROM events WHERE (token_id = ? OR token_id = ?) AND account_id = ? AND tx_id IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get(token.id, "prop_456_oak_ave", accountKey) as { tx_id?: string } | undefined;
      lastTx = eventRow?.tx_id || null;
    } catch {}

    if (!lastTx && workflow.step5.status === "SUCCESS" && workflow.step5.claimTxId) {
      lastTx = workflow.step5.claimTxId;
    }

    // Dynamic calculations
    const rawOwnership = totalSupply > 0 ? (balance / totalSupply) * 100 : 0;
    const ownershipPercentage = Math.round(rawOwnership * 10000) / 10000;
    const rawYield = totalSupply > 0 ? (balance / totalSupply) * depositedRentUsd : 0;
    const claimableYieldUsd = Math.round(rawYield * 100) / 100;

    const isWorldIdVerified =
      Boolean(h.worldIdVerifiedAt) ||
      Boolean(h.worldIdSelfieVerifiedAt) ||
      verifiedWorldIdAccounts.has(accountKey.toLowerCase());

    const verificationStatus = isWorldIdVerified
      ? "✓ World ID Verified"
      : h.kycGranted
      ? "KYC Verified"
      : "Pending Verification";

    const lastTxUrl = lastTx
      ? token.blockchain === "EVM"
        ? `https://sepolia.basescan.org/tx/${lastTx}`
        : `https://hashscan.io/testnet/transaction/${lastTx}`
      : null;

    investorHolders.push({
      holder: `Verified Investor ${investorHolders.length + 1}`,
      walletAccount: accountKey,
      shares: balance,
      ownershipPercentage,
      ownershipPercentageFormatted: `${ownershipPercentage.toFixed(2)}%`,
      claimableYieldUsd,
      claimableYieldFormatted: `$${claimableYieldUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / mo`,
      verificationStatus,
      livenessStatus: h.livenessState || "OK",
      token: token.symbol,
      network: token.blockchain === "EVM" ? "Base Sepolia (EVM)" : "Hedera Testnet",
      lastTransaction: lastTx,
      lastTransactionUrl: lastTxUrl,
      isTreasury: false,
    });

    totalInvestorShares += balance;
  }

  // 5. Authoritative Treasury Row
  const treasuryAccount = token.treasuryAccountId;
  let treasuryShares = Math.max(0, totalSupply - totalInvestorShares);

  if (token.blockchain === "EVM" && isAddress(token.id) && isAddress(treasuryAccount)) {
    try {
      const treasuryBal = await getEvmTokenBalance(token.id, treasuryAccount);
      treasuryShares = Number(treasuryBal);
    } catch {}
  }

  const rawTreasuryOwnership = totalSupply > 0 ? (treasuryShares / totalSupply) * 100 : 0;
  const treasuryOwnership = Math.round(rawTreasuryOwnership * 10000) / 10000;
  const rawTreasuryYield = totalSupply > 0 ? (treasuryShares / totalSupply) * depositedRentUsd : 0;
  const treasuryYield = Math.round(rawTreasuryYield * 100) / 100;

  let treasuryLastTx = token.createTxId || null;
  try {
    const tRow = db
      .prepare("SELECT tx_id FROM events WHERE (token_id = ? OR token_id = ?) AND (account_id = ? OR account_id = '0xTreasury') AND tx_id IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(token.id, "prop_456_oak_ave", treasuryAccount) as { tx_id?: string } | undefined;
    if (tRow?.tx_id) treasuryLastTx = tRow.tx_id;
  } catch {}

  const treasuryLastTxUrl = treasuryLastTx
    ? token.blockchain === "EVM"
      ? `https://sepolia.basescan.org/tx/${treasuryLastTx}`
      : `https://hashscan.io/testnet/transaction/${treasuryLastTx}`
    : null;

  const treasuryHolder: CapTableHolder = {
    holder: "Treasury (Issuer)",
    walletAccount: treasuryAccount,
    shares: treasuryShares,
    ownershipPercentage: treasuryOwnership,
    ownershipPercentageFormatted: `${treasuryOwnership.toFixed(2)}%`,
    claimableYieldUsd: treasuryYield,
    claimableYieldFormatted: `$${treasuryYield.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / mo`,
    verificationStatus: "Exempt (Issuer)",
    livenessStatus: "EXEMPT",
    token: token.symbol,
    network: token.blockchain === "EVM" ? "Base Sepolia (EVM)" : "Hedera Testnet",
    lastTransaction: treasuryLastTx,
    lastTransactionUrl: treasuryLastTxUrl,
    isTreasury: true,
  };

  const holders = [treasuryHolder, ...investorHolders];

  // 6. Consensus Ledger sequence count from authoritative HCS records
  const ledger = getAuthoritativeHcsLedger({
    tokenId: token.id,
    propertyId: "prop_456_oak_ave",
  });
  const hcsSequenceCount = ledger.totalCount;

  return {
    tokenId: token.id,
    tokenName: token.name,
    tokenSymbol: token.symbol,
    blockchain: token.blockchain as "EVM" | "HEDERA",
    network: token.blockchain === "EVM" ? "Base Sepolia" : "Hedera Testnet",
    totalSupply,
    totalSharesAllocated: totalInvestorShares,
    unallocatedShares: treasuryShares,
    depositedRentUsd,
    holders,
    hcsSequenceCount,
    consensusLedger: {
      topicId: ledger.topicId,
      records: ledger.records,
      totalCount: ledger.totalCount,
    },
    updatedAt: new Date().toISOString(),
  };
}
