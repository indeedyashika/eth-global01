import { NextRequest, NextResponse } from "next/server";
import { logHcsAuditEvent } from "@/lib/hedera/hcsAudit";
import { handleRoute } from "@/lib/api/helpers";
import { requireOperatorSession } from "@/lib/api/sessionAuth";
import { ethers } from "ethers";
import YieldVaultArtifact from "@/lib/evm/generated/YieldVault.json";
import { getDb } from "@/lib/db";
import { insertEvent } from "@/lib/db/repo";
import { getWorkflowState, recordStep2RentDeposit } from "@/lib/workflow/judgeWorkflow";

let customProvider: ethers.Provider | null = null;

export function setProviderForTesting(provider: ethers.Provider | null) {
  customProvider = provider;
}

export function getEvmProvider(): ethers.Provider {
  if (customProvider) return customProvider;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL || "https://sepolia.base.org";
  return new ethers.JsonRpcProvider(rpcUrl);
}

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    // 1. Authorize: Session must be an authenticated operator / depositor
    const auth = requireOperatorSession(req);

    // 2. Validate deployed YieldVault contract configuration
    const yieldVaultAddress = process.env.YIELD_VAULT_ADDRESS?.trim();
    if (!yieldVaultAddress || !ethers.isAddress(yieldVaultAddress)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Base Sepolia YieldVault contract is not configured in environment (YIELD_VAULT_ADDRESS). Live rent deposit cannot be executed.",
          code: "YIELD_VAULT_UNCONFIGURED",
        },
        { status: 503 }
      );
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // 3. Precondition: Step 1 Oracle Verification must have succeeded
    const workflow = getWorkflowState();
    if (workflow.step1.status !== "SUCCESS") {
      return NextResponse.json(
        {
          success: false,
          error: "Step 1 Oracle Verification is required before depositing rent. Complete Step 1 first.",
          code: "STEP1_ORACLE_REQUIRED",
        },
        { status: 400 }
      );
    }

    // 4. Replay protection: check if txHash has already been processed and settled
    const db = getDb();
    if (body.txHash) {
      const existingTx = db.prepare("SELECT id FROM rent_deposits WHERE tx_hash = ?").get(body.txHash);
      if (existingTx) {
        return NextResponse.json(
          {
            success: false,
            error: `Transaction replay detected: transaction hash ${body.txHash} has already been settled.`,
            code: "TRANSACTION_REPLAYED",
          },
          { status: 409 }
        );
      }
    }

    // 5. Duplicate deposit protection: step 2 already completed
    if (workflow.step2.status === "SUCCESS") {
      return NextResponse.json(
        {
          success: false,
          error: "Duplicate deposit: Rent deposit of $5,000 has already been confirmed and settled for this property.",
          code: "DUPLICATE_DEPOSIT",
        },
        { status: 409 }
      );
    }

    // 6. Authoritative property derivation & client validation
    const authoritativePropertyId = workflow.step1.propertyId || "prop_456_oak_ave";
    const clientPropertyId = body.propertyId ? String(body.propertyId).trim() : authoritativePropertyId;
    if (clientPropertyId !== authoritativePropertyId) {
      return NextResponse.json(
        {
          success: false,
          error: `Property mismatch: expected verified property '${authoritativePropertyId}', received '${clientPropertyId}'.`,
          code: "PROPERTY_MISMATCH",
        },
        { status: 400 }
      );
    }

    // 7. Authoritative amount validation: strictly canonical $5,000
    const rawAmount = body.amount !== undefined ? Number(body.amount) : 5000;
    if (rawAmount !== 5000 || isNaN(rawAmount) || rawAmount <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Deposit amount must be strictly $5,000 for canonical judge flow. Received: ${body.amount}`,
          code: "INVALID_RENT_AMOUNT",
        },
        { status: 400 }
      );
    }
    const amount = 5000;

    // 8. Network validation
    if (body.chainId !== undefined && Number(body.chainId) !== 84532) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid network chain ID ${body.chainId}. Deposit must be executed on Base Sepolia (chainId 84532).`,
          code: "WRONG_NETWORK",
        },
        { status: 400 }
      );
    }
    if (body.network !== undefined && !["Base Sepolia", "base-sepolia", "84532"].includes(String(body.network))) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid network '${body.network}'. Deposit must be executed on Base Sepolia.`,
          code: "WRONG_NETWORK",
        },
        { status: 400 }
      );
    }

    // 9. Contract parameters
    const propertyBytes32 =
      authoritativePropertyId.startsWith("0x") && authoritativePropertyId.length === 66
        ? authoritativePropertyId
        : ethers.keccak256(ethers.toUtf8Bytes(authoritativePropertyId));
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tenantName = body.tenantName || "Acme Residential Tenant Corp";

    const provider = getEvmProvider();
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== 84532) {
      return NextResponse.json(
        {
          success: false,
          error: `Provider network chain ID is ${net.chainId}. Expected Base Sepolia (84532).`,
          code: "WRONG_NETWORK",
        },
        { status: 400 }
      );
    }

    let txHash: string;
    let receipt: ethers.TransactionReceipt | null;
    let depositorAddress = auth?.grantor || "0xAuthorizedDepositor";

    if (body.txHash) {
      // User signed & submitted via wallet: verify on-chain receipt & calldata
      txHash = body.txHash;
      receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return NextResponse.json(
          {
            success: false,
            error: "Transaction receipt not found or still pending confirmation.",
            code: "TRANSACTION_NOT_FOUND",
          },
          { status: 400 }
        );
      }
      if (Number(receipt.status) === 0) {
        return NextResponse.json(
          {
            success: false,
            error: "Transaction reverted on Base Sepolia.",
            code: "TRANSACTION_FAILED",
          },
          { status: 422 }
        );
      }
      if (receipt.to?.toLowerCase() !== yieldVaultAddress.toLowerCase()) {
        return NextResponse.json(
          {
            success: false,
            error: `Transaction recipient (${receipt.to}) does not match configured YieldVault (${yieldVaultAddress}).`,
            code: "WRONG_CONTRACT",
          },
          { status: 400 }
        );
      }

      // Verify transaction calldata parameters
      const tx = await provider.getTransaction(txHash);
      if (tx && tx.data && tx.data.length >= 10) {
        const iface = new ethers.Interface(YieldVaultArtifact.abi);
        try {
          const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
          if (parsed) {
            if (parsed.name !== "depositRent") {
              return NextResponse.json(
                {
                  success: false,
                  error: `Invalid contract method: expected 'depositRent', called '${parsed.name}'.`,
                  code: "WRONG_METHOD",
                },
                { status: 400 }
              );
            }
            if (parsed.args[0] !== propertyBytes32) {
              return NextResponse.json(
                {
                  success: false,
                  error: "Transaction calldata propertyId does not match authoritative property.",
                  code: "WRONG_PROPERTY",
                },
                { status: 400 }
              );
            }
            if (parsed.args[1] !== amountWei) {
              return NextResponse.json(
                {
                  success: false,
                  error: "Transaction calldata amount does not match canonical $5,000 rent.",
                  code: "WRONG_AMOUNT",
                },
                { status: 400 }
              );
            }
          }
        } catch (parseErr: any) {
          if (parseErr?.message?.includes("Transaction")) {
            throw parseErr;
          }
        }
      }
      depositorAddress = receipt.from || depositorAddress;
    } else {
      // Server-side operator execution
      const evmOperatorKey = process.env.EVM_OPERATOR_PRIVATE_KEY?.trim();
      if (!evmOperatorKey) {
        return NextResponse.json(
          {
            success: false,
            error: "EVM_OPERATOR_PRIVATE_KEY is not configured for server-signed deposit.",
            code: "EVM_OPERATOR_UNCONFIGURED",
          },
          { status: 503 }
        );
      }
      const signer = new ethers.Wallet(evmOperatorKey, provider);
      depositorAddress = await signer.getAddress();
      const yieldVault = new ethers.Contract(yieldVaultAddress, YieldVaultArtifact.abi, signer);
      const tx = await yieldVault.depositRent(propertyBytes32, amountWei);
      receipt = await tx.wait(1);
      if (!receipt || Number(receipt.status) === 0) {
        return NextResponse.json(
          {
            success: false,
            error: "Transaction reverted on Base Sepolia.",
            code: "TRANSACTION_FAILED",
          },
          { status: 422 }
        );
      }
      txHash = receipt.hash;
    }

    const flowRatePerSec = amount / 2592000;
    const explorerUrl = `https://sepolia.basescan.org/tx/${txHash}`;

    // 10. Log consensus receipt to Hedera Consensus Service
    const hcsReceipt = await logHcsAuditEvent({
      event: "TENANT_RENT_DEPOSITED",
      propertyId: authoritativePropertyId,
      amount: "$5,000 USD",
      txId: txHash,
      metadata: {
        tenant: tenantName,
        monthlyRate: 5000,
        calculatedFlowRate: flowRatePerSec,
        txHash,
        blockNumber: receipt?.blockNumber,
        network: "Base Sepolia",
        chainId: 84532,
      },
    });

    // 11. Authoritative rent accounting: record into rent_deposits table
    try {
      db.prepare(`
        INSERT INTO rent_deposits (
          property_id,
          vault_address,
          depositor_address,
          amount_usd,
          amount_wei,
          flow_rate_per_sec,
          tx_hash,
          network,
          chain_id,
          block_number,
          hcs_topic_id,
          hcs_sequence_number,
          status,
          provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        authoritativePropertyId,
        yieldVaultAddress,
        depositorAddress,
        5000,
        amountWei.toString(),
        flowRatePerSec,
        txHash,
        "Base Sepolia",
        84532,
        receipt?.blockNumber || null,
        hcsReceipt.topicId || null,
        hcsReceipt.sequenceNumber ? Number(hcsReceipt.sequenceNumber) : null,
        "CONFIRMED",
        "LIVE_ONCHAIN"
      );
    } catch (insertErr: any) {
      if (insertErr.message?.includes("UNIQUE") || insertErr.message?.includes("tx_hash")) {
        return NextResponse.json(
          {
            success: false,
            error: `Transaction replay detected: transaction hash ${txHash} has already been settled.`,
            code: "TRANSACTION_REPLAYED",
          },
          { status: 409 }
        );
      }
      console.warn("[rent deposit] rent_deposits insert warning:", insertErr);
    }

    // 12. Persist real event into sqlite audit trail
    try {
      insertEvent({
        tokenId: authoritativePropertyId,
        type: "TRANSFER",
        detail: {
          action: "TENANT_RENT_DEPOSITED",
          amount: "$5,000 USD",
          tenant: tenantName,
          flowRatePerSec,
          txHash,
          hcsSequenceNumber: hcsReceipt.sequenceNumber,
          network: "Base Sepolia",
          chainId: 84532,
        },
        txId: txHash,
        hashscanUrl: hcsReceipt.hashscanUrl,
        provenance: "LIVE_ONCHAIN",
      });
    } catch (e) {
      console.warn("[rent deposit] Could not record event in sqlite:", e);
    }

    // 13. Unlock Step 3 in authoritative judge workflow state
    try {
      recordStep2RentDeposit({
        rentAmount: 5000,
        txHash,
        vaultAddress: yieldVaultAddress,
        hcsSequenceNumber: hcsReceipt.sequenceNumber ? Number(hcsReceipt.sequenceNumber) : null,
        success: true,
      });
    } catch (e) {
      console.warn("[rent deposit] Could not update workflow state:", e);
    }

    return NextResponse.json({
      success: true,
      propertyId: authoritativePropertyId,
      amountDeposited: 5000,
      currency: "USDC (Wrapped fUSDCx)",
      calculatedFlowRate: flowRatePerSec,
      vaultAddress: yieldVaultAddress,
      network: "Base Sepolia",
      chainId: 84532,
      txHash,
      explorerUrl,
      hcsAudit: hcsReceipt,
      depositTimestamp: new Date().toISOString(),
    });
  });
}
