import { describe, expect, it, vi, beforeEach } from "vitest";
import { CURVE_REGISTRY_LEGACY, USDC, USDT } from "../utils/constants";

const readContract = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { readContract: (...args: unknown[]) => readContract(...args) },
}));

import { fetchCurveRegistryPageHandler } from "./curve_registry_bootstrap";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("fetchCurveRegistryPage", () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  it("returns paginated pools with normalized coin lists", async () => {
    readContract.mockImplementation((args: { functionName: string; args?: readonly unknown[] }) => {
      if (args.functionName === "pool_count") return Promise.resolve(2n);
      if (args.functionName === "pool_list") {
        const idx = Number(args.args?.[0] ?? 0);
        return Promise.resolve(idx === 0 ? POOL_A : POOL_B);
      }
      if (args.functionName === "get_n_coins") return Promise.resolve(2n);
      if (args.functionName === "get_coins") {
        return Promise.resolve([USDC, USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO]);
      }
      return Promise.reject(new Error(`unexpected ${args.functionName}`));
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

  it("returns empty page when offset is beyond total", async () => {
    readContract.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "pool_count") return Promise.resolve(2n);
      return Promise.reject(new Error(`unexpected ${args.functionName}`));
    });

    const result = await fetchCurveRegistryPageHandler({
      input: { offset: 5, limit: 10 },
      context: { cache: true },
    });

    expect(result.total).toBe(2);
    expect(result.pools).toEqual([]);
  });

  it("does not cache when registry reads fail", async () => {
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
