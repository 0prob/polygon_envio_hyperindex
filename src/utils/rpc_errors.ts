/** Lightweight RPC error classification for HyperIndex effects (mirrors bot retry.ts). */

export function isQuotaError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("monthly") ||
    msg.includes("capacity") ||
    msg.includes("quota") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

export function isNetworkError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("http request failed") ||
    /\b50[0-9]\b/.test(msg)
  );
}
