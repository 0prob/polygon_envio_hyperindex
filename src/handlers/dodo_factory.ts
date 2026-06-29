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

interface DodoHandlerContext {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  PoolMeta: {
    get: (id: string) => Promise<{ id?: string } | undefined>;
    set: (entity: unknown) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    getWhere: (filter: { id: { _in: string[] } }) => Promise<{ id: string; decimals?: number }[]>;
    set: (entity: { id: string; decimals: number }) => void;
  };
}

async function handleDodoPool(
  context: DodoHandlerContext,
  pool: string,
  base: string,
  quote: string,
  blockNumber: number,
  poolType: string,
) {
  const existing = await context.PoolMeta.get(pool);
  if (existing) return;

  // Schedule ALL effects at the top (after cheap hot filter) so DODO + token metadata
  // participate in Envio preload batching + memoization. PoolMeta write moved after guard.
  // See https://docs.envio.dev/docs/HyperIndex/event-handlers#preload-optimization
  //
  // Use bounded concurrency (via runWithConcurrency) when HYPERSYNC_RPM_TARGET is low to avoid request spikes.
  // We start the DODO meta effect + the (possibly limited) token effects concurrently.
  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const dodoP = context.effect(fetchDodoMetadata, { pool, blockNumber: BigInt(blockNumber) });
  const tokensP = resolveTokenMetasBatch(context, [base, quote], tokenExisting);
  const [meta, results] = await Promise.all([dodoP, tokensP]);
  const baseMeta = results[0]!;
  const quoteMeta = results[1]!;

  if (context.isPreload) {
    return; // Aggressive preload exit: effects done (batched), skip writes (ignored anyway) and any future work.
  }

  const metadataUnavailable = meta.fee === 0n || meta.anyFailed;
  if (metadataUnavailable) {
    return;
  }

  const feeBps = dodoFeeToBps(meta.fee);

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
  }));

  // Hot DODO state comes from arb bot RPC — skip DodoPoolState DB write.
  await setTokenMetasIfMissing(
    context,
    [base, quote],
    [baseMeta.decimals, quoteMeta.decimals],
    [baseMeta.trusted, quoteMeta.trusted],
    tokenExisting,
  );
}

const DODO_POOL_EVENTS = [
  { event: "NewDVM" as const, poolField: "dvm" as const, poolType: "dvm" },
  { event: "NewDPP" as const, poolField: "dpp" as const, poolType: "dpp" },
  { event: "NewDSP" as const, poolField: "dsp" as const, poolType: "dsp" },
];

function registerDodoEvent(cfg: (typeof DODO_POOL_EVENTS)[number]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  indexer.onEvent({ contract: "DodoFactory", event: cfg.event }, async ({ event: ev, context }: any) => {
    const base = ev.params.baseToken;
    const quote = ev.params.quoteToken;
    if (shouldSkipFactoryPool(base, quote, ev.srcAddress)) {
      return;
    }

    await handleDodoPool(
      context,
      ev.params[cfg.poolField],
      base,
      quote,
      Number(ev.block.number),
      cfg.poolType,
    );
  });
}

for (const cfg of DODO_POOL_EVENTS) {
  registerDodoEvent(cfg);
}
