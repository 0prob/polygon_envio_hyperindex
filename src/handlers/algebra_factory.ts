import { indexer } from "envio";
import type { Effect } from "envio";
import { fetchAlgebraPoolMeta } from "../effects/algebra_pool_metadata";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { ALGEBRA_FACTORY_PROTOCOLS, POLYGON_CHAIN_ID } from "../utils/constants";
import type { IndexerProtocol as Protocol, PoolMetaWritePayload } from "../utils/indexer_protocol";

function lookupAlgebraFactoryProtocol(factoryAddr: string): Protocol | undefined {
  return ALGEBRA_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()] as Protocol | undefined;
}

type AlgebraCtx = {
  isPreload: boolean;
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  PoolMeta: {
    get: (id: string) => Promise<{
      id?: string;
      address?: string;
      protocol?: string;
      tokens?: readonly string[];
      fee?: number | null;
      tickSpacing?: number | null;
      createdBlock?: number;
      poolId?: string | null;
    } | undefined>;
    set: (entity: PoolMetaWritePayload) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    getWhere: (filter: { id: { _in: string[] } }) => Promise<{ id: string; decimals?: number }[]>;
    set: (entity: { id: string; decimals: number }) => void;
  };
};

/** Incomplete fee/tickSpacing — repaired on a slow onBlock stride (head RPC). */
const incompleteAlgebra = new Map<
  string,
  { token0: string; token1: string; protocol: Protocol; createdBlock: number }
>();
const REPAIR_EVERY = Number(process.env.ALGEBRA_META_REPAIR_EVERY ?? "5000");
const REPAIR_BATCH = Number(process.env.ALGEBRA_META_REPAIR_BATCH ?? "8");
const REPAIR_START = Number(process.env.ALGEBRA_META_REPAIR_START ?? "65000000");

export function noteAlgebraIncomplete(
  pool: string,
  row: { token0: string; token1: string; protocol: Protocol; createdBlock: number },
) {
  incompleteAlgebra.set(pool.toLowerCase(), row);
}

export function clearAlgebraIncomplete(pool: string) {
  incompleteAlgebra.delete(pool.toLowerCase());
}

async function writeAlgebraPool(
  context: AlgebraCtx,
  opts: {
    poolAddr: string;
    protocol: Protocol;
    token0: string;
    token1: string;
    blockNumber: number;
    fee?: number;
    tickSpacing?: number;
  },
) {
  const existing = await context.PoolMeta.get(opts.poolAddr);
  if (existing) {
    if (context.isPreload) return;
    context.PoolMeta.set(
      poolMetaEntity({
        id: opts.poolAddr,
        address: existing.address ?? opts.poolAddr,
        protocol: (existing.protocol as Protocol) ?? opts.protocol,
        tokens: existing.tokens?.length ? [...existing.tokens] : [opts.token0, opts.token1],
        fee: opts.fee ?? existing.fee ?? undefined,
        tickSpacing: opts.tickSpacing ?? existing.tickSpacing ?? undefined,
        createdBlock: existing.createdBlock ?? opts.blockNumber,
        updatedAtBlock: opts.blockNumber,
        poolId: existing.poolId ?? undefined,
      }) as PoolMetaWritePayload,
    );
    return;
  }
  await persistFactoryPoolMeta(context, {
    poolAddr: opts.poolAddr,
    protocol: opts.protocol,
    token0: opts.token0,
    token1: opts.token1,
    blockNumber: opts.blockNumber,
    fee: opts.fee,
    tickSpacing: opts.tickSpacing,
  });
}

// AlgebraFactory emits `Pool(token0, token1, pool)` — not Uniswap V3 `PoolCreated`.
// QuickSwap V3 (Algebra V1.9) and V4 (Algebra Integral with plugin/hooks) both use
// this event. The Pool event omits fee/tickSpacing, so those are fetched via RPC.
indexer.onEvent(
  {
    contract: "AlgebraFactory",
    event: "Pool",
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;
    const factoryAddr = event.srcAddress;

    if (shouldSkipFactoryPool(t0, t1, factoryAddr)) {
      return;
    }

    const protocol = lookupAlgebraFactoryProtocol(factoryAddr);
    if (!protocol) return;

    const poolAddr = event.params.pool;
    const blockNumber = Number(event.block.number);

    const existing = await context.PoolMeta.get(poolAddr);
    const needsRepair = existing && (existing.fee == null || existing.tickSpacing == null);
    if (existing && !needsRepair) return;

    let meta = await context.effect(fetchAlgebraPoolMeta, {
      pool: poolAddr,
      blockNumber: BigInt(blockNumber),
    });
    // Archival hole / rate-limit at create block → try head before giving up.
    // Sequential on purpose: skip head RPC when historical already complete (tip path).
    if (meta.fee === 0n || meta.tickSpacing == null) {
      meta = await context.effect(fetchAlgebraPoolMeta, { pool: poolAddr });
    }

    if (context.isPreload) {
      // Effects registered above; skip writes / in-memory repair bookkeeping.
      return;
    }

    if (meta.fee === 0n || meta.tickSpacing == null) {
      // Persist identity so recon/discovery progress; fee/tick repaired onBlock.
      await writeAlgebraPool(context, {
        poolAddr,
        protocol,
        token0: t0,
        token1: t1,
        blockNumber,
      });
      noteAlgebraIncomplete(poolAddr, {
        token0: t0,
        token1: t1,
        protocol,
        createdBlock: existing?.createdBlock ?? blockNumber,
      });
      return;
    }

    await writeAlgebraPool(context, {
      poolAddr,
      protocol,
      token0: t0,
      token1: t1,
      blockNumber,
      fee: Number(meta.fee),
      tickSpacing: meta.tickSpacing,
    });
    clearAlgebraIncomplete(poolAddr);
  },
);

indexer.onBlock(
  {
    name: "AlgebraMetaRepair",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: REPAIR_START, _every: REPAIR_EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    if (incompleteAlgebra.size === 0) return;
    const batch: string[] = [];
    for (const addr of incompleteAlgebra.keys()) {
      batch.push(addr);
      if (batch.length >= REPAIR_BATCH) break;
    }
    const blockNumber = Number(block.number);

    // Preload-friendly: batch entity reads + effects concurrently, write after gate.
    // https://docs.envio.dev/docs/HyperIndex/preload-optimization
    const existings = await Promise.all(batch.map((pool) => context.PoolMeta.get(pool)));
    const toFetch: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const pool = batch[i]!;
      const existing = existings[i];
      if (existing?.fee != null && existing.tickSpacing != null) {
        clearAlgebraIncomplete(pool);
        continue;
      }
      if (!incompleteAlgebra.has(pool)) continue;
      toFetch.push(pool);
    }

    const metas = await Promise.all(
      toFetch.map((pool) => context.effect(fetchAlgebraPoolMeta, { pool })),
    );

    if (context.isPreload) return;

    for (let i = 0; i < toFetch.length; i++) {
      const pool = toFetch[i]!;
      const pending = incompleteAlgebra.get(pool);
      const meta = metas[i]!;
      if (!pending || meta.fee === 0n || meta.tickSpacing == null) continue;
      await writeAlgebraPool(context, {
        poolAddr: pool,
        protocol: pending.protocol,
        token0: pending.token0,
        token1: pending.token1,
        blockNumber,
        fee: Number(meta.fee),
        tickSpacing: meta.tickSpacing,
      });
      clearAlgebraIncomplete(pool);
    }
  },
);
