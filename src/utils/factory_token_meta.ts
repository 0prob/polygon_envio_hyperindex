import type { Effect } from "envio";
import {
  fetchTokenMeta,
  lookupRegistryDecimalsBatch,
  preloadTokenDecimalsDefault,
} from "../effects/token_metadata";
import { normalizeTokenAddress } from "./normalize_address";
import { getMetadataConcurrency, runWithConcurrency } from "./pacing";

export type FactoryTokenMeta = { decimals: number; trusted: boolean };

type TokenMetaEntity = { decimals?: number };

type TokenMetaRow = TokenMetaEntity & { id: string };

type FactoryTokenMetaContext = {
  isPreload?: boolean;
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  TokenMeta: {
    get: (id: string) => Promise<TokenMetaEntity | undefined>;
    getWhere?: (filter: { id: { _in: string[] } }) => Promise<TokenMetaRow[]>;
  };
};

/**
 * Skip fetchTokenMeta when TokenMeta already has decimals persisted.
 * Untrusted preload defaults (18) are never written — any stored row is authoritative.
 */
function cachedTokenMeta(entity?: TokenMetaEntity): FactoryTokenMeta | null {
  if (entity?.decimals != null) {
    return { decimals: entity.decimals, trusted: true };
  }
  return null;
}

type ResolveSlot = { slot: number; addr: string; normalized: string };

async function resolveTokenMetaSlots(
  context: FactoryTokenMetaContext,
  slots: ResolveSlot[],
  preResolved?: Map<string, FactoryTokenMeta>,
): Promise<Map<number, FactoryTokenMeta>> {
  const resolved = new Map<number, FactoryTokenMeta>();
  if (slots.length === 0) return resolved;

  // ponytail: re-check registry only for slots not already resolved by the caller
  const unchecked = preResolved
    ? slots.filter((s) => !preResolved.has(s.normalized))
    : slots;
  const localHits = unchecked.length > 0
    ? await lookupRegistryDecimalsBatch(unchecked.map((s) => s.addr))
    : new Map<string, FactoryTokenMeta>();

  if (preResolved) {
    for (const slot of slots) {
      const hit = preResolved.get(slot.normalized);
      if (hit) resolved.set(slot.slot, hit);
    }
  }

  const needsEffect: ResolveSlot[] = [];
  for (const slot of unchecked) {
    const hit = localHits.get(slot.normalized);
    if (hit) {
      resolved.set(slot.slot, hit);
    } else {
      needsEffect.push(slot);
    }
  }

  if (needsEffect.length === 0) return resolved;

  if (context.isPreload) {
    for (const slot of needsEffect) {
      resolved.set(slot.slot, preloadTokenDecimalsDefault());
    }
    return resolved;
  }

  const concurrency = getMetadataConcurrency();
  const fetched = await runWithConcurrency(needsEffect, concurrency, (slot) =>
    context.effect(fetchTokenMeta, { address: slot.addr }),
  );
  for (let i = 0; i < needsEffect.length; i++) {
    resolved.set(needsEffect[i]!.slot, fetched[i]!);
  }
  return resolved;
}

/**
 * Resolve decimals for factory pool tokens with layered local-first batching:
 * 1. Hasura TokenMeta rows
 * 2. Static registry + discovered-decimals (single warmUpCache, 0 effects)
 * 3. fetchTokenMeta effects only for cold tokens in execution phase
 *
 * @param existingByAddr - Optional output map populated with pre-loaded TokenMeta entities,
 *   keyed by normalized address. Callers pass this to setTokenMetasIfMissing to skip
 *   redundant second loads.
 */
