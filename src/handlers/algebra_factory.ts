import { indexer } from "envio";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

const ALGEBRA_PROTOCOL = "QUICKSWAP_V3" as Protocol;

// QuickSwap V3 uses AlgebraFactory, which emits `Pool(token0, token1, pool)` — not Uniswap V3
// `PoolCreated`. Indexing it under V3Factory/PoolCreated silently dropped every QuickSwap V3 pool.
// ponytail: single factory → hardcoded protocol; hook back to lookupAlgebraFactoryProtocol if additional Algebra factories are added.
indexer.onEvent(
  {
    contract: "AlgebraFactory",
    event: "Pool",
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;
    const factoryAddr = event.srcAddress;

    if (shouldSkipFactoryPool(t0, t1, factoryAddr)) {
      return;
    }

    await persistFactoryPoolMeta(context, {
      poolAddr: event.params.pool,
      protocol: ALGEBRA_PROTOCOL,
      token0: t0,
      token1: t1,
      blockNumber: Number(event.block.number),
      fee: undefined,
      tickSpacing: undefined,
    });
  },
);
