type TokenAllowance = {
  amount: number | string;
  owner: string;
  spender: string;
  token_id: string;
};

type TokenAllowanceResponse = {
  allowances?: TokenAllowance[];
};

function mirrorNodeBaseUrl(): string {
  const network = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase();
  if (!new Set(["mainnet", "testnet", "previewnet"]).has(network)) {
    throw new Error(`Unsupported Hedera network for Mirror Node: ${network}`);
  }
  return `https://${network}.mirrornode.hedera.com`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for Mirror Node consensus indexing and return the live fungible allowance. This keeps a
 * caller from marking an allowance as granted by posting an arbitrary transaction id. */
export async function waitForTokenAllowance(params: {
  ownerAccountId: string;
  spenderAccountId: string;
  tokenId: string;
  minimumAmount: bigint;
}): Promise<bigint> {
  const query = new URLSearchParams({
    "spender.id": params.spenderAccountId,
    "token.id": params.tokenId,
    limit: "1",
  });
  const url = `${mirrorNodeBaseUrl()}/api/v1/accounts/${params.ownerAccountId}/allowances/tokens?${query}`;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(`Hedera Mirror Node allowance lookup failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as TokenAllowanceResponse;
    const allowance = body.allowances?.find(
      (item) =>
        item.owner === params.ownerAccountId &&
        item.spender === params.spenderAccountId &&
        item.token_id === params.tokenId
    );
    const amount = allowance ? BigInt(String(allowance.amount)) : BigInt(0);
    if (amount >= params.minimumAmount) return amount;
    if (attempt < 11) await delay(1_000);
  }
  throw new Error(
    `The confirmed Hedera allowance is below the required ${params.minimumAmount.toString()} base units.`
  );
}

export interface VerifyPaymentResult {
  verified: boolean;
  actualAmountTinybars?: bigint;
  payer?: string | null;
  error?: string;
}

export function formatTxIdForMirrorNode(txId: string): string {
  // Converts 0.0.12345@1741234567.890000000 to 0.0.12345-1741234567-890000000
  return txId.trim().replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

export async function verifyHederaPaymentTransaction(params: {
  txId: string;
  expectedPayee: string;
  minimumAmountTinybars: bigint;
}): Promise<VerifyPaymentResult> {
  const normalizedId = formatTxIdForMirrorNode(params.txId);
  const url = `${mirrorNodeBaseUrl()}/api/v1/transactions/${encodeURIComponent(normalizedId)}`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    if (response.status === 404) {
      return { verified: false, error: "Transaction not found on Hedera network" };
    }

    if (!response.ok) {
      return {
        verified: false,
        error: `Mirror Node returned HTTP ${response.status} when querying transaction ${params.txId}`,
      };
    }

    const body = (await response.json()) as {
      transactions?: Array<{
        transaction_id: string;
        result: string;
        transfers?: Array<{ account: string; amount: number | string }>;
      }>;
    };

    const txs = body.transactions || [];
    if (txs.length === 0) {
      return { verified: false, error: "No transaction records found on Hedera network" };
    }

    const successfulTx = txs.find((t) => t.result === "SUCCESS");
    if (!successfulTx) {
      return {
        verified: false,
        error: `Transaction failed on-chain with status: ${txs[0]?.result || "FAILED"}`,
      };
    }

    // Verify transfers to expectedPayee
    const transfers = successfulTx.transfers || [];
    let totalPaidToPayee = BigInt(0);
    let payer: string | null = null;

    for (const transfer of transfers) {
      const amount = BigInt(String(transfer.amount));
      if (transfer.account === params.expectedPayee && amount > BigInt(0)) {
        totalPaidToPayee += amount;
      }
      if (amount < BigInt(0) && !payer) {
        payer = transfer.account;
      }
    }

    if (totalPaidToPayee < params.minimumAmountTinybars) {
      return {
        verified: false,
        actualAmountTinybars: totalPaidToPayee,
        payer,
        error: `Payment to ${params.expectedPayee} is ${totalPaidToPayee.toString()} tinybars, which is below the required ${params.minimumAmountTinybars.toString()} tinybars.`,
      };
    }

    return {
      verified: true,
      actualAmountTinybars: totalPaidToPayee,
      payer,
    };
  } catch (err: any) {
    return {
      verified: false,
      error: `Failed to verify transaction with Hedera Mirror Node: ${err.message || String(err)}`,
    };
  }
}
