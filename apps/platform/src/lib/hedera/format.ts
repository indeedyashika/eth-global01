function network(): string {
  return process.env.HEDERA_NETWORK ?? "testnet";
}

export function hashscanTokenUrl(tokenId: string): string {
  return `https://hashscan.io/${network()}/token/${tokenId}`;
}

export function hashscanAccountUrl(accountId: string): string {
  return `https://hashscan.io/${network()}/account/${accountId}`;
}

export function hashscanTxUrl(txId: string): string {
  // Hedera SDK transaction IDs look like "0.0.1234@1690000000.000000000";
  // HashScan wants the "@" and "." between seconds/nanos turned into dashes.
  const normalized = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return `https://hashscan.io/${network()}/transaction/${normalized}`;
}

export function hashscanScheduleUrl(scheduleId: string): string {
  return `https://hashscan.io/${network()}/schedule/${scheduleId}`;
}
