import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";

const balancerMetaCache = new Map<string, { tokens: string[]; fee: number }>();
const balancerIdToAddrCache = new Map<string, string>();

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

    const tokenMetas = await resolveTokenMetasBatch(context, meta.tokens);

    if (context.isPreload) {
      return;
    }

    const fee = meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : 0;
    const tokens = [...meta.tokens]; // ensure mutable string[] for cache + PoolMeta type
    const poolType = meta.amp != null && meta.amp > 0n ? "stable" : meta.weights?.length ? "weighted" : undefined;

    balancerMetaCache.set(pool, { tokens, fee });
    balancerIdToAddrCache.set(poolId, pool);

    context.PoolMeta.set(poolMetaEntity({
      id: pool,
      address: pool,
      protocol: "BALANCER_V2",
      tokens,
      fee: fee > 0 ? fee : undefined,
      tickSpacing: undefined,
      createdBlock: blockNumber,
      poolId: poolId,
      poolType,
    }));

    await setTokenMetasIfMissing(
      context,
      tokens,
      tokenMetas.map((m) => m.decimals),
      tokenMetas.map((m) => m.trusted),
    );
  },
);

indexer.onEvent({ contract: "BalancerVault", event: "TokensRegistered" }, async ({ event, context }) => {
  const rawTokens = event.params.tokens;
  const tokens = [...rawTokens];
  const blockNumber = Number(event.block.number);

  // Schedule token resolution early so effects register in the preload batch.
  const tokenMetasPromise = resolveTokenMetasBatch(context, tokens);

  const poolId = event.params.poolId;

  let poolAddr = balancerIdToAddrCache.get(poolId);
  if (!poolAddr) {
    // Cache miss: on start/reorg PoolRegistered repopulates the cache.
    // Without BootPoolIdToAddress entity, we skip the incremental update.
    await tokenMetasPromise;
    return;
  }

  // Await effects + DB read concurrently so all effects are registered in the preload
  // batch before the isPreload guard. Previously tokenMetasPromise was only awaited
  // after the guard, which lost preload batching for later tokens when concurrency=1.
  const [existing, tokenMetas] = await Promise.all([
    context.PoolMeta.get(poolAddr),
    tokenMetasPromise,
  ]);
  const fee = existing?.fee ?? 0;
  const poolType = existing?.poolType;

  if (context.isPreload) return;

  const tokensUnchanged =
    existing?.tokens &&
    existing.tokens.length === tokens.length &&
    tokens.every((t, i) => t === existing.tokens![i]);
  if (tokensUnchanged) return;

  balancerMetaCache.set(poolAddr, { tokens, fee });

  context.PoolMeta.set(poolMetaEntity({
    id: poolAddr,
    address: poolAddr,
    protocol: "BALANCER_V2",
    tokens: tokens,
    fee,
    tickSpacing: undefined,
    createdBlock: blockNumber,
    poolId: poolId,
    poolType,
  }));

  await setTokenMetasIfMissing(
    context,
    tokens,
    tokenMetas.map((m) => m.decimals),
    tokenMetas.map((m) => m.trusted),
  );
});

// NOTE: BalancerVault.Swap / PoolBalanceChanged were removed — they were no-ops (hot Balancer
// state comes from the arb bot RPC). BalancerVault is a single high-traffic contract, so indexing
// its Swap events was a large fetch-budget drain. Only PoolRegistered/TokensRegistered (discovery)
// remain.
