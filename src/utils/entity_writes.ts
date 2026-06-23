/**
 * Helpers to minimize redundant HyperIndex DB writes.
 * PoolMeta is always written on discovery; TokenMeta is written only for confirmed decimals.
 */

import { normalizeTokenAddress } from "./normalize_address";
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
  const addr = normalizeTokenAddress(address);
  const existing = await context.TokenMeta.get(addr);
  if (!shouldPersistTokenMeta(existing, decimals, trusted)) return;
  context.TokenMeta.set({ id: addr, address: addr, decimals: safeDecimals(decimals) });
}

export async function setTokenMetasIfMissing(
  context: TokenMetaContext,
  tokens: readonly string[],
  decimals: readonly number[],
  trusted?: readonly boolean[],
  preloadedByAddr?: Map<string, { decimals?: number } | undefined>,
): Promise<void> {
  await setTokenMetaEntriesIfMissing(
    context,
    tokens.map((address, i) => ({
      address,
      decimals: decimals[i]!,
      trusted: trusted?.[i] ?? false,
    })),
    preloadedByAddr,
  );
}

export async function setTokenMetaEntriesIfMissing(
  context: TokenMetaContext,
  entries: readonly TokenMetaWrite[],
  preloadedByAddr?: Map<string, { decimals?: number } | undefined>,
): Promise<void> {
  const seen = new Map<string, TokenMetaWrite>();
  for (const entry of entries) {
    const addr = normalizeTokenAddress(entry.address);
    if (!seen.has(addr)) {
      seen.set(addr, {
        address: addr,
        decimals: safeDecimals(entry.decimals),
        trusted: entry.trusted ?? false,
      });
    }
  }

  const addrs = [...seen.keys()];
  const existing = preloadedByAddr
    ? addrs.map((a) => preloadedByAddr.get(a))
    : await Promise.all(addrs.map((addr) => context.TokenMeta.get(addr)));

  for (let i = 0; i < addrs.length; i++) {
    const entry = seen.get(addrs[i]!)!;
    const trusted = entry.trusted ?? false;
    if (!shouldPersistTokenMeta(existing[i], entry.decimals, trusted)) continue;
    context.TokenMeta.set({
      id: addrs[i]!,
      address: addrs[i]!,
      decimals: entry.decimals,
    });
  }
}
