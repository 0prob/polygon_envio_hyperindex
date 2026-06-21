import { indexer } from "envio";
import { getProgressOnBlockStride } from "../utils/pacing";

/**
 * Block handler that maintains the IndexerProgress entity.
 *
 * This uses the official "Different Historical and Realtime Intervals" pattern:
 * https://docs.envio.dev/docs/HyperIndex/block-handlers#different-historical-and-realtime-intervals
 *
 * We register the *exact same handler function* twice, but with different `name`
 * values and different `where` filters (one with `_lte` + coarse stride for history,
 * one with `_gte` for the realtime tail). This gives fast historical backfills
 * while still providing reasonably fresh progress during live operation.
 *
 * Also demonstrates:
 * - Preload optimization guard (`context.isPreload`)
 * - Self-registration (no config.yaml entry required)
 * - Multi-chain ready `where` structure
 */

// -----------------------------------------------------------------------------
// Configuration (override via environment variables)
// -----------------------------------------------------------------------------
const POLYGON_CHAIN_ID = 137;

/** When chain start is >= this threshold, treat as live-debug high-start mode. */
const LIVE_DEBUG_START_THRESHOLD = 80_000_000;

/** Default realtime cutoff for progress tracking during historical backfill. */
const DEFAULT_REALTIME_START = 65_000_000;

const chainStart = (() => {
  // Read both POLYGON_START_BLOCK (set by bot process manager) and ENVIO_POLYGON_START_BLOCK
  // (set by standalone envio dev runs via env var). POLYGON_START_BLOCK takes priority.
  const v = process.env.POLYGON_START_BLOCK || process.env.ENVIO_POLYGON_START_BLOCK;
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const realtimeStart = (() => {
  // Also accept ENVIO_INDEXER_PROGRESS_REALTIME_START as an alias (set by bot process manager).
  const override = process.env.INDEXER_PROGRESS_REALTIME_START || process.env.ENVIO_INDEXER_PROGRESS_REALTIME_START;
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n)) return n;
  }
  if (chainStart >= LIVE_DEBUG_START_THRESHOLD) return chainStart;
  return DEFAULT_REALTIME_START;
})();

const HISTORICAL_EVERY = getProgressOnBlockStride(Number(process.env.INDEXER_PROGRESS_HISTORICAL_EVERY ?? 4000));
const REALTIME_EVERY = getProgressOnBlockStride(Number(process.env.INDEXER_PROGRESS_REALTIME_EVERY ?? 500));

// -----------------------------------------------------------------------------
// The single handler implementation (registered twice below)
// -----------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateIndexerProgress = async ({ block, context }: any) => {
  if (context.isPreload) return;

  const chainId = context.chain.id;

  context.IndexerProgress.set({
    id: String(chainId),
    chainId,
    lastProcessedBlock: block.number,
    updatedAtBlock: block.number,
  });
};

// -----------------------------------------------------------------------------
// Historical registration (coarse stride, everything before the cutoff)
// Only register if there is actually a historical range to cover for this chain.
// This avoids the noisy "indexer.onBlock matched 0 chains" warning in high-start
// live-debug runs (e.g. POLYGON_START_BLOCK=86M).
// -----------------------------------------------------------------------------
const shouldRegisterHistorical = realtimeStart != null && realtimeStart - 1 >= chainStart;

if (shouldRegisterHistorical) {
  const histEnd = realtimeStart - 1;

  indexer.onBlock(
    {
      name: "IndexerProgressHistorical",
      where: ({ chain }) => {
        if (chain.id !== POLYGON_CHAIN_ID) return false;
        return {
          block: { number: { _lte: histEnd, _every: HISTORICAL_EVERY } },
        };
      },
    },
    updateIndexerProgress,
  );
}

// -----------------------------------------------------------------------------
// Realtime registration (finer stride, from the cutoff forward)
// -----------------------------------------------------------------------------
const effectiveRealtimeStart = Math.max(realtimeStart, chainStart);

indexer.onBlock(
  {
    name: "IndexerProgressRealtime",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: effectiveRealtimeStart, _every: REALTIME_EVERY } },
      };
    },
  },
  updateIndexerProgress,
);
