/** Sentinel: type probes permanently failed — bot can live-RPC; do not wedge repair/recon. */
export const BALANCER_POOL_TYPE_UNKNOWN = "unknown";

/** True when a Balancer PoolMeta row is missing type, fee, or a usable token list. */
export function isIncompletePoolMeta(existing: {
  poolType?: string | null;
  fee?: number | null;
  tokens?: readonly string[] | null;
}): boolean {
  // "unknown" counts as type-resolved (permanent unclassifiable → bot hydrates).
  const typeMissing =
    existing.poolType == null ||
    existing.poolType === "";
  const missingFee = existing.fee == null;
  const thinTokens = !existing.tokens || existing.tokens.length < 2;
  return typeMissing || missingFee || thinTokens;
}
