import { indexer } from "envio";
import { lookupV3FactoryProtocol } from "../utils/constants";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

// NOTE: The contractRegister that called `context.chain.UniswapV3Pool.add(...)` was removed.
// Per-pool Swap/Initialize events are no longer indexed (handlers were no-ops; the arb bot owns
// hot pool state via RPC). Pool discovery is fully served by the PoolCreated onEvent below.
//
// QuickSwap V3 (Algebra) is indexed separately via AlgebraFactory.Pool — see algebra_factory.ts.
indexer.onEvent(
  {
    contract: "V3Factory",
    event: "PoolCreated",
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;
    const factoryAddr = event.srcAddress;

    if (shouldSkipFactoryPool(t0, t1, factoryAddr)) {
      return;
    }

    const protocol = lookupV3FactoryProtocol(factoryAddr);
    if (!protocol) return;

    await persistFactoryPoolMeta(context, {
      poolAddr: event.params.pool,
      protocol: protocol as Protocol,
      token0: t0,
      token1: t1,
      blockNumber: Number(event.block.number),
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
    });
  },
);
