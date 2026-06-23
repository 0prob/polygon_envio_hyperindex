import { indexer, Effect } from "envio";
import {
  dodoFeeToBps,
  fetchDodoMetadata,
  isDodoMetadataEmpty,
} from "../effects/dodo_metadata";
import { resolveFactoryPairTokenMetas } from "../utils/factory_token_meta";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { shouldSkipFactoryPool } from "../utils/guards";

interface DodoHandlerContext {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  log?: { warn: (msg: string, ctx?: unknown) => void; info?: (msg: string, ctx?: unknown) => void };
  PoolMeta: {
    get: (id: string) => Promise<{ id?: string } | undefined>;
    set: (entity: unknown) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    set: (entity: { id: string; address: string; decimals: number }) => void;
  };
}

async function handleDodoPool(
  context: DodoHandlerContext,
  pool: string,
  base: string,
  quote: string,
  blockNumber: number,
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
  const tokensP = resolveFactoryPairTokenMetas(context, base, quote, tokenExisting);
  const [meta, [baseMeta, quoteMeta]] = await Promise.all([dodoP, tokensP]);

  if (context.isPreload) {
    return; // Aggressive preload exit: effects done (batched), skip writes (ignored anyway) and any future work.
  }

  const metadataUnavailable = isDodoMetadataEmpty(meta);
  if (metadataUnavailable && context.log) {
    context.log.warn("DODO metadata RPC unavailable — indexing from factory event with default fee", {
      pool,
    });
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
      poolId: undefined,
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
  { event: "NewDVM" as const, poolField: "dvm" as const, label: "DVM" },
  { event: "NewDPP" as const, poolField: "dpp" as const, label: "DPP" },
  { event: "NewDSP" as const, poolField: "dsp" as const, label: "DSP" },
];

function registerDodoEvent(cfg: (typeof DODO_POOL_EVENTS)[number]): void {
  // NOTE: The contractRegister that called `context.chain.DodoPool.add(...)` was removed.
  // DodoPool.Sync is no longer indexed (handler was a no-op; the arb bot owns hot pool state via
  // RPC). Discovery is served by the factory onEvent below (→ PoolMeta).
  indexer.onEvent({ contract: "DodoFactory", event: cfg.event }, async ({ event: ev, context }: any) => {
    // eslint-disable-line @typescript-eslint/no-explicit-any
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
    );
  });
}

for (const cfg of DODO_POOL_EVENTS) {
  registerDodoEvent(cfg);
}
