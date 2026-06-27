import { indexer } from "envio";
import { lookupV2FactoryProtocol } from "../utils/constants";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

// NOTE: The contractRegister that called `context.chain.UniswapV2Pool.add(...)` was removed.
// We no longer index per-pool Sync events (the handler was a no-op; the arb bot owns hot pool
// state via RPC). Pool discovery is fully served by the PairCreated onEvent below (→ PoolMeta).
indexer.onEvent(
  {
    contract: "V2Factory",
    event: "PairCreated",
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;
    const factoryAddr = event.srcAddress;

    if (shouldSkipFactoryPool(t0, t1, factoryAddr)) {
      return;
    }

    const info = lookupV2FactoryProtocol(factoryAddr);
    if (!info) return;

    await persistFactoryPoolMeta(context, {
      poolAddr: event.params.pair,
      protocol: info.protocol as Protocol,
      token0: t0,
      token1: t1,
      blockNumber: Number(event.block.number),
      fee: info.feeBps,
    });
  },
);
