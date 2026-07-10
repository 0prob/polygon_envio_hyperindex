import { indexer } from "envio";
import { fetchAlgebraPoolMeta } from "../effects/algebra_pool_metadata";
import { shouldSkipFactoryPool } from "../utils/guards";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import { ALGEBRA_FACTORY_PROTOCOLS } from "../utils/constants";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

function lookupAlgebraFactoryProtocol(factoryAddr: string): Protocol | undefined {
  return ALGEBRA_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()] as Protocol | undefined;
}

// AlgebraFactory emits `Pool(token0, token1, pool)` — not Uniswap V3 `PoolCreated`.
// QuickSwap V3 (Algebra V1.9) and V4 (Algebra Integral with plugin/hooks) both use
// this event. The Pool event omits fee/tickSpacing, so those are fetched via RPC.
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
    if (!protocol) return;

    const poolAddr = event.params.pool;
    const blockNumber = Number(event.block.number);

    // ponytail: skip existing pools before the RPC effect. Algebra pools emit
    // Pool once at creation; re-processing (reorg) wastes a globalState() call.
    const existing = await context.PoolMeta.get(poolAddr);

    const needsRepair = existing && (existing.fee == null || existing.tickSpacing == null);
    if (existing && !needsRepair) return;

    const meta = await context.effect(fetchAlgebraPoolMeta, {
      pool: poolAddr,
      blockNumber: BigInt(blockNumber),
    });
    // ponytail: fee=0 means RPC failure (Algebra pools never have 0 fee).
    // Returning early lets the next instance retry fresh; writing PoolMeta
    // with fee=undefined would permanently corrupt the row.
    if (meta.fee === 0n) return;
    const fee = Number(meta.fee);
    const tickSpacing = meta.tickSpacing != null ? meta.tickSpacing : undefined;

    if (existing) {
      context.PoolMeta.set({
        ...existing,
        id: poolAddr,
        address: existing.address ?? poolAddr,
        protocol: existing.protocol ?? protocol,
        tokens: existing.tokens?.length ? existing.tokens : [t0, t1],
        fee,
        tickSpacing,
        updatedAtBlock: blockNumber,
      });
      return;
    }

    await persistFactoryPoolMeta(context, {
      poolAddr,
      protocol,
      token0: t0,
      token1: t1,
      blockNumber,
      fee,
      tickSpacing,
    });
  },
);
