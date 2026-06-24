import { indexer, Effect } from "envio";
import {
  curveFeeToPoolMetaInt,
  fetchCurveMetadata,
  isCurveMetadataEmpty,
} from "../effects/curve_metadata";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { curveDiscoveryProtocol } from "../utils/curve_registry";

const CURVE_POOL_ADDED_EVENTS = ["PoolAdded", "PoolAdded(address,bytes)", "PoolAdded(address,uint256,bool)"] as const;
type CurvePoolAddedEvent = (typeof CURVE_POOL_ADDED_EVENTS)[number];

const ZERO = "0x0000000000000000000000000000000000000000";
/** Polygon Curve pools are 2–4 coins; cap RPC coin reads accordingly. */
const DEFAULT_N_COINS = 4;

interface TokenMetaResult {
  decimals: number;
  trusted: boolean;
}

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
    set(entity: { id: string; address: string; decimals: number }): void;
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

  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const coinMetas = await resolveTokenMetasBatch(context, coins, tokenExisting);

  if (context.isPreload) {
    return;
  }

  const feeBps = curveFeeToPoolMetaInt(meta.fee);

  context.PoolMeta.set(poolMetaEntity({
    id: pool,
    address: pool,
    protocol: curveDiscoveryProtocol(meta.poolType),
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
    coinMetas.map((m) => (m as TokenMetaResult).decimals),
    coinMetas.map((m) => (m as TokenMetaResult).trusted),
    tokenExisting,
  );
}

function registerCurvePoolAdded(eventName: CurvePoolAddedEvent): void {
  // Envio codegen types only the canonical event name; runtime supports all Curve registry variants.
  const curveEvent = eventName as "PoolAdded";
  // NOTE: The contractRegister that called `context.chain.CurvePool.add(...)` was removed.
  // Curve pool swap/liquidity events are no longer indexed (handlers were no-ops; the arb bot owns
  // hot pool state via RPC). Discovery is served by the PoolAdded onEvent below (→ PoolMeta).
  indexer.onEvent({ contract: "CurveRegistry", event: curveEvent }, handleCurvePoolAdded as never);
}

for (const eventName of CURVE_POOL_ADDED_EVENTS) {
  registerCurvePoolAdded(eventName);
}
