import { describe, expect, it, vi, beforeEach } from "vitest";
import { CURVE_REGISTRY_LEGACY, USDC, USDT } from "../utils/constants";

const readContract = vi.fn();
const multicall = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: {
    readContract: (...args: unknown[]) => readContract(...args),
    multicall: (...args: unknown[]) => multicall(...args),
  },
}));

import { fetchCurveRegistryPageHandler } from "./curve_registry_bootstrap";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0x0000000000000000000000000000000000000000";

function successResult(result: unknown) {
  return { status: "success" as const, result, error: undefined };
}

describe("fetchCurveRegistryPage", () => {
  beforeEach(() => {
    readContract.mockReset();
    multicall.mockReset();
  });

  it("returns paginated pools with normalized coin lists", async () => {
    readContract.mockImplementation((args: { functionName: string; args?: readonly unknown[] }) => {
      if (args.functionName === "pool_count") return Promise.resolve(2n);
      return Promise.reject(new Error(`unexpected readContract: ${args.functionName}`));
    });

    multicall.mockImplementation((args: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
      const results = args.contracts.map((c) => {
        if (c.functionName === "pool_list") {
          const idx = Number(c.args?.[0] ?? 0);
          return successResult(idx === 0 ? POOL_A : POOL_B);
        }
        if (c.functionName === "get_n_coins") return successResult(2n);
        if (c.functionName === "get_coins") {
          return successResult([USDC, USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO]);
        }
        throw new Error(`unexpected multicall: ${c.functionName}`);
      });
      return Promise.resolve(results);
    });

    const result = await fetchCurveRegistryPageHandler({
      input: { offset: 0, limit: 10, registryAddress: CURVE_REGISTRY_LEGACY },
      context: { cache: true },
    });

    expect(result.total).toBe(2);
    expect(result.pools).toHaveLength(2);
    expect(result.pools[0]).toEqual({
      address: POOL_A.toLowerCase(),
      coins: [USDC.toLowerCase(), USDT.toLowerCase()],
    });
  });

  it("skips pools whose metadata multicall fails", async () => {
    let multicallCount = 0;
    readContract.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "pool_count") return Promise.resolve(2n);
      return Promise.reject(new Error(`unexpected readContract: ${args.functionName}`));
    });

    multicall.mockImplementation((args: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
      multicallCount++;
      // First call: pool_list for 2 indices
      if (multicallCount === 1) {
        return Promise.resolve(args.contracts.map((c, j) =>
          successResult(j === 0 ? POOL_A : POOL_B)
        ));
      }
      // Second call: metadata for 2 pools (4 contracts interleaved)
      return Promise.resolve(args.contracts.map((c, idx) => {
        // indices 0,1 = POOL_A (success), indices 2,3 = POOL_B (failure)
        if (idx >= 2) return { status: "failure" as const, result: undefined, error: new Error("revert") };
        if (c.functionName === "get_n_coins") return successResult(2n);
        return successResult([USDC, USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO]);
      }));
    });

    const result = await fetchCurveRegistryPageHandler({
      input: { offset: 0, limit: 10, registryAddress: CURVE_REGISTRY_LEGACY },
      context: { log: undefined, cache: true },
    });

    expect(result.total).toBe(2);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.address).toBe(POOL_A.toLowerCase());
    expect(result.pools[0]!.coins).toEqual([USDC.toLowerCase(), USDT.toLowerCase()]);
  });

  it("returns empty page when offset is beyond total", async () => {
    readContract.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "pool_count") return Promise.resolve(2n);
      return Promise.reject(new Error(`unexpected readContract: ${args.functionName}`));
    });

    const result = await fetchCurveRegistryPageHandler({
      input: { offset: 5, limit: 10 },
      context: { cache: true },
    });

    expect(result.total).toBe(2);
    expect(result.pools).toEqual([]);
  });

  it("does not cache when pool_count fails", async () => {
    readContract.mockRejectedValue(new Error("timeout"));

    const ctx = { log: undefined, cache: true };
    const result = await fetchCurveRegistryPageHandler({
      input: { offset: 0, limit: 10 },
      context: ctx,
    });

    expect(result).toEqual({ total: 0, pools: [] });
    expect(ctx.cache).toBe(false);
  });
});
