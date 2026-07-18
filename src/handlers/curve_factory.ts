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
  // Twocrypto/Tricrypto/PlainPoolDeployed use `pool`; crypto factory uses `token` (LP = pool).
  const raw =
    (params.pool as string | undefined) ??
    (params.token as string | undefined) ??
    (params._0 as string | undefined);
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.toLowerCase();
}

function coinsFromEventParams(params: Record<string, unknown>): string[] {
  const raw = params.coins;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((coin) => (typeof coin === "string" ? coin.toLowerCase() : ""))
    .filter((coin) => coin && coin !== ZERO_ADDRESS);
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

  const eventCoins = coinsFromEventParams(event.params as Record<string, unknown>);
  const nCoins = eventCoins.length >= 2 ? eventCoins.length : nCoinsFromEventParams(event.params);

  const meta = await context.effect(fetchCurveMetadata, {
    pool,
    nCoins,
    blockNumber: BigInt(blockNumber),
    knownCoins: eventCoins.length >= 2 ? eventCoins : undefined,
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

// Twocrypto / Tricrypto NG
indexer.onEvent({ contract: "CurveTwocryptoFactory", event: "TwocryptoPoolDeployed" }, handleCurvePoolAdded as never);
indexer.onEvent({ contract: "CurveTricryptoFactory", event: "TricryptoPoolDeployed" }, handleCurvePoolAdded as never);
// Stableswap-NG plain pools (metapools lack pool address in the event — covered by bootstrap growth re-probe)
indexer.onEvent({ contract: "CurveStableswapNgFactory", event: "PlainPoolDeployed" }, handleCurvePoolAdded as never);
// Legacy crypto factory
indexer.onEvent({ contract: "CurveCryptoFactory", event: "CryptoPoolDeployed" }, handleCurvePoolAdded as never);
