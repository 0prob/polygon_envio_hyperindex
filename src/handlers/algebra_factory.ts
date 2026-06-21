import { indexer } from "envio";
import { lookupAlgebraFactoryProtocol } from "../utils/constants";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";

type Protocol =
  | "UNISWAP_V2"
  | "SUSHISWAP_V2"
  | "QUICKSWAP_V2"
  | "DFYN_V2"
  | "APESWAP_V2"
  | "MESHSWAP_V2"
  | "JETSWAP_V2"
  | "COMETHSWAP_V2"
  | "UNISWAP_V3"
  | "SUSHISWAP_V3"
  | "QUICKSWAP_V3"
  | "KYBERSWAP_ELASTIC"
  | "CURVE"
  | "BALANCER_V2"
  | "DODO_V2"
  | "UNISWAP_V4"
  | "UNKNOWN_V2"
  | "UNKNOWN_V3";

// QuickSwap V3 uses AlgebraFactory, which emits `Pool(token0, token1, pool)` — not Uniswap V3
// `PoolCreated`. Indexing it under V3Factory/PoolCreated silently dropped every QuickSwap V3 pool.
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

    const protocol = lookupAlgebraFactoryProtocol(factoryAddr);

    await persistFactoryPoolMeta(context, {
      poolAddr: event.params.pool,
      protocol: protocol as Protocol,
      token0: t0,
      token1: t1,
      blockNumber: Number(event.block.number),
      fee: undefined,
      tickSpacing: undefined,
    });
  },
);
