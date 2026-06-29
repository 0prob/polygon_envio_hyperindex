import { indexer } from "envio";
import {
  curveFeeToPoolMetaInt,
  fetchCurveMetadata,
  isCurveMetadataEmpty,
} from "../effects/curve_metadata";
import type { CurveDiscoveryPoolType } from "../effects/curve_metadata";
import { fetchCurveRegistryPage } from "../effects/curve_registry_bootstrap";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch, type FactoryTokenMeta } from "../utils/factory_token_meta";
import { runWithConcurrency } from "../utils/pacing";
import { CURVE_REGISTRY_SOURCES, ZERO_ADDRESS, POLYGON_CHAIN_ID, DEFAULT_CURVE_N_COINS, chainStart } from "../utils/constants";

const PAGE_SIZE = 40;
const ZERO = ZERO_ADDRESS;
const DEFAULT_N_COINS = DEFAULT_CURVE_N_COINS;

const earliestCurveDeployBlock = Math.min(...CURVE_REGISTRY_SOURCES.map((s) => s.deployBlock));
const bootstrapStartBlock = Math.max(earliestCurveDeployBlock + 1, chainStart);

function shouldAdvanceBootstrapPage(newPoolCount: number, readyPoolCount: number): boolean {
  if (newPoolCount === 0) return true;
  return readyPoolCount > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootstrapRegistryPage(
  context: any,
  block: { number: bigint },
  source: { id: string; address: string; deployBlock: number },
): Promise<void> {
  if (Number(block.number) <= source.deployBlock) return;

  const stateId = `${context.chain.id}-${source.id}`;
  const existingState = await context.CurveBootstrapProgress.get(stateId);
  if (existingState?.completed) return;

  const offset = existingState?.lastIndex ?? 0;
  const page = await context.effect(fetchCurveRegistryPage, {
    offset,
    limit: PAGE_SIZE,
    registryAddress: source.address,
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

  if (page.total === 0 || page.pools.length === 0) {
    if (page.total === 0) return;
    storeProgress(offset, page.total);
    return;
  }

  // BATCH-CHECK which pools already exist (single getWhere instead of N sequential gets)
  const allAddrs = page.pools.map((r: { address: string }) => r.address.toLowerCase());
  const existingPools = (await context.PoolMeta.getWhere({ address: { _in: allAddrs } })) ?? [];
  const existingSet = new Set(existingPools.map((e: { address: string }) => e.address.toLowerCase()));
  const newPools = page.pools.filter((r: { address: string }) => !existingSet.has(r.address.toLowerCase()));

  if (newPools.length === 0) {
    const nextIndex = Math.min(page.total, offset + PAGE_SIZE);
    storeProgress(nextIndex, page.total);
    return;
  }

  // Phase 1: fetch pool metadata with bounded concurrency (RPC effects only).
  const concurrency = 3;
  const readyPools: { address: string; coins: string[]; poolType: CurveDiscoveryPoolType; fee: bigint }[] = [];
  let allNonCurve = true;

  await runWithConcurrency(newPools, concurrency, async (row: { address: string }) => {
    const meta = await context.effect(fetchCurveMetadata, {
      pool: row.address,
      nCoins: DEFAULT_N_COINS,
      blockNumber: block.number,
    });

    const coins = meta.coins.filter((c: string) => c && c !== ZERO);
    if (coins.length < 2) {
      if (!isCurveMetadataEmpty(meta)) {
        // Some reads succeeded — not a non-Curve contract, just an RPC / coin count issue.
        allNonCurve = false;
      }
      return;
    }

    // Partial RPC failure: coins resolved but fee read failed. Don't write
    // PoolMeta with fee=0. Mark as non-complete so page retries on next stride.
    if (meta.fee === 0n) {
      allNonCurve = false;
      return;
    }

    allNonCurve = false;
    readyPools.push({
      address: row.address,
      coins,
      poolType: meta.poolType,
      fee: meta.fee,
    });
  });

  if (readyPools.length === 0) {
    if (allNonCurve && newPools.length > 0) {
      // Every new pool on this page had all reads revert — they are non-Curve/garbage.
      // Advance past them so we don't retry forever.
      const nextIndex = Math.min(page.total, offset + page.pools.length);
      storeProgress(nextIndex, page.total);
    }
    // Otherwise: transient RPC failures — do not advance; retry this page on the next stride.
    return;
  }

  // ponytail: only advance when ALL new pools on this page were successfully
  // processed. If any pool failed metadata fetch, don't advance — retry the
  // whole page next stride. This prevents permanently losing pools that had
  // transient RPC failures mid-page while sibling pools succeeded.
  if (readyPools.length < newPools.length) return;

  // Phase 2: one batched token-meta pass for all coins on the page (not N× per pool).
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
    context.PoolMeta.set(poolMetaEntity({
      id: pool.address,
      address: pool.address,
      protocol: "CURVE",
      tokens: pool.coins,
      fee: curveFeeToPoolMetaInt(pool.fee),
      createdBlock: blockNumber,
      updatedAtBlock: blockNumber,
      poolId: undefined,
      poolType: pool.poolType,
    }));
  }

  await setTokenMetasIfMissing(
    context,
    uniqueCoins,
    tokenMetas.map((m: FactoryTokenMeta) => m.decimals),
    tokenMetas.map((m: FactoryTokenMeta) => m.trusted),
    tokenExisting,
  );

  const nextIndex = Math.min(page.total, offset + page.pools.length);
  storeProgress(nextIndex, page.total);
}

async function bootstrapCurvePools({ block, context }: any) {
  // ponytail: skip during preload — handler runs every 250 blocks. Preload
  // would redundantly page the registry + schedule effects for every
  // qualifying block, adding overhead for no writes.
  if (context.isPreload) return;

  for (const source of CURVE_REGISTRY_SOURCES) {
    await bootstrapRegistryPage(context, block, source);
  }
}

indexer.onBlock(
  {
    name: "CurveRegistryBootstrap",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: bootstrapStartBlock, _every: 250 } },
      };
    },
  },
  bootstrapCurvePools,
);
