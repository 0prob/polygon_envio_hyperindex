/**
 * Helpers to minimize redundant HyperIndex DB writes.
 * PoolMeta is always written on discovery; TokenMeta is written only for confirmed decimals.
 */

import { safeDecimals } from "./safe_decimals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TokenMetaContext = {
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    set: (entity: { id: string; address: string; decimals: number }) => void;
  };
};

export interface TokenMetaWrite {
  address: string;
  decimals: number;
  /** True when decimals came from registry, discovered file, or successful RPC — not a failure default. */
  trusted?: boolean;
}

function shouldPersistTokenMeta(
  existing: { decimals?: number } | undefined,
  decimals: number,
  trusted: boolean,
): boolean {
  const dec = safeDecimals(decimals);
  if (existing?.decimals != null) {
    // Upgrade stale Hasura defaults (preload/RPC failure) when we learn the real value.
    return existing.decimals === 18 && dec !== 18;
  }
  if (dec !== 18) return true;
  return trusted;
}

export async function setTokenMetaIfMissing(
  context: TokenMetaContext,
  address: string,
  decimals: number,
  trusted = false,
): Promise<void> {
  const addr = address.toLowerCase();
  const existing = await context.TokenMeta.get(addr);
  if (!shouldPersistTokenMeta(existing, decimals, trusted)) return;
  context.TokenMeta.set({ id: addr, address: addr, decimals: safeDecimals(decimals) });
}

export async function setTokenMetasIfMissing(
  context: TokenMetaContext,
  tokens: readonly string[],
  decimals: readonly number[],
  trusted?: readonly boolean[],
): Promise<void> {
  await setTokenMetaEntriesIfMissing(
    context,
    tokens.map((address, i) => ({
      address,
      decimals: decimals[i]!,
      trusted: trusted?.[i] ?? false,
    })),
  );
}

export async function setTokenMetaEntriesIfMissing(
  context: TokenMetaContext,
  entries: readonly TokenMetaWrite[],
): Promise<void> {
  const seen = new Set<string>();
  const normalized: TokenMetaWrite[] = [];
  for (const entry of entries) {
    const addr = entry.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    normalized.push({
      address: addr,
      decimals: safeDecimals(entry.decimals),
      trusted: entry.trusted ?? false,
    });
  }
  const existing = await Promise.all(normalized.map((e) => context.TokenMeta.get(e.address)));
  for (let i = 0; i < normalized.length; i++) {
    const entry = normalized[i]!;
    if (!shouldPersistTokenMeta(existing[i], entry.decimals, entry.trusted ?? false)) continue;
    context.TokenMeta.set({
      id: entry.address,
      address: entry.address,
      decimals: safeDecimals(entry.decimals),
    });
  }
}
