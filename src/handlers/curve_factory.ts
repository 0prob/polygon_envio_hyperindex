import { indexer } from "envio";
import type { Effect } from "envio";
import {
  curveFeeToPoolMetaInt,
  fetchCurveMetadata,
} from "../effects/curve_metadata";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { ZERO_ADDRESS, DEFAULT_CURVE_N_COINS } from "../utils/constants";


const DEFAULT_N_COINS = DEFAULT_CURVE_N_COINS;

interface CurveHandlerContext {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  PoolMeta: {
    get(id: string): Promise<{ id?: string } | undefined>;
    set(entity: unknown): void;
  };
  TokenMeta: {
    get(id: string): Promise<{ decimals?: number } | undefined>;
    getWhere(filter: { id: { _in: string[] } }): Promise<{ id: string; decimals?: number }[]>;
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

  const coins = meta.coins.filter((c: string) => c && c !== ZERO_ADDRESS);
  if (coins.length < 2) {
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
    coinMetas.map((m) => m.decimals),
    coinMetas.map((m) => m.trusted),
    tokenExisting,
  );
}

indexer.onEvent({ contract: "CurveTwocryptoFactory", event: "TwocryptoPoolDeployed" }, handleCurvePoolAdded as never);
indexer.onEvent({ contract: "CurveTricryptoFactory", event: "TricryptoPoolDeployed" }, handleCurvePoolAdded as never);
