import { indexer } from "envio";
import { lookupV3FactoryProtocol } from "../utils/constants";
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
  | "RAMSES_V3"
  | "CURVE"
  | "BALANCER_V2"
  | "DODO_V2"
  | "UNISWAP_V4"
  | "UNKNOWN_V2"
  | "UNKNOWN_V3";

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
