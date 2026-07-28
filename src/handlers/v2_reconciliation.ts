import { indexer } from "envio";
import { fetchV2FactoryPage } from "../effects/v2_factory_reconciliation";
import { POLYGON_CHAIN_ID, V2_FACTORY_PROTOCOLS } from "../utils/constants";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import { shouldSkipFactoryPool } from "../utils/guards";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

const FACTORIES = Object.entries(V2_FACTORY_PROTOCOLS);
const PAGE_SIZE = 40;
const EVERY = Number(process.env.V2_RECONCILIATION_EVERY ?? "500");

indexer.onBlock(
  {
    name: "V2FactoryReconciliation",
    where: ({ chain }) => chain.id === POLYGON_CHAIN_ID
      ? { block: { number: { _every: EVERY } } }
      : false,
  },
  async ({ block, context }) => {
    if (context.isPreload) return;
    const blockNumber = Number(block.number);
    for (const [factory, info] of FACTORIES) {
      const id = `${context.chain.id}-${factory}`;
      const prior = await context.V2FactoryReconciliationProgress.get(id);
      const initial = prior?.nextIndex;
      const page = await context.effect(fetchV2FactoryPage, {
        factory,
        offset: initial ?? 0,
        limit: PAGE_SIZE,
      });
      if (page.total === 0) continue;
      const offset = initial ?? Math.max(0, page.total - PAGE_SIZE);
      const reconciled = initial == null
        ? await context.effect(fetchV2FactoryPage, { factory, offset, limit: PAGE_SIZE })
        : page;
      for (const pool of reconciled.pools) {
        if (shouldSkipFactoryPool(pool.token0, pool.token1, factory)) continue;
        await persistFactoryPoolMeta(context, {
          poolAddr: pool.address,
          protocol: info.protocol as Protocol,
          token0: pool.token0,
          token1: pool.token1,
          blockNumber,
          fee: info.feeBps,
        });
      }
      const nextIndex = offset + PAGE_SIZE >= reconciled.total ? 0 : offset + PAGE_SIZE;
      context.V2FactoryReconciliationProgress.set({ id, nextIndex, updatedAtBlock: blockNumber });
    }
  },
);
