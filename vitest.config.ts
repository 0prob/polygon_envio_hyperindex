import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Keep disposable createTestIndexer offline: no Hasura, no HyperSync pages.
    env: {
      ENVIO_HASURA: "false",
      ENVIO_API_TOKEN: "",
      FACTORY_EVENT_RECONCILIATION_EVERY: "1000000000",
      V2_RECONCILIATION_EVERY: "1000000000",
      BALANCER_POOLTYPE_REPAIR_EVERY: "1000000000",
      INDEXER_PROGRESS_HISTORICAL_EVERY: "1000000000",
      INDEXER_PROGRESS_REALTIME_EVERY: "1000000000",
    },
  },
});
