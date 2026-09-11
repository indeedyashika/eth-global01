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
