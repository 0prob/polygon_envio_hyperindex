import { setTokenMetasIfMissing } from "./entity_writes";
import { poolMetaEntity } from "./pool_meta_entity";
import { resolveTokenMetasBatch } from "./factory_token_meta";
import { ZERO_ADDRESS } from "./constants";
import type { IndexerProtocol, PoolMetaWritePayload } from "./indexer_protocol";

// Reusable scratch Map — avoids per-call allocation for the 2-token factory hot path.
// Safe because Envio processes events sequentially within a block.
const _sharedExisting = new Map<string, { decimals?: number } | undefined>();

type FactoryPoolMetaContext = {
  isPreload: boolean;
  PoolMeta: {
    get(id: string): Promise<{ id?: string } | undefined>;
    set(entity: PoolMetaWritePayload): void;
  };
  TokenMeta: {
    get(id: string): Promise<{ decimals?: number } | undefined>;
    getWhere(filter: { id: { _in: string[] } }): Promise<{ id: string; decimals?: number }[]>;
    set(entity: { id: string; decimals: number }): void;
  };
  effect: <I, O>(effect: import("envio").Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
};

type FactoryPoolMetaInput = {
  poolAddr: string;
  protocol: IndexerProtocol;
  token0: string;
  token1: string;
  blockNumber: number;
  updatedAtBlock?: number;
  fee?: number;
  tickSpacing?: number;
  poolId?: string;
  hooks?: string;
  poolType?: string;
};

/**
 * Shared PoolMeta + TokenMeta write path for factory discovery handlers.
 * Skips duplicate pools, batches token metadata effects, and avoids writes during preload.
 */
export async function persistFactoryPoolMeta(
  context: FactoryPoolMetaContext,
  input: FactoryPoolMetaInput,
): Promise<void> {
  const existing = await context.PoolMeta.get(input.poolAddr);
  if (existing) return;

  // Defensive: skip if the event emitted the zero address as the pool.
  // V2/V3 PairCreated/PoolCreated can emit zero on buggy factory deployments;
  // persisting it would create a bogus PoolMeta row with no real on-chain pool.
  if (input.poolAddr === ZERO_ADDRESS) return;

  _sharedExisting.clear();
  const results = await resolveTokenMetasBatch(context, [input.token0, input.token1], _sharedExisting);
  const [t0meta, t1meta] = [results[0]!, results[1]!];

  if (context.isPreload) {
    return;
  }

  context.PoolMeta.set(
    poolMetaEntity({
      id: input.poolAddr,
      address: input.poolAddr,
      protocol: input.protocol,
      tokens: [input.token0, input.token1],
      fee: input.fee,
      tickSpacing: input.tickSpacing,
      createdBlock: input.blockNumber,
      updatedAtBlock: input.updatedAtBlock ?? input.blockNumber,
      poolId: input.poolId,
      hooks: input.hooks,
      poolType: input.poolType,
    }) as PoolMetaWritePayload,
  );

  await setTokenMetasIfMissing(
    context,
    [input.token0, input.token1],
    [t0meta.decimals, t1meta.decimals],
    [t0meta.trusted, t1meta.trusted],
    _sharedExisting,
  );
}
