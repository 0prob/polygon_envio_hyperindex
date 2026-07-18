import { indexer } from "envio";
import {
  curveFeeToPoolMetaInt,
  fetchCurveMetadata,
  isCurveMetadataEmpty,
} from "../effects/curve_metadata";
import type { CurveDiscoveryPoolType } from "../effects/curve_metadata";
import { fetchCurveFactoryPage } from "../effects/curve_registry_bootstrap";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch, type FactoryTokenMeta } from "../utils/factory_token_meta";
import { runWithConcurrency } from "../utils/pacing";
import {
  CURVE_FACTORIES,
  POLYGON_CHAIN_ID,
  ZERO_ADDRESS,
  DEFAULT_CURVE_N_COINS,
  chainStart,
  CURVE_FACTORY_DEPLOY_BLOCK,
} from "../utils/constants";

const PAGE_SIZE = 40;
const earliestCurveDeployBlock = CURVE_FACTORY_DEPLOY_BLOCK;
const bootstrapStartBlock = Math.max(earliestCurveDeployBlock + 1, chainStart);
const MAX_TRANSIENT_RETRIES = 3;
// ponytail: per-page retry counter so a transient RPC failure gets a second
// chance, but permanently broken pools don't stall the whole bootstrap forever.
const transientRetryCount = new Map<string, number>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootstrapFactoryPage(
  context: any,
  block: { number: bigint },
  factory: { address: string; id: string },
): Promise<void> {
  const stateId = `${context.chain.id}-${factory.id}`;
  const existingState = await context.CurveBootstrapProgress.get(stateId);
  const blockNum = Number(block.number);

  let offset = existingState?.lastIndex ?? 0;

  // Previously completed factories stay frozen unless pool_count grew.
  // Re-probe with epoch=block so Envio effect cache does not return the old total.
  if (existingState?.completed) {
    const probe = await context.effect(fetchCurveFactoryPage, {
      factory: factory.address,
      offset: existingState.total,
      limit: PAGE_SIZE,
      epoch: blockNum,
    });
    if (probe.total <= existingState.total) return;
    offset = existingState.total;
    if (!context.isPreload) {
      context.CurveBootstrapProgress.set({
        id: stateId,
        lastIndex: offset,
        total: probe.total,
        completed: false,
        updatedAtBlock: blockNum,
      });
    }
  }

  const page = await context.effect(fetchCurveFactoryPage, {
    factory: factory.address,
    offset,
    limit: PAGE_SIZE,
    // bust cache when resuming after a growth reopen (same offset may have been cached empty)
    epoch: existingState?.completed ? blockNum : undefined,
  });

  const storeProgress = (lastIndex: number, total: number) => {
    if (context.isPreload) return;
    context.CurveBootstrapProgress.set({
      id: stateId,
      lastIndex,
      total,
      completed: lastIndex >= total || total === 0,
      updatedAtBlock: blockNum,
    });
  };

  // Total is 0 → factory has no pools (or pool_count() reverted).
  if (page.total === 0) {
    storeProgress(0, 0);
    return;
  }

  // No pools on this page (all pool_list calls failed) → retry next stride.
  if (page.pools.length === 0) {
    return;
  }

  // Batch-check existing pools.
  const allAddrs = page.pools.map((r: { address: string }) => r.address.toLowerCase());
  const existingPools = (await context.PoolMeta.getWhere({ address: { _in: allAddrs } })) ?? [];
  const existingSet = new Set(existingPools.map((e: { address: string }) => e.address.toLowerCase()));
  const newPools = page.pools.filter((r: { address: string }) => !existingSet.has(r.address.toLowerCase()));

  if (newPools.length === 0) {
    const nextIndex = Math.min(page.total, offset + PAGE_SIZE);
    storeProgress(nextIndex, page.total);
    return;
  }

  // Phase 1: fetch pool metadata with bounded concurrency.
  const concurrency = 3;
  const readyPools: { address: string; coins: string[]; poolType: CurveDiscoveryPoolType; fee: bigint }[] = [];
  let hasTransient = false;

  await runWithConcurrency(newPools, concurrency, async (row: { address: string }) => {
    const meta = await context.effect(fetchCurveMetadata, {
      pool: row.address,
      nCoins: DEFAULT_CURVE_N_COINS,
      blockNumber: block.number,
    });

    const coins = meta.coins.filter((c: string) => c && c !== ZERO_ADDRESS);
    if (coins.length < 2) {
      if (!isCurveMetadataEmpty(meta)) {
        hasTransient = true;
      }
      return;
    }

    if (meta.fee === 0n) {
      hasTransient = true;
      return;
    }

    readyPools.push({
      address: row.address,
      coins,
      poolType: meta.poolType,
      fee: meta.fee,
    });
  });

  // Phase 2: write successful pools.
  if (readyPools.length > 0) {
    const uniqueCoins = [...new Set(readyPools.flatMap((p) => p.coins))];
    const tokenExisting = new Map<string, { decimals?: number } | undefined>();
    const tokenMetasPromise = resolveTokenMetasBatch(context, uniqueCoins, tokenExisting);

    if (context.isPreload) {
      await tokenMetasPromise;
      return;
    }

    const tokenMetas = await tokenMetasPromise;

    for (const pool of readyPools) {
      context.PoolMeta.set(
        poolMetaEntity({
          id: pool.address,
          address: pool.address,
          protocol: "CURVE",
          tokens: pool.coins,
          fee: curveFeeToPoolMetaInt(pool.fee),
          createdBlock: blockNum,
          updatedAtBlock: blockNum,
          poolId: undefined,
          poolType: pool.poolType,
        }),
      );
    }

    await setTokenMetasIfMissing(
      context,
      uniqueCoins,
      tokenMetas.map((m: FactoryTokenMeta) => m.decimals),
      tokenMetas.map((m: FactoryTokenMeta) => m.trusted),
      tokenExisting,
    );
  }

  // Track retries: after N consecutive transient failures on the same page,
  // skip past the broken pools instead of looping forever.
  if (hasTransient) {
    const retryKey = `${factory.id}-${offset}`;
    const fails = (transientRetryCount.get(retryKey) ?? 0) + 1;
    transientRetryCount.set(retryKey, fails);
    if (fails < MAX_TRANSIENT_RETRIES) return;
  }

  const nextIndex = Math.min(page.total, offset + page.pools.length);
  storeProgress(nextIndex, page.total);
  // ponytail: prune retry entries for pages we've advanced past
  for (const [key] of transientRetryCount) {
    if (key.startsWith(factory.id + "-")) transientRetryCount.delete(key);
  }
}

async function bootstrapCurvePools({ block, context }: any) {
  if (context.isPreload) return;

  // Iterate each factory independently. A broken factory doesn't stall others.
  for (const factory of CURVE_FACTORIES) {
    try {
      await bootstrapFactoryPage(context, block, factory);
    } catch {
      // ponytail: swallow per-factory errors so one broken factory doesn't
      // stall all others. The failing factory retries on the next stride.
    }
  }
}

indexer.onBlock(
  {
    name: "CurveMetaRegistryBootstrap",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: bootstrapStartBlock, _every: 250 } },
      };
    },
  },
  bootstrapCurvePools,
);
