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
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { runWithConcurrency, getMetadataConcurrency } from "../utils/pacing";
import { CURVE_REGISTRY_SOURCES, curveDiscoveryProtocol } from "../utils/curve_registry";

const POLYGON_CHAIN_ID = 137;
const PAGE_SIZE = 40;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_N_COINS = 4;

const chainStart = (() => {
  const v = process.env.POLYGON_START_BLOCK || process.env.ENVIO_POLYGON_START_BLOCK;
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const earliestCurveDeployBlock = Math.min(...CURVE_REGISTRY_SOURCES.map((s) => s.deployBlock));
const bootstrapStartBlock = Math.max(earliestCurveDeployBlock + 1, chainStart);

interface TokenMetaResult {
  decimals: number;
  trusted: boolean;
}

interface CurveBootstrapPool {
  address: string;
  coins: string[];
  poolType: CurveDiscoveryPoolType;
  fee: bigint;
}

/** Advance registry pagination only when the page produced indexable pools or was fully deduped. */
export function shouldAdvanceBootstrapPage(newPoolCount: number, readyPoolCount: number): boolean {
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
  const concurrency = Math.min(3, getMetadataConcurrency());
  const readyPools: CurveBootstrapPool[] = [];

  await runWithConcurrency(newPools, concurrency, async (row: { address: string }) => {
    const meta = await context.effect(fetchCurveMetadata, {
      pool: row.address,
      nCoins: DEFAULT_N_COINS,
      blockNumber: block.number,
    });

    const coins = meta.coins.filter((c: string) => c && c !== ZERO);
    if (coins.length < 2) {
      if (isCurveMetadataEmpty(meta) && context.log) {
        context.log.warn("Curve bootstrap metadata unavailable — skipping pool", { pool: row.address });
      }
      return;
    }

    readyPools.push({
      address: row.address,
      coins,
      poolType: meta.poolType as CurveDiscoveryPoolType,
      fee: meta.fee,
    });
  });

  if (readyPools.length === 0) {
    // Transient RPC failures — do not advance; retry this page on the next stride.
    return;
  }

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
      protocol: curveDiscoveryProtocol(pool.poolType),
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
    tokenMetas.map((m: TokenMetaResult) => m.decimals),
    tokenMetas.map((m: TokenMetaResult) => m.trusted),
    tokenExisting,
  );

  const nextIndex = Math.min(page.total, offset + PAGE_SIZE);
  storeProgress(nextIndex, page.total);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootstrapCurvePools({ block, context }: any) {
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
