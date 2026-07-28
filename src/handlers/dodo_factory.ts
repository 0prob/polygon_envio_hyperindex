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
import { POLYGON_CHAIN_ID } from "../utils/constants";
import type { PoolMetaWritePayload } from "../utils/indexer_protocol";

export type DodoHandlerContext = {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  PoolMeta: {
    get: (id: string) => Promise<{
      id?: string;
      fee?: number | null;
      tokens?: readonly string[] | null;
      createdBlock?: number;
      poolType?: string | null;
    } | undefined>;
    set: (entity: PoolMetaWritePayload) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    getWhere: (filter: { id: { _in: string[] } }) => Promise<{ id: string; decimals?: number }[]>;
    set: (entity: { id: string; decimals: number }) => void;
  };
};

/** Fee-incomplete DODO pools — repaired onBlock (recon advances once identity is known). */
const incompleteDodoFee = new Map<
  string,
  { base: string; quote: string; poolType: string; createdBlock: number }
>();
const REPAIR_EVERY = Number(process.env.DODO_FEE_REPAIR_EVERY ?? "5000");
const REPAIR_BATCH = Number(process.env.DODO_FEE_REPAIR_BATCH ?? "8");
const REPAIR_START = Number(process.env.DODO_FEE_REPAIR_START ?? "65000000");

export async function handleDodoPool(
  context: DodoHandlerContext,
  pool: string,
  base: string,
  quote: string,
  blockNumber: number,
  poolType: string,
): Promise<boolean> {
  const poolKey = pool.toLowerCase();
  const existing = await context.PoolMeta.get(pool);
  const needsFee =
    !!existing && (existing.fee == null || existing.fee === 0);
  // Complete row — nothing to do.
  if (existing && !needsFee) {
    incompleteDodoFee.delete(poolKey);
    return true;
  }

  // Schedule ALL effects at the top (after cheap hot filter) so DODO + token metadata
  // participate in Envio preload batching + memoization. PoolMeta write moved after gate.
  // https://docs.envio.dev/docs/HyperIndex/preload-optimization
  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const dodoP = context.effect(fetchDodoMetadata, { pool, blockNumber: BigInt(blockNumber) });
  const tokensP = resolveTokenMetasBatch(context, [base, quote], tokenExisting);
  let [meta, results] = await Promise.all([dodoP, tokensP]);
  // Historical miss → head fallback (skip when already at head / repair stride).
  if ((meta.fee <= 0n || meta.anyFailed)) {
    const head = await context.effect(fetchDodoMetadata, { pool });
    if (head.fee > 0n && !head.anyFailed) meta = head;
  }
  const baseMeta = results[0]!;
  const quoteMeta = results[1]!;

  if (context.isPreload) {
    return true;
  }

  const feeOk = meta.fee > 0n && !meta.anyFailed;
  const feeBps = feeOk ? dodoFeeToBps(meta.fee) : undefined;

  // Always persist discovery (tokens + poolType). Missing fee → repair onBlock.
  context.PoolMeta.set(poolMetaEntity({
    id: pool,
    address: pool,
    protocol: "DODO_V2",
    tokens: existing?.tokens?.length ? [...existing.tokens] : [base, quote],
    fee: feeBps ?? existing?.fee ?? undefined,
    tickSpacing: undefined,
    createdBlock: existing?.createdBlock ?? blockNumber,
    updatedAtBlock: blockNumber,
    poolId: undefined,
    poolType: existing?.poolType ?? poolType,
  }) as PoolMetaWritePayload);

  await setTokenMetasIfMissing(
    context,
    [base, quote],
    [baseMeta.decimals, quoteMeta.decimals],
    [baseMeta.trusted, quoteMeta.trusted],
    tokenExisting,
  );

  if (feeOk) {
    incompleteDodoFee.delete(poolKey);
  } else {
    incompleteDodoFee.set(poolKey, {
      base,
      quote,
      poolType: existing?.poolType ?? poolType,
      createdBlock: existing?.createdBlock ?? blockNumber,
    });
  }
  // Identity known from the factory event — always advance recon.
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

indexer.onBlock(
  {
    name: "DodoFeeRepair",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: REPAIR_START, _every: REPAIR_EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    if (incompleteDodoFee.size === 0) return;
    const batch: string[] = [];
    for (const addr of incompleteDodoFee.keys()) {
      batch.push(addr);
      if (batch.length >= REPAIR_BATCH) break;
    }
    const blockNumber = Number(block.number);

    // Preload-friendly: register all fee + token effects concurrently, then write.
    await Promise.all(
      batch.map(async (pool) => {
        const pending = incompleteDodoFee.get(pool);
        if (!pending) return;
        await handleDodoPool(
          context,
          pool,
          pending.base,
          pending.quote,
          blockNumber,
          pending.poolType,
        );
      }),
    );
  },
);
