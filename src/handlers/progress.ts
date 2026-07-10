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

// Envio onBlock `where` only receives `{ chain }` — block filters use _gte/_lte/_every.
indexer.onBlock(
  {
    name: "IndexerProgressHistorical",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _lte: REALTIME_START - 1, _every: HISTORICAL_EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    await writeIndexerProgress(context, Number(block.number));
  },
);

indexer.onBlock(
  {
    name: "IndexerProgressRealtime",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: REALTIME_START, _every: REALTIME_EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    await writeIndexerProgress(context, Number(block.number));
  },
);