import { indexer } from "envio";
import type { Effect } from "envio";
import {
  curveFeeToPoolMetaInt,
  fetchCurveMetadata,
  isCurveMetadataEmpty,
  curvePoolMetaNeedsEnrich,
} from "../effects/curve_metadata";
import type { CurveDiscoveryPoolType } from "../effects/curve_metadata";
import { fetchCurveFactoryPage } from "../effects/curve_registry_bootstrap";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch, type FactoryTokenMeta } from "../utils/factory_token_meta";
import type { PoolMetaWritePayload } from "../utils/indexer_protocol";
import {
  CURVE_FACTORIES,
  POLYGON_CHAIN_ID,
  ZERO_ADDRESS,
  DEFAULT_CURVE_N_COINS,
  CURVE_FACTORY_DEPLOY_BLOCK,
} from "../utils/constants";

type BootstrapContext = {
  isPreload: boolean;
  chain: { id: number };
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  CurveBootstrapProgress: {
    get: (id: string) => Promise<{ lastIndex?: number; total?: number; completed?: boolean } | undefined>;
    set: (entity: {
      id: string;
      lastIndex: number;
      total: number;
      completed: boolean;
      updatedAtBlock: number;
    }) => void;
  };
  PoolMeta: {
    get: (id: string) => Promise<{
      id?: string;
      fee?: number | null;
      tokens?: readonly string[] | null;
      createdBlock?: number;
      poolType?: string | null;
    } | undefined>;
    getWhere: (filter: Record<string, unknown>) => Promise<Array<{
      id: string;
      address: string;
      fee?: number | null;
      tokens?: readonly string[] | null;
      poolType?: string | null;
      createdBlock?: number;
    }>>;
    set: (entity: PoolMetaWritePayload) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    getWhere: (filter: { id: { _in: string[] } }) => Promise<{ id: string; decimals?: number }[]>;
    set: (entity: { id: string; decimals: number }) => void;
  };
};

/**
 * Pools whose coins interface is permanently absent (not a rate-limit empty).
 * Safe to skip — there is no discoverable Curve pool here.
 */
const permanentDeadPools = new Set<string>();
/**
 * fee()/mid_fee permanently absent or successfully read as 0 — not a transient RPC miss.
 * Tokens stay indexed; fee left unset for the bot to live-RPC if needed.
 */
const curveFeeUnreadable = new Set<string>();
/** Fee still unknown after tokens written — repaired on later strides without holding page cursor. */
const incompleteCurveFee = new Set<string>();

function isPermanentRpcClass(failureReason: string | undefined): boolean {
  return !!failureReason && (
    failureReason.includes("ZERO_DATA") ||
    failureReason.includes("REVERTED") ||
    failureReason.includes("MALFORMED_INPUT")
  );
}

const PAGE_SIZE = 40;
const earliestCurveDeployBlock = CURVE_FACTORY_DEPLOY_BLOCK;
/**
 * Factory pagination is Effect/RPC-heavy. Running it mid-backfill stalls the
 * indexer when archival RPC is slow/rate-limited (progress_block freezes;
 * fetchCurveMetadata queue grows without bound).
 *
 * Default: defer until ~90M. A large buffered batch that crosses this gate used
 * to fire every 250 blocks × all factories × 40 pool metadata effects and wedge
 * the pipeline — stride is coarse and only one factory is serviced per fire.
 * Override with CURVE_BOOTSTRAP_FROM_BLOCK.
 */
const bootstrapStartBlock = (() => {
  const fromEnv = Number(process.env.CURVE_BOOTSTRAP_FROM_BLOCK);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return Math.max(earliestCurveDeployBlock + 1, 90_000_000);
})();
/** onBlock stride while paginating incomplete factories (see indexer.onBlock below). */
const BOOTSTRAP_EVERY = Math.max(
  10,
  Number(process.env.CURVE_BOOTSTRAP_EVERY ?? "100"),
);
/**
 * After a factory is marked completed, only re-check pool_count this often.
 * Factory onEvent handlers catch most new pools; growth re-probes cover metapools
 * and missed deployments.
 */
const GROWTH_PROBE_EVERY = Math.max(
  BOOTSTRAP_EVERY,
  Number(process.env.CURVE_BOOTSTRAP_GROWTH_EVERY ?? "100000"),
);
/** Cap Curve metadata RPCs scheduled per onBlock fire (preload-safe). */
const MAX_POOLS_PER_FIRE = Math.max(
  1,
  Number(process.env.CURVE_BOOTSTRAP_POOLS_PER_FIRE ?? "8"),
);

async function bootstrapFactoryPage(
  context: BootstrapContext,
  block: { number: number | bigint },
  factory: { address: string; id: string },
): Promise<void> {
  const stateId = `${context.chain.id}-${factory.id}`;
  const existingState = await context.CurveBootstrapProgress.get(stateId);
  const blockNum = Number(block.number);

  let offset = existingState?.lastIndex ?? 0;

  // Previously completed factories stay frozen unless pool_count grew.
  // Coarse epoch so Envio effect cache reuses the probe within a growth window
  // (unique per-block epochs were the stall).
  // Migration 008 resets stuck completed rows after the historical pool_count fix;
  // growth reopen still covers genuine post-completion deployments.
  if (existingState?.completed) {
    // Handler fires every BOOTSTRAP_EVERY; only probe on the first fire in each
    // GROWTH_PROBE_EVERY window (blockNum % GROWTH_PROBE_EVERY < BOOTSTRAP_EVERY).
    if (blockNum % GROWTH_PROBE_EVERY >= BOOTSTRAP_EVERY) return;

    const growthEpoch = Math.floor(blockNum / GROWTH_PROBE_EVERY);
    const probe = await context.effect(fetchCurveFactoryPage, {
      factory: factory.address,
      offset: existingState.total ?? 0,
      limit: PAGE_SIZE,
      epoch: growthEpoch,
      blockNumber: BigInt(block.number),
    });
    if (!probe.ok) return;
    if (probe.total <= (existingState.total ?? 0)) return;
    offset = existingState.total ?? 0;
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
    // coarse cache key when resuming after a growth reopen
    epoch: existingState?.completed ? Math.floor(blockNum / GROWTH_PROBE_EVERY) : undefined,
    blockNumber: BigInt(block.number),
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

  // RPC miss — retry next stride (never mark factory completed).
  if (!page.ok) return;

  // Genuine empty factory (successful pool_count === 0).
  if (page.total === 0) {
    storeProgress(0, 0);
    return;
  }

  // No pools on this page (all pool_list calls failed) → retry next stride.
  if (page.pools.length === 0) {
    return;
  }

  // Batch-check existing pools. Re-enrich rows left incomplete by older fee()/N_COINS bugs.
  const allAddrs = page.pools.map((r: { address: string }) => r.address.toLowerCase());
  const existingPools = (await context.PoolMeta.getWhere({ address: { _in: allAddrs } })) ?? [];
  const existingByAddr = new Map<
    string,
    { address: string; fee?: number | null; tokens?: readonly string[] | null; createdBlock?: number }
  >(
    existingPools.map((e: {
      address: string;
      fee?: number | null;
      tokens?: readonly string[] | null;
      createdBlock?: number;
    }) => [e.address.toLowerCase(), e]),
  );
  const pendingTokens = page.pools.filter((r: { address: string }) => {
    const addr = r.address.toLowerCase();
    if (permanentDeadPools.has(addr)) return false;
    const e = existingByAddr.get(addr);
    return !e?.tokens || e.tokens.length < 2;
  });
  // Prefer pools missing tokens; fee-enrich only when the page is token-complete.
  // Transient fee misses stay pending; permanent fee()/mid_fee absence is skipped
  // (non-existent on-chain via those methods — bot can live-RPC).
  const pendingFee = pendingTokens.length === 0
    ? page.pools.filter((r: { address: string }) => {
        const addr = r.address.toLowerCase();
        if (permanentDeadPools.has(addr) || curveFeeUnreadable.has(addr)) return false;
        return curvePoolMetaNeedsEnrich(existingByAddr.get(addr));
      })
    : [];
  const pendingEnrich = pendingTokens.length > 0 ? pendingTokens : pendingFee;
  const newPools = pendingEnrich.slice(0, MAX_POOLS_PER_FIRE);

  if (pendingTokens.length === 0 && pendingFee.length === 0) {
    const nextIndex = Math.min(page.total, offset + PAGE_SIZE);
    storeProgress(nextIndex, page.total);
    return;
  }

  // Phase 1: fetch pool metadata — fire all capped effects concurrently for preload batching.
  const readyPools: {
    address: string;
    coins: string[];
    poolType: CurveDiscoveryPoolType;
    fee: bigint | undefined;
  }[] = [];
  let tokenTransient = false;

  const metas = await Promise.all(
    newPools.map((row: { address: string }) =>
      context.effect(fetchCurveMetadata, {
        pool: row.address,
        nCoins: DEFAULT_CURVE_N_COINS,
        blockNumber: BigInt(block.number),
      }),
    ),
  );

  for (let i = 0; i < newPools.length; i++) {
    const row = newPools[i]!;
    const meta = metas[i]!;
    const addr = row.address.toLowerCase();
    const coins = meta.coins.filter((c: string) => c && c !== ZERO_ADDRESS);
    if (coins.length < 2) {
      if (isCurveMetadataEmpty(meta) && isPermanentRpcClass(meta.failureReason)) {
        permanentDeadPools.add(addr);
      } else {
        tokenTransient = true;
      }
      continue;
    }

    if (meta.fee <= 0n) {
      if (isPermanentRpcClass(meta.failureReason)) {
        curveFeeUnreadable.add(addr);
        incompleteCurveFee.delete(addr);
      } else if (meta.failureReason) {
        incompleteCurveFee.add(addr);
      }
    } else {
      incompleteCurveFee.delete(addr);
    }

    readyPools.push({
      address: row.address,
      coins,
      poolType: meta.poolType as CurveDiscoveryPoolType,
      fee: meta.fee > 0n ? meta.fee : meta.failureReason ? undefined : 0n,
    });
  }
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
      const prior = existingByAddr.get(pool.address.toLowerCase());
      const feeVal = pool.fee != null ? curveFeeToPoolMetaInt(pool.fee) : prior?.fee ?? undefined;
      context.PoolMeta.set(
        poolMetaEntity({
          id: pool.address,
          address: pool.address,
          protocol: "CURVE",
          tokens: pool.coins,
          fee: feeVal,
          tickSpacing: undefined,
          createdBlock: prior?.createdBlock ?? blockNum,
          updatedAtBlock: blockNum,
          poolId: undefined,
          poolType: pool.poolType,
        }) as PoolMetaWritePayload,
      );
      const addr = pool.address.toLowerCase();
      if (feeVal == null && !curveFeeUnreadable.has(addr)) incompleteCurveFee.add(addr);
      else if (feeVal != null) incompleteCurveFee.delete(addr);
    }

    await setTokenMetasIfMissing(
      context,
      uniqueCoins,
      tokenMetas.map((m: FactoryTokenMeta) => m.decimals),
      tokenMetas.map((m: FactoryTokenMeta) => m.trusted),
      tokenExisting,
    );
  }

  // Hold factory cursor only for token-discovery gaps. Fee repair uses
  // incompleteCurveFee without blocking later pool discovery.
  if (tokenTransient) return;
  if (pendingTokens.length > MAX_POOLS_PER_FIRE) return;

  // Before leaving this page, enqueue any remaining fee gaps for off-cursor repair.
  if (pendingTokens.length === 0) {
    for (const r of page.pools) {
      const addr = r.address.toLowerCase();
      if (permanentDeadPools.has(addr) || curveFeeUnreadable.has(addr)) continue;
      const prior = existingByAddr.get(addr);
      const written = readyPools.find((p) => p.address.toLowerCase() === addr);
      const feeKnown =
        (written && written.fee != null) ||
        (prior != null && prior.fee != null);
      const tokensKnown =
        (written && written.coins.length >= 2) ||
        (prior?.tokens != null && prior.tokens.length >= 2);
      if (tokensKnown && !feeKnown) incompleteCurveFee.add(addr);
    }
  }

  const nextIndex = Math.min(page.total, offset + page.pools.length);
  storeProgress(nextIndex, page.total);
}

