import { describe, expect, it, vi, beforeEach } from "vitest";

const readContract = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { readContract: (...args: unknown[]) => readContract(...args) },
}));

import {
  dodoFeeToBps,
  fetchDodoMetadataHandler,
  isDodoMetadataEmpty,
} from "./dodo_metadata";

// Resolve/reject per call based on the requested functionName so the test mirrors
// viem's real `readContract` (singular) API rather than the wagmi `readContracts` action.
function mockFeeReads(lp: { result?: bigint; error?: Error }, mt: { result?: bigint; error?: Error }) {
  readContract.mockImplementation((args: { functionName: string }) => {
    const spec = args.functionName === "_LP_FEE_RATE_" ? lp : mt;
    return spec.error ? Promise.reject(spec.error) : Promise.resolve(spec.result);
  });
}

describe("dodoFeeToBps", () => {
  it("converts 1e18 fee fractions to basis points using LP+MT total", () => {
    expect(dodoFeeToBps(3_000_000_000_000_000n)).toBe(30);
    expect(dodoFeeToBps(3_000_000_000_000_000n + 1_000_000_000_000_000n)).toBe(40);
    expect(dodoFeeToBps(0n)).toBe(10);
  });

  it("uses MT fee alone when LP read reverts", () => {
    expect(dodoFeeToBps(1_000_000_000_000_000n)).toBe(10);
  });
});

describe("fetchDodoMetadata", () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  it("indexes pools when _MT_FEE_RATE_ reverts at creation block", async () => {
    mockFeeReads({ result: 3000000000000000n }, { error: new Error("reverted") });

    const result = await fetchDodoMetadataHandler({
      input: { pool: "0x99e29393dc4d7ecbbd41e297ed59e4022f1cae07", blockNumber: 16075385n },
      context: { log: undefined, cache: true },
    });

    expect(result.lpFeeRate).toBe(3000000000000000n);
    expect(result.mtFeeRate).toBe(0n);
    expect(result.fee).toBe(3000000000000000n);
    expect(isDodoMetadataEmpty(result)).toBe(false);
  });

  it("does not cache when every fee read fails", async () => {
    mockFeeReads({ error: new Error("timeout") }, { error: new Error("timeout") });

    const ctx = { log: undefined, cache: true };
    const result = await fetchDodoMetadataHandler({
      input: { pool: "0x15db6bed8499619214c2390875e94b4a8c408df2", blockNumber: 25743969n },
      context: ctx,
    });

    expect(isDodoMetadataEmpty(result)).toBe(true);
    expect(ctx.cache).toBe(false);
  });

  it("falls back to latest state when block-pinned reads are empty", async () => {
    readContract.mockImplementation((args: { functionName: string; blockNumber?: bigint }) => {
      if (args.blockNumber !== undefined) {
        return Promise.resolve(0n);
      }
      const rate = args.functionName === "_LP_FEE_RATE_" ? 3_000_000_000_000_000n : 1_000_000_000_000_000n;
      return Promise.resolve(rate);
    });

    const ctx = { log: undefined, cache: true };
    const result = await fetchDodoMetadataHandler({
      input: { pool: "0x35b99823199541e5eb466d32afb4bfef4f3dacf6", blockNumber: 15279604n },
      context: ctx,
    });

    expect(isDodoMetadataEmpty(result)).toBe(false);
    expect(result.fee).toBe(4_000_000_000_000_000n);
    expect(ctx.cache).toBe(true);
    expect(readContract).toHaveBeenCalledTimes(4);
  });
});
