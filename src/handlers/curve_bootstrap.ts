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
import { CURVE_REGISTRY_LEGACY, CURVE_REGISTRY_DEPLOY_BLOCK, ZERO_ADDRESS, POLYGON_CHAIN_ID, DEFAULT_CURVE_N_COINS, chainStart } from "../utils/constants";

const PAGE_SIZE = 40;

const CURVE_BOOTSTRAP_ID = "137-metaregistry";
const earliestCurveDeployBlock = CURVE_REGISTRY_DEPLOY_BLOCK;
const bootstrapStartBlock = Math.max(earliestCurveDeployBlock + 1, chainStart);

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

    // ponytail: fee=0 with valid coins is a transient RPC failure — retry next stride.
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

  // Phase 2: always write successful pools, even when other pools on the page
  // had transient failures. Previously the page-safety gate blocked all writes
  // when any pool failed, permanently stalling mixed-failure pages.
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
  }

  // ponytail: only advance when ALL new pools were handled (written or confirmed
  // non-Curve). Transient RPC failures → don't advance, retry next stride.
  // Previously-written pools hit the existingPools filter next stride, so only
  // the failed ones retry.
  if (hasTransient) return;

  const nextIndex = Math.min(page.total, offset + page.pools.length);
  storeProgress(nextIndex, page.total);
}

async function bootstrapCurvePools({ block, context }: any) {
  // ponytail: skip during preload — handler runs every 250 blocks on the
  // MetaRegistry (which covers all pool types). Preload would redundantly
  // page the registry + schedule effects for every qualifying block,
  // adding overhead for no writes.
  if (context.isPreload) return;

  await bootstrapRegistryPage(context, block, {
    id: CURVE_BOOTSTRAP_ID,
    address: CURVE_REGISTRY_LEGACY,
    deployBlock: earliestCurveDeployBlock,
  });
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
