/**
 * Simple in-memory sliding-window rate limiter for the holder-facing token
 * chat route (`/api/tokens/[tokenId]/chat`). The chat data itself is public
 * (subgraph/Mirror Node reads), so this isn't a data-security control — it's
 * cost/abuse control on the LLM calls it triggers.
 *
 * In-memory and per-process: fine for a single Railway instance (this whole
 * deployment already assumes one container/one volume — see server.py). A
 * multi-instance deployment would need a shared store instead.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;

const hits = new Map<string, number[]>();

/** Returns true if `key` (e.g. `${tokenId}:${accountId}`) is still under the
 *  rate limit, recording this call as a hit. Returns false if the caller
 *  should be rejected (limit exceeded) — the caller is NOT recorded as a hit
 *  in that case, so a rejected burst doesn't extend its own window. */
export function checkChatRateLimit(key: string, now: number = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // Opportunistic cleanup so long-running processes don't accumulate keys for
  // wallets that stopped chatting — cheap relative to how rarely this path
  // fires per key (at most MAX_REQUESTS_PER_WINDOW times a minute).
  if (hits.size > 10_000) {
    for (const [k, timestamps] of hits) {
      if (timestamps.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  return true;
}