export async function resolveFactoryPairTokenMetas(
  context: FactoryTokenMetaContext,
  token0: string,
  token1: string,
  existingByAddr?: Map<string, { decimals?: number } | undefined>,
): Promise<[FactoryTokenMeta, FactoryTokenMeta]> {
  const n0 = normalizeTokenAddress(token0);
  const n1 = normalizeTokenAddress(token1);

  // Check static registry FIRST (in-memory, 0 I/O) — saves 2 DB reads for registry-known tokens
  const localHits = await lookupRegistryDecimalsBatch([token0, token1]);
  const t0InRegistry: FactoryTokenMeta | undefined = localHits.get(n0);
  const t1InRegistry: FactoryTokenMeta | undefined = localHits.get(n1);

  // Only read DB for tokens NOT in registry
  const [existingT0, existingT1] = await Promise.all([
    t0InRegistry ? undefined : context.TokenMeta.get(n0),
    t1InRegistry ? undefined : context.TokenMeta.get(n1),
  ]);

  if (existingByAddr) {
    existingByAddr.set(n0, existingT0);
    existingByAddr.set(n1, existingT1);
  }

  // Compose from registry first, then DB, then RPC fallback
  const t0Cached = t0InRegistry ?? cachedTokenMeta(existingT0);
  const t1Cached = t1InRegistry ?? cachedTokenMeta(existingT1);
  const pending: ResolveSlot[] = [];
  if (!t0Cached) {
    pending.push({ slot: 0, addr: token0, normalized: n0 });
  }
  if (!t1Cached) {
    pending.push({ slot: 1, addr: token1, normalized: n1 });
  }

  const fetched = await resolveTokenMetaSlots(context, pending, localHits as Map<string, FactoryTokenMeta>);
  return [
    t0Cached ?? fetched.get(0) ?? preloadTokenDecimalsDefault(),
    t1Cached ?? fetched.get(1) ?? preloadTokenDecimalsDefault(),
  ];
}

/**
 * Resolve decimals for N factory/bootstrap tokens (Curve, Balancer, WOOFi, etc.).
 * Same local-first batching as pair resolution — one registry warm-up per call.
 *
 * @param existingByAddr - Optional output map populated with pre-loaded TokenMeta entities,
 *   keyed by normalized address. Callers pass this to setTokenMetasIfMissing to skip
 *   redundant second loads.
 */
export async function resolveTokenMetasBatch(
  context: FactoryTokenMetaContext,
  tokens: readonly string[],
  existingByAddr?: Map<string, { decimals?: number } | undefined>,
): Promise<FactoryTokenMeta[]> {
  if (tokens.length === 0) return [];

  const normalized = tokens.map((t) => normalizeTokenAddress(t));

  // Check static registry FIRST (in-memory, 0 I/O)
  const localHits = await lookupRegistryDecimalsBatch(tokens);

  // Only read DB for tokens NOT in registry
  const idsNotInRegistry = normalized.filter((a) => !localHits.has(a));
  const rows = idsNotInRegistry.length > 0
    ? context.TokenMeta.getWhere
      ? await context.TokenMeta.getWhere({ id: { _in: idsNotInRegistry } })
      : (await Promise.all(idsNotInRegistry.map((a) => context.TokenMeta.get(a).then((r) => r && { id: a, ...r })))).filter(Boolean) as TokenMetaRow[]
    : [];
  const existingMap = new Map(rows.map((r) => [r.id, r]));
  const existing = normalized.map((addr) => existingMap.get(addr));

  if (existingByAddr) {
    for (let i = 0; i < tokens.length; i++) {
      if (!existingByAddr.has(normalized[i]!)) {
        existingByAddr.set(normalized[i]!, existing[i]);
      }
    }
  }

  const pending: ResolveSlot[] = [];
  const preset = new Map<number, FactoryTokenMeta>();
  for (let i = 0; i < tokens.length; i++) {
    const fromRegistry = localHits.get(normalized[i]!);
    if (fromRegistry) {
      preset.set(i, fromRegistry);
    } else {
      const cached = cachedTokenMeta(existing[i]);
      if (cached) {
        preset.set(i, cached);
      } else {
        pending.push({ slot: i, addr: tokens[i]!, normalized: normalized[i]! });
      }
    }
  }

  const fetched = await resolveTokenMetaSlots(context, pending);
  return tokens.map((_, i) => preset.get(i) ?? fetched.get(i) ?? preloadTokenDecimalsDefault());
}
