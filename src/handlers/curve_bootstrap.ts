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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootstrapFactoryPage(
  context: any,
  block: { number: bigint },
  factory: { address: string; id: string },
): Promise<void> {
  const stateId = `${context.chain.id}-${factory.id}`;
  const existingState = await context.CurveBootstrapProgress.get(stateId);
  if (existingState?.completed) return;

  const offset = existingState?.lastIndex ?? 0;
  const page = await context.effect(fetchCurveFactoryPage, {
    factory: factory.address,
    offset,
    limit: PAGE_SIZE,
  });

  const storeProgress = (lastIndex: number, total: number) => {
    if (context.isPreload) return;
    context.CurveBootstrapProgress.set({
      id: stateId,
      lastIndex,
      total,
      completed: lastIndex >= total || total === 0,
      updatedAtBlock: Number(block.number),
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
    const blockNumber = Number(block.number);

    for (const pool of readyPools) {
      context.PoolMeta.set(
        poolMetaEntity({
          id: pool.address,
          address: pool.address,
          protocol: "CURVE",
          tokens: pool.coins,
          fee: curveFeeToPoolMetaInt(pool.fee),
          createdBlock: blockNumber,
          updatedAtBlock: blockNumber,
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

  // Skip advancing on transient failures — retry next stride.
  if (hasTransient) return;

  const nextIndex = Math.min(page.total, offset + page.pools.length);
  storeProgress(nextIndex, page.total);
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
