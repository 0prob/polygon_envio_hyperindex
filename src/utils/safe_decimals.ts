/** Clamp ERC-20 decimals to uint8 range; default 18 when unknown/invalid. */
export function safeDecimals(value: unknown, fallback = 18): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 255) return fallback;
  return Math.trunc(n);
}
