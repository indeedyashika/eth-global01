import { NextRequest, NextResponse } from "next/server";
import { logHcsAuditEvent } from "@/lib/hedera/hcsAudit";
import { handleRoute } from "@/lib/api/helpers";
import { requireOperatorSession } from "@/lib/api/sessionAuth";
import { ethers } from "ethers";
import YieldVaultArtifact from "@/lib/evm/generated/YieldVault.json";

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    requireOperatorSession(req);
    const body = await req.json();
    const propertyId = body.propertyId || "";
    const amount = Number(body.amount || 5000);
    const tenantName = body.tenantName || "Acme Residential Tenant Corp";

    const yieldVaultAddress = process.env.YIELD_VAULT_ADDRESS?.trim();
    const evmOperatorKey = process.env.EVM_OPERATOR_PRIVATE_KEY?.trim();
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL;

    // Fail closed: real rent deposit requires deployed YieldVault and operator key
    if (!yieldVaultAddress || !evmOperatorKey || !rpcUrl) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Base Sepolia YieldVault contract is not configured in environment (YIELD_VAULT_ADDRESS / EVM_OPERATOR_PRIVATE_KEY / BASE_SEPOLIA_RPC_URL). Live rent deposit cannot be executed.",
          code: "YIELD_VAULT_UNCONFIGURED",
        },
        { status: 503 }
      );
    }

    if (!propertyId) {
      return NextResponse.json(
        { success: false, error: "Property identifier (propertyId) is required.", code: "PROPERTY_REQUIRED" },
        { status: 400 }
      );
    }

    if (amount <= 0 || isNaN(amount)) {
      return NextResponse.json(
        { success: false, error: "Deposit amount must be a positive number.", code: "INVALID_AMOUNT" },
        { status: 400 }
      );
    }

    const { getWorkflowState, recordStep2RentDeposit } = await import("@/lib/workflow/judgeWorkflow");
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

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(evmOperatorKey, provider);
    const yieldVault = new ethers.Contract(yieldVaultAddress, YieldVaultArtifact.abi, signer);

    const propertyBytes32 = propertyId.startsWith("0x") && propertyId.length === 66
      ? propertyId
      : ethers.keccak256(ethers.toUtf8Bytes(propertyId));

    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tx = await yieldVault.depositRent(propertyBytes32, amountWei);
    const receipt = await tx.wait(1);

    const txHash = receipt.hash;
    const explorerUrl = `https://sepolia.basescan.org/tx/${txHash}`;
    const flowRatePerSec = amount / 2592000;

    // Log consensus receipt to Hedera Consensus Service
    const hcsReceipt = await logHcsAuditEvent({
      event: "TENANT_RENT_DEPOSITED",
      propertyId,
      amount: `$${amount} USD`,
      txId: txHash,
      metadata: {
        tenant: tenantName,
        monthlyRate: amount,
        calculatedFlowRate: flowRatePerSec,
        txHash,
        blockNumber: receipt.blockNumber,
      },
    });

    // Persist real event into sqlite audit trail
    try {
      const { insertEvent } = await import("@/lib/db/repo");
      insertEvent({
        tokenId: propertyId,
        type: "TRANSFER",
        detail: {
          action: "TENANT_RENT_DEPOSITED",
          amount: `$${amount.toLocaleString()} USD`,
          tenant: tenantName,
          flowRatePerSec,
          txHash,
          hcsSequenceNumber: hcsReceipt.sequenceNumber,
        },
        txId: txHash,
        hashscanUrl: hcsReceipt.hashscanUrl,
        provenance: "LIVE_ONCHAIN",
      });
    } catch (e) {
      console.warn("[rent deposit] Could not record event in sqlite:", e);
    }

    try {
      recordStep2RentDeposit({
        rentAmount: amount,
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
      propertyId,
      amountDeposited: amount,
      currency: "USDC (Wrapped fUSDCx)",
      calculatedFlowRate: flowRatePerSec,
      txHash,
      explorerUrl,
      hcsAudit: hcsReceipt,
      depositTimestamp: new Date().toISOString(),
    });
  });
}
