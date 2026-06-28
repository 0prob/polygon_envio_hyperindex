import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";

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
    if (existing) return;

    // All effects scheduled early → participate in Envio v3 preload batching + dedup.
    // Token effects moved before isPreload guard (were after) for full preload optimization.
    const meta = await context.effect(fetchBalancerMetadata, { pool, poolId, blockNumber: BigInt(blockNumber) });

    if (meta.tokens.length < 2) {
      if (context.log) {
        context.log.warn("Balancer pool has < 2 tokens — skipping PoolMeta write", { pool, poolId });
      }
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
    const poolType = meta.amp != null && meta.amp > 0n ? "stable" : meta.weights?.length ? "weighted" : undefined;

    // Write to both entity (durable, auto-rolled back on reorg) and in-memory cache
    // (same-block bridging for TokensRegistered which only emits poolId).
    poolIdToAddrCache.set(poolId, { poolAddress: pool, blockNumber });
    context.BalancerPoolIdMapping.set({
      id: poolId,
      poolAddress: pool,
      updatedAtBlock: blockNumber,
    });

    context.PoolMeta.set(poolMetaEntity({
      id: pool,
      address: pool,
      protocol: "BALANCER_V2",
      tokens: meta.tokens,
      fee: fee > 0 ? fee : undefined,
      tickSpacing: undefined,
      createdBlock: blockNumber,
      updatedAtBlock: blockNumber,
      poolId: poolId,
      poolType,
    }));

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

  // Await effects + DB read concurrently so all effects are registered in the preload
  // batch before the isPreload guard. Previously tokenMetasPromise was only awaited
  // after the guard, which lost preload batching for later tokens when concurrency=1.
  const [existing, tokenMetas] = await Promise.all([
    context.PoolMeta.get(poolAddr),
    tokenMetasPromise,
  ]);

  // Self-heal on reorg: if the pool was rolled back, evict stale cache and skip.
  if (!existing) {
    poolIdToAddrCache.delete(poolId);
    return;
  }

  const fee = existing?.fee;
  const poolType = existing?.poolType;

  if (context.isPreload) return;

  const tokensUnchanged =
    existing?.tokens &&
    existing.tokens.length === rawTokens.length &&
    rawTokens.every((t, i) => t === existing.tokens![i]);
  if (tokensUnchanged) return;

  context.PoolMeta.set(poolMetaEntity({
    id: poolAddr,
    address: poolAddr,
    protocol: "BALANCER_V2",
    tokens: rawTokens,
    fee,
    tickSpacing: undefined,
    createdBlock: existing.createdBlock,
    updatedAtBlock: blockNumber,
    poolId: poolId,
    poolType,
  }));

  await setTokenMetasIfMissing(
    context,
    rawTokens,
    tokenMetas.map((m) => m.decimals),
    tokenMetas.map((m) => m.trusted),
    tokenExisting,
  );
});


