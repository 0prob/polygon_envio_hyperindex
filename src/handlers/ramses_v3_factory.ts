import { indexer } from "envio";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

const PROTOCOL: Protocol = "RAMSES_V3";

indexer.onEvent(
  {
    contract: "RamsesV3Factory",
    event: "PoolCreated",
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;

    if (shouldSkipFactoryPool(t0, t1, event.srcAddress)) {
      return;
    }

    await persistFactoryPoolMeta(context, {
      poolAddr: event.params.pool,
      protocol: PROTOCOL,
      token0: t0,
      token1: t1,
      blockNumber: Number(event.block.number),
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
    });
  },
);

indexer.onEvent(
  {
    contract: "RamsesV3Factory",
    event: "FeeAdjustment",
  },
  async ({ event, context }) => {
    const poolAddr = event.params.pool;
    const newFee = Number(event.params.newFee);
    const block = Number(event.block.number);

    const existing = await context.PoolMeta.get(poolAddr);
    if (!existing) return;

    context.PoolMeta.set({
      id: poolAddr,
      address: poolAddr,
      protocol: PROTOCOL,
      tokens: existing.tokens,
      fee: newFee,
      tickSpacing: existing.tickSpacing,
      createdBlock: existing.createdBlock,
      updatedAtBlock: block,
      poolId: existing.poolId,
      hooks: existing.hooks,
      poolType: existing.poolType,
    });
  },
);
