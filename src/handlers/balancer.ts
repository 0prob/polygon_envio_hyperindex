import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { POLYGON_CHAIN_ID } from "../utils/constants";

// In-memory cache for same-block poolId→address bridging (entity writes are staged
// until block commit, so TokensRegistered in the same block as PoolRegistered needs
// a fast path). Falls back to BalancerPoolIdMapping entity for cross-block lookups
// and self-heals on reorg: if PoolMeta.get(poolAddr) returns undefined (entity
// rolled back), the entry is evicted and the handler returns early.
//
// Each entry stores the block number so we can detect stale cache entries after a
// reorg: if the cached block is higher than the current block, it came from a
// pre-reorg chain fork and must be evicted.
const poolIdToAddrCache = new Map<string, { poolAddress: string; blockNumber: number }>();

/** Addresses written without poolType — repaired on a slow onBlock stride (head RPC). */
const incompletePoolTypeAddrs = new Set<string>();
const REPAIR_EVERY = Number(process.env.BALANCER_POOLTYPE_REPAIR_EVERY ?? "2000");
const REPAIR_BATCH = Number(process.env.BALANCER_POOLTYPE_REPAIR_BATCH ?? "8");
const REPAIR_START = Number(process.env.BALANCER_POOLTYPE_REPAIR_START ?? "65000000");

function noteIncomplete(address: string, poolType: string | undefined | null) {
  if (poolType) incompletePoolTypeAddrs.delete(address.toLowerCase());
  else incompletePoolTypeAddrs.add(address.toLowerCase());
}

function isIncompletePoolMeta(existing: {
  poolType?: string | null;
  fee?: number | null;
  tokens?: string[] | null;
}): boolean {
  const missingType = existing.poolType == null || existing.poolType === "";
  const missingFee = existing.fee == null;
  const thinTokens = !existing.tokens || existing.tokens.length < 2;
  return missingType || missingFee || thinTokens;
}

indexer.onEvent(
  {
    contract: "BalancerVault",
    event: "PoolRegistered",
  },
  async ({ event, context }) => {
    const pool = event.params.poolAddress;
    const poolId = event.params.poolId;
    const blockNumber = Number(event.block.number);

    const existing = await context.PoolMeta.get(pool);
    // Re-enrich incomplete rows (historical RPC flakes left poolType/fee null).
    if (existing && !isIncompletePoolMeta(existing)) return;

    // All effects scheduled early → participate in Envio v3 preload batching + dedup.
    const meta = await context.effect(fetchBalancerMetadata, {
      pool,
      poolId,
      // Prefer head for repairs so archival holes don't stick; use event block for new rows.
      blockNumber: existing ? undefined : BigInt(blockNumber),
    });

    if (meta.tokens.length < 2) {
      if (meta.incompleteTransient) noteIncomplete(pool, undefined);
      return;
    }

    const tokenExisting = new Map<string, { decimals?: number } | undefined>();
    const tokenMetas = await resolveTokenMetasBatch(context, meta.tokens, tokenExisting);

    if (context.isPreload) {
      return;
    }

    // BigInt division truncates: swapFee in (1, 10^14) → 0 bps → stored as undefined.
    // Legitimate Balancer swap fees are always ≥ 0.0001 bps (swapFee ≥ 10^12), so
    // only broken RPC returns or trivial pools hit the truncation path.
    const fee = meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : 0;
    const poolType = meta.poolType;
    const createdBlock = existing?.createdBlock ?? blockNumber;

    poolIdToAddrCache.set(poolId, { poolAddress: pool, blockNumber });
    context.BalancerPoolIdMapping.set({
      id: poolId,
      poolAddress: pool,
      updatedAtBlock: blockNumber,
    });

    context.PoolMeta.set(
      poolMetaEntity({
        id: pool,
        address: pool,
        protocol: "BALANCER_V2",
        tokens: meta.tokens,
        fee: fee > 0 ? fee : existing?.fee,
        tickSpacing: undefined,
        createdBlock,
        updatedAtBlock: blockNumber,
        poolId: poolId,
        specialization: Number(event.params.specialization),
        poolType: poolType ?? existing?.poolType,
      }),
    );

    noteIncomplete(pool, poolType ?? existing?.poolType);

    await setTokenMetasIfMissing(
      context,
      meta.tokens,
      tokenMetas.map((m) => m.decimals),
      tokenMetas.map((m) => m.trusted),
      tokenExisting,
    );
  },
);

