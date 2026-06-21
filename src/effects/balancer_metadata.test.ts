import { describe, expect, it, vi, beforeEach } from "vitest";
import { BALANCER_VAULT, USDC, WETH } from "../utils/constants";

const readContract = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { readContract: (...args: unknown[]) => readContract(...args) },
}));

import { fetchBalancerMetadataHandler } from "./balancer_metadata";

const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_ID = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("fetchBalancerMetadata", () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  it("returns vault tokens when poolId is provided", async () => {
    readContract.mockImplementation((args: { address?: string; functionName: string }) => {
      if (args.address === BALANCER_VAULT && args.functionName === "getPoolTokens") {
        return Promise.resolve([[USDC, WETH], [1000n, 2000n], 12345n]);
      }
      if (args.functionName === "getSwapFeePercentage") return Promise.resolve(1_000_000_000_000_000n);
      if (args.functionName === "getNormalizedWeights") {
        return Promise.resolve([500000000000000000n, 500000000000000000n]);
      }
      if (args.functionName === "getAmplificationParameter") {
        return Promise.resolve([100n, false, 1000n]);
      }
      if (args.functionName === "getScalingFactors") {
        return Promise.resolve([1n, 1n]);
      }
      return Promise.reject(new Error(`unexpected ${args.functionName}`));
    });

    const result = await fetchBalancerMetadataHandler({
      input: { pool: POOL, poolId: POOL_ID, blockNumber: 15_900_000n },
      context: { cache: true },
    });

    expect(result.poolId).toBe(POOL_ID);
    expect(result.tokens).toEqual([USDC.toLowerCase(), WETH.toLowerCase()]);
    expect(result.balances).toEqual([1000n, 2000n]);
    expect(result.lastChangeBlock).toBe(12345n);
    expect(result.swapFee).toBe(1_000_000_000_000_000n);
  });

  it("does not cache when vault pool tokens read fails", async () => {
    readContract.mockImplementation((args: { address?: string; functionName: string }) => {
      if (args.address === BALANCER_VAULT && args.functionName === "getPoolTokens") {
        return Promise.reject(new Error("503 Service Unavailable"));
      }
      if (args.functionName === "getSwapFeePercentage") return Promise.resolve(0n);
      return Promise.resolve(undefined);
    });

    const ctx = { log: undefined, cache: true };
    const result = await fetchBalancerMetadataHandler({
      input: { pool: POOL, poolId: POOL_ID },
      context: ctx,
    });

    expect(result.tokens).toEqual([]);
    expect(ctx.cache).toBe(false);
  });
});