async function repairIncompleteCurveFees(
  context: BootstrapContext,
  block: { number: number | bigint },
  budget: number,
): Promise<void> {
  if (incompleteCurveFee.size === 0 || budget <= 0) return;
  const blockNum = Number(block.number);
  const batch: string[] = [];
  for (const addr of incompleteCurveFee) {
    if (curveFeeUnreadable.has(addr) || permanentDeadPools.has(addr)) {
      incompleteCurveFee.delete(addr);
      continue;
    }
    batch.push(addr);
    if (batch.length >= budget) break;
  }
  if (batch.length === 0) return;

  // Preload-friendly: fire all metadata effects concurrently, then write.
  const metas = await Promise.all(
    batch.map((addr) =>
      context.effect(fetchCurveMetadata, {
        pool: addr,
        nCoins: DEFAULT_CURVE_N_COINS,
        blockNumber: BigInt(block.number),
      }),
    ),
  );
  const priors = await Promise.all(batch.map((addr) => context.PoolMeta.get(addr)));

  if (context.isPreload) return;

  for (let i = 0; i < batch.length; i++) {
    const addr = batch[i]!;
    const meta = metas[i]!;
    const prior = priors[i];
    const coins = meta.coins.filter((c: string) => c && c !== ZERO_ADDRESS);
    if (coins.length < 2) {
      if (isCurveMetadataEmpty(meta) && isPermanentRpcClass(meta.failureReason)) {
        permanentDeadPools.add(addr);
        incompleteCurveFee.delete(addr);
      }
      continue;
    }
    if (meta.fee <= 0n) {
      if (isPermanentRpcClass(meta.failureReason)) {
        curveFeeUnreadable.add(addr);
        incompleteCurveFee.delete(addr);
      }
      if (meta.failureReason) continue;
    } else {
      incompleteCurveFee.delete(addr);
    }

    const feeVal =
      meta.fee > 0n
        ? curveFeeToPoolMetaInt(meta.fee)
        : meta.failureReason
          ? prior?.fee ?? undefined
          : 0;
    context.PoolMeta.set(
      poolMetaEntity({
        id: addr,
        address: addr,
        protocol: "CURVE",
        tokens: coins,
        fee: feeVal,
        tickSpacing: undefined,
        createdBlock: prior?.createdBlock ?? blockNum,
        updatedAtBlock: blockNum,
        poolId: undefined,
        poolType: meta.poolType,
      }) as PoolMetaWritePayload,
    );
    if (feeVal != null) incompleteCurveFee.delete(addr);
  }
}

async function bootstrapCurvePools({
  block,
  context,
}: {
  block: { number: number | bigint };
  context: BootstrapContext;
}) {
  // Run in preload too so fetchCurveFactoryPage / fetchCurveMetadata effects
  // are registered and cached; entity writes already guard on isPreload.
  // One factory per stride (round-robin) — firing all four every 250 blocks
  // inside a multi-100k buffered batch queued 10k+ Curve metadata effects and
  // froze progress_block.
  const blockNum = Number(block.number);
  const factory =
    CURVE_FACTORIES[Math.floor(blockNum / BOOTSTRAP_EVERY) % CURVE_FACTORIES.length]!;
  try {
    // Bounded fee repair for pools whose page cursor already advanced.
    await repairIncompleteCurveFees(context, block, Math.min(4, MAX_POOLS_PER_FIRE));
    await bootstrapFactoryPage(context, block, factory);
  } catch {
    // ponytail: swallow so a broken factory doesn't stall the stride; retries later.
  }
}

indexer.onBlock(
  {
    name: "CurveMetaRegistryBootstrap",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: bootstrapStartBlock, _every: BOOTSTRAP_EVERY } },
      };
    },
  },
  bootstrapCurvePools,
);
