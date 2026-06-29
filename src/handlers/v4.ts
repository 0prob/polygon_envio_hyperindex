import { indexer } from "envio";
import { isLikelyGarbagePair } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";

indexer.onEvent(
  {
    contract: "PoolManager",
    event: "Initialize",
  },
  async ({ event, context }) => {
    const poolId = event.params.id;
    const currency0 = event.params.currency0;
    const currency1 = event.params.currency1;
    if (isLikelyGarbagePair(currency0, currency1)) {
      return;
    }

    await persistFactoryPoolMeta(context, {
      poolAddr: poolId,
      protocol: "UNISWAP_V4",
      token0: currency0,
      token1: currency1,
      blockNumber: Number(event.block.number),
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      poolId,
      hooks: event.params.hooks,
    });
  },
);

