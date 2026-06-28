import { indexer, Effect } from "envio";
import {
  curveFeeToPoolMetaInt,
  fetchCurveMetadata,
  isCurveMetadataEmpty,
} from "../effects/curve_metadata";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch, type FactoryTokenMeta } from "../utils/factory_token_meta";
import { ZERO_ADDRESS, DEFAULT_CURVE_N_COINS } from "../utils/constants";

const ZERO = ZERO_ADDRESS;
/** Polygon Curve pools are 2–4 coins; cap RPC coin reads accordingly. */
const DEFAULT_N_COINS = DEFAULT_CURVE_N_COINS;

interface CurveHandlerContext {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  log?: { warn: (msg: string, ctx?: unknown) => void; info?: (msg: string, ctx?: unknown) => void };
  PoolMeta: {
    get(id: string): Promise<{ id?: string } | undefined>;
    set(entity: unknown): void;
  };
  TokenMeta: {
    get(id: string): Promise<{ decimals?: number } | undefined>;
    set(entity: { id: string; decimals: number }): void;
  };
}

export function nCoinsFromEventParams(params: Record<string, unknown>): number {
  const named = params.n_coins ?? params.nCoins;
  if (named != null) {
    const n = Number(named);
    if (!Number.isFinite(n) || n < 2) return DEFAULT_N_COINS;
    return Math.min(Math.floor(n), 8);
  }
  // PoolAdded(address,uint256,bool) only — do not treat PoolAdded(address,bytes) _1 as n_coins.
  if (typeof params._1 === "bigint" && typeof params._2 === "boolean") {
    const n = Number(params._1);
    if (!Number.isFinite(n) || n < 2) return DEFAULT_N_COINS;
    return Math.min(Math.floor(n), 8);
  }
  return DEFAULT_N_COINS;
}

function poolAddressFromEventParams(params: Record<string, unknown>): string | undefined {
  return (params._0 as string | undefined) ?? (params.pool as string | undefined);
}

async function handleCurvePoolAdded({
  event,
  context,
}: {
  event: {
    params: Record<string, unknown> & { pool: string };
    block: { number: bigint };
    transaction: { hash: string };
  };
  context: CurveHandlerContext;
}) {
  const pool = poolAddressFromEventParams(event.params as Record<string, unknown>);
  if (!pool) {
    if (context.log) {
      context.log.warn("Curve PoolAdded event missing pool address", { params: event.params });
    }
    return;
  }
  const blockNumber = Number(event.block.number);

  const existing = await context.PoolMeta.get(pool);
  if (existing) return;

  const nCoins = nCoinsFromEventParams(event.params);

  const meta = await context.effect(fetchCurveMetadata, {
    pool,
    nCoins,
    blockNumber: BigInt(blockNumber),
  });

  const coins = meta.coins.filter((c: string) => c && c !== ZERO);
  if (coins.length < 2) {
    if (isCurveMetadataEmpty(meta) && context.log) {
      context.log.warn("Curve metadata RPC unavailable — skipping PoolAdded", { pool, nCoins });
    }
    return;
  }

  // Partial RPC failure: coins resolved but fee read failed. Don't write
  // PoolMeta with fee=0 — the arb bot needs real fee data. Retry on re-index.
  if (meta.fee === 0n) {
    if (context.log) {
      context.log.warn("Curve metadata fee read failed — skipping PoolAdded (will retry)", { pool });
    }
    return;
  }

  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const coinMetas = await resolveTokenMetasBatch(context, coins, tokenExisting);

  if (context.isPreload) {
    return;
  }

  const feeBps = curveFeeToPoolMetaInt(meta.fee);

  context.PoolMeta.set(poolMetaEntity({
    id: pool,
    address: pool,
    protocol: "CURVE",
    tokens: coins,
    fee: feeBps,
    tickSpacing: undefined,
    createdBlock: blockNumber,
    updatedAtBlock: blockNumber,
    poolId: undefined,
    poolType: meta.poolType,
  }));

  await setTokenMetasIfMissing(
    context,
    coins,
    coinMetas.map((m) => (m as FactoryTokenMeta).decimals),
    coinMetas.map((m) => (m as FactoryTokenMeta).trusted),
    tokenExisting,
  );
}

indexer.onEvent({ contract: "CurveRegistry", event: "PoolAdded" }, handleCurvePoolAdded as never);