indexer.onEvent({ contract: "BalancerVault", event: "TokensRegistered" }, async ({ event, context }) => {
  const rawTokens = event.params.tokens;
  const blockNumber = Number(event.block.number);

  // Schedule token resolution early so effects register in the preload batch.
  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const tokenMetasPromise = resolveTokenMetasBatch(context, rawTokens, tokenExisting);

  const poolId = event.params.poolId;

  let poolAddr: string | undefined;
  const cached = poolIdToAddrCache.get(poolId);
  if (cached) {
    // Reorg guard: evict cache entries from higher blocks (pre-reorg fork).
    if (cached.blockNumber > blockNumber) {
      poolIdToAddrCache.delete(poolId);
    } else {
      poolAddr = cached.poolAddress;
    }
  }
  if (!poolAddr) {
    // Cross-block or after-reorg: read from entity (auto-rolled back by HyperIndex).
    const mapping = await context.BalancerPoolIdMapping.get(poolId);
    if (!mapping?.poolAddress) {
      await tokenMetasPromise;
      return;
    }
    poolAddr = mapping.poolAddress;
    poolIdToAddrCache.set(poolId, { poolAddress: poolAddr, blockNumber });
  }

  const [existing, tokenMetas] = await Promise.all([
    context.PoolMeta.get(poolAddr),
    tokenMetasPromise,
  ]);

  // Self-heal on reorg: if the pool was rolled back, evict stale cache and skip.
  if (!existing) {
    poolIdToAddrCache.delete(poolId);
    return;
  }

  // Re-probe type/fee when incomplete (historical nulls); otherwise keep existing.
  let fee = existing.fee;
  let poolType = existing.poolType;
  let tokens = rawTokens;
  let specialization = existing.specialization;

  if (isIncompletePoolMeta(existing)) {
    const meta = await context.effect(fetchBalancerMetadata, {
      pool: poolAddr,
      poolId,
      // head for repair
      blockNumber: undefined,
    });
    if (meta.tokens.length >= 2) tokens = meta.tokens;
    if (meta.poolType) poolType = meta.poolType;
    if (meta.swapFee > 0n) {
      const f = Number(meta.swapFee / 10n ** 14n);
      if (f > 0) fee = f;
    }
  }

  if (context.isPreload) return;

  const tokensUnchanged =
    existing.tokens &&
    existing.tokens.length === tokens.length &&
    tokens.every((t, i) => t === existing.tokens![i]);
  const typeOrFeeChanged = poolType !== existing.poolType || fee !== existing.fee;
  if (tokensUnchanged && !typeOrFeeChanged) return;

  context.PoolMeta.set(
    poolMetaEntity({
      id: poolAddr,
      address: poolAddr,
      protocol: "BALANCER_V2",
      tokens,
      fee,
      tickSpacing: undefined,
      createdBlock: existing.createdBlock,
      updatedAtBlock: blockNumber,
      poolId: poolId,
      specialization,
      poolType,
    }),
  );

  noteIncomplete(poolAddr, poolType);

  await setTokenMetasIfMissing(
    context,
    tokens,
    tokenMetas.map((m) => m.decimals),
    tokenMetas.map((m) => m.trusted),
    tokenExisting,
  );
});

/** Slow-path repair for incomplete poolType rows seen this process lifetime. */
indexer.onBlock(
  {
    name: "BalancerPoolTypeRepair",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: REPAIR_START, _every: REPAIR_EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    if (context.isPreload) return;
    if (incompletePoolTypeAddrs.size === 0) return;

    const batch: string[] = [];
    for (const addr of incompletePoolTypeAddrs) {
      batch.push(addr);
      if (batch.length >= REPAIR_BATCH) break;
    }

    const blockNumber = Number(block.number);
    for (const pool of batch) {
      const existing = await context.PoolMeta.get(pool);
      if (!existing) {
        incompletePoolTypeAddrs.delete(pool);
        continue;
      }
      if (!isIncompletePoolMeta(existing)) {
        incompletePoolTypeAddrs.delete(pool);
        continue;
      }

      const meta = await context.effect(fetchBalancerMetadata, {
        pool,
        poolId: existing.poolId ?? undefined,
        blockNumber: undefined,
      });

      if (meta.tokens.length < 2 && !meta.poolType && meta.swapFee === 0n) {
        // still broken — leave in set for a later stride
        if (!meta.incompleteTransient) incompletePoolTypeAddrs.delete(pool);
        continue;
      }

      const feeFromMeta =
        meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : 0;
      const fee = feeFromMeta > 0 ? feeFromMeta : existing.fee;
      const poolType = meta.poolType ?? existing.poolType;
      const tokens = meta.tokens.length >= 2 ? meta.tokens : existing.tokens;

      context.PoolMeta.set(
        poolMetaEntity({
          id: pool,
          address: pool,
          protocol: "BALANCER_V2",
          tokens,
          fee,
          tickSpacing: undefined,
          createdBlock: existing.createdBlock,
          updatedAtBlock: blockNumber,
          poolId: existing.poolId ?? (meta.poolId || undefined),
          specialization: existing.specialization,
          poolType,
        }),
      );

      if (poolType) incompletePoolTypeAddrs.delete(pool);
    }
  },
);
