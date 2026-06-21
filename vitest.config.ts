import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Isolate handler tests (createTestIndexer + rpc_client mock) from effect unit tests.
    pool: "forks",
  },
});
