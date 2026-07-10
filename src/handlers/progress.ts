import { indexer } from "envio";
import { POLYGON_CHAIN_ID } from "../utils/constants";

const REALTIME_START = Number(process.env.INDEXER_PROGRESS_REALTIME_START ?? "65000000");
const HISTORICAL_EVERY = Number(process.env.INDEXER_PROGRESS_HISTORICAL_EVERY ?? "4000");
const REALTIME_EVERY = Number(process.env.INDEXER_PROGRESS_REALTIME_EVERY ?? "500");

async function writeIndexerProgress(
  context: {
    isPreload: boolean;
    IndexerProgress: {
      set(entity: { id: string; lastProcessedBlock: number; updatedAtBlock: number }): void;
    };
  },
  blockNumber: number,
): Promise<void> {
  if (context.isPreload) return;
  context.IndexerProgress.set({
    id: String(POLYGON_CHAIN_ID),
    lastProcessedBlock: blockNumber,
    updatedAtBlock: blockNumber,
  });
}

indexer.onBlock(
  {
    name: "IndexerProgressHistorical",
    where: ({ chain, block }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      if (block.number >= REALTIME_START) return false;
      return { block: { number: { _every: HISTORICAL_EVERY } } };
    },
  },
  async ({ block, context }) => {
    await writeIndexerProgress(context, Number(block.number));
  },
);

indexer.onBlock(
  {
    name: "IndexerProgressRealtime",
    where: ({ chain, block }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      if (block.number < REALTIME_START) return false;
      return { block: { number: { _every: REALTIME_EVERY } } };
    },
  },
  async ({ block, context }) => {
    await writeIndexerProgress(context, Number(block.number));
  },
);