import { indexer } from "envio";
import { lookupV3FactoryProtocol } from "../utils/constants";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

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
