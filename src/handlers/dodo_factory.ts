import { indexer } from "envio";
import type { Effect } from "envio";
import {
  dodoFeeToBps,
  fetchDodoMetadata,
} from "../effects/dodo_metadata";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { shouldSkipFactoryPool } from "../utils/guards";
import type { PoolMetaWritePayload } from "../utils/indexer_protocol";

export type DodoHandlerContext = {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  PoolMeta: {
    get: (id: string) => Promise<{ id?: string } | undefined>;
    set: (entity: PoolMetaWritePayload) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    getWhere: (filter: { id: { _in: string[] } }) => Promise<{ id: string; decimals?: number }[]>;
    set: (entity: { id: string; decimals: number }) => void;
  };
};

export async function handleDodoPool(
  context: DodoHandlerContext,
  pool: string,
  base: string,
  quote: string,
  blockNumber: number,
  poolType: string,
): Promise<boolean> {
  const existing = await context.PoolMeta.get(pool);
  if (existing) return true;

  // Schedule ALL effects at the top (after cheap hot filter) so DODO + token metadata
  // participate in Envio preload batching + memoization. PoolMeta write moved after guard.
  // See https://docs.envio.dev/docs/HyperIndex/event-handlers#preload-optimization
  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const dodoP = context.effect(fetchDodoMetadata, { pool, blockNumber: BigInt(blockNumber) });
  const tokensP = resolveTokenMetasBatch(context, [base, quote], tokenExisting);
  const [meta, results] = await Promise.all([dodoP, tokensP]);
  const baseMeta = results[0]!;
  const quoteMeta = results[1]!;

  if (context.isPreload) {
    return true;
  }

  // Always persist discovery (tokens + poolType). Fee RPC failures used to drop the
  // pool entirely and stall factory-event recon pages — prefer fee=undefined so the
  // bot still sees the pool; fee can be filled on a later successful effect.
  const feeBps = meta.fee > 0n && !meta.anyFailed ? dodoFeeToBps(meta.fee) : undefined;

  context.PoolMeta.set(poolMetaEntity({
    id: pool,
    address: pool,
    protocol: "DODO_V2",
    tokens: [base, quote],
    fee: feeBps,
    tickSpacing: undefined,
    createdBlock: blockNumber,
    updatedAtBlock: blockNumber,
    poolId: undefined,
    poolType,
  }) as PoolMetaWritePayload);

  // Hot DODO state comes from arb bot RPC — skip DodoPoolState DB write.
  await setTokenMetasIfMissing(
    context,
    [base, quote],
    [baseMeta.decimals, quoteMeta.decimals],
    [baseMeta.trusted, quoteMeta.trusted],
    tokenExisting,
  );
  return true;
}

indexer.onEvent({ contract: "DodoFactory", event: "NewDVM" }, async ({ event, context }) => {
  const base = event.params.baseToken;
  const quote = event.params.quoteToken;
  if (shouldSkipFactoryPool(base, quote, event.srcAddress)) return;
  await handleDodoPool(context, event.params.dvm, base, quote, Number(event.block.number), "dvm");
});

indexer.onEvent({ contract: "DodoFactory", event: "NewDPP" }, async ({ event, context }) => {
  const base = event.params.baseToken;
  const quote = event.params.quoteToken;
  if (shouldSkipFactoryPool(base, quote, event.srcAddress)) return;
  await handleDodoPool(context, event.params.dpp, base, quote, Number(event.block.number), "dpp");
});

indexer.onEvent({ contract: "DodoFactory", event: "NewDSP" }, async ({ event, context }) => {
  const base = event.params.baseToken;
  const quote = event.params.quoteToken;
  if (shouldSkipFactoryPool(base, quote, event.srcAddress)) return;
  await handleDodoPool(context, event.params.dsp, base, quote, Number(event.block.number), "dsp");
});
