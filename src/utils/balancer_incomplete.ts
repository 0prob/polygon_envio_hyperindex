/** True when a Balancer PoolMeta row is missing type, fee, or a usable token list. */
export function isIncompletePoolMeta(existing: {
  poolType?: string | null;
  fee?: number | null;
  tokens?: readonly string[] | null;
}): boolean {
  const missingType = existing.poolType == null || existing.poolType === "";
  const missingFee = existing.fee == null;
  const thinTokens = !existing.tokens || existing.tokens.length < 2;
  return missingType || missingFee || thinTokens;
}
