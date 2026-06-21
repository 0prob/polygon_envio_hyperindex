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

type FactoryTokenMetaContext = {
  isPreload?: boolean;
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  TokenMeta: {
    get: (id: string) => Promise<TokenMetaEntity | undefined>;
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
): Promise<Map<number, FactoryTokenMeta>> {
  const resolved = new Map<number, FactoryTokenMeta>();
  if (slots.length === 0) return resolved;

  const localHits = await lookupRegistryDecimalsBatch(slots.map((s) => s.addr));
  const needsEffect: ResolveSlot[] = [];
  for (const slot of slots) {
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
 */
export async function resolveFactoryPairTokenMetas(
  context: FactoryTokenMetaContext,
  token0: string,
  token1: string,
): Promise<[FactoryTokenMeta, FactoryTokenMeta]> {
  const [existingT0, existingT1] = await Promise.all([
    context.TokenMeta.get(normalizeTokenAddress(token0)),
    context.TokenMeta.get(normalizeTokenAddress(token1)),
  ]);

  const t0Cached = cachedTokenMeta(existingT0);
  const t1Cached = cachedTokenMeta(existingT1);
  const pending: ResolveSlot[] = [];
  if (!t0Cached) {
    pending.push({ slot: 0, addr: token0, normalized: normalizeTokenAddress(token0) });
  }
  if (!t1Cached) {
    pending.push({ slot: 1, addr: token1, normalized: normalizeTokenAddress(token1) });
  }

  const fetched = await resolveTokenMetaSlots(context, pending);
  return [
    t0Cached ?? fetched.get(0) ?? preloadTokenDecimalsDefault(),
    t1Cached ?? fetched.get(1) ?? preloadTokenDecimalsDefault(),
  ];
}

/**
 * Resolve decimals for N factory/bootstrap tokens (Curve, Balancer, WOOFi, etc.).
 * Same local-first batching as pair resolution — one registry warm-up per call.
 */
export async function resolveTokenMetasBatch(
  context: FactoryTokenMetaContext,
  tokens: readonly string[],
): Promise<FactoryTokenMeta[]> {
  if (tokens.length === 0) return [];

  const normalized = tokens.map((t) => normalizeTokenAddress(t));
  const existing = await Promise.all(normalized.map((addr) => context.TokenMeta.get(addr)));

  const pending: ResolveSlot[] = [];
  const preset = new Map<number, FactoryTokenMeta>();
  for (let i = 0; i < tokens.length; i++) {
    const cached = cachedTokenMeta(existing[i]);
    if (cached) {
      preset.set(i, cached);
    } else {
      pending.push({ slot: i, addr: tokens[i]!, normalized: normalized[i]! });
    }
  }

  const fetched = await resolveTokenMetaSlots(context, pending);
  return tokens.map((_, i) => preset.get(i) ?? fetched.get(i) ?? preloadTokenDecimalsDefault());
}
