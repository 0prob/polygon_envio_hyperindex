import { describe, expect, it, vi, beforeEach } from "vitest";
import { USDC, WMATIC, WOOFI_PP_V2 } from "../utils/constants";

const readContract = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { readContract: (...args: unknown[]) => readContract(...args) },
}));

import { fetchWooFiTokensHandler } from "./woofi_bootstrap";

describe("fetchWooFiTokens", () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  it("returns quote token plus majors with non-zero reserve", async () => {
    readContract.mockImplementation((args: { functionName: string; args?: readonly unknown[] }) => {
      if (args.functionName === "quoteToken") {
        return Promise.resolve(USDC);
      }
      if (args.functionName === "tokenInfos") {
        const token = String(args.args?.[0]).toLowerCase();
        if (token === WMATIC.toLowerCase()) {
          return Promise.resolve({ reserve: 5_000_000n, feeRate: 25 });
        }
        return Promise.resolve({ reserve: 0n, feeRate: 0 });
      }
      return Promise.reject(new Error(`unexpected ${args.functionName}`));
    });

    const result = await fetchWooFiTokensHandler({
      input: { pool: WOOFI_PP_V2 },
      context: { cache: true },
    });

    expect(result.quoteToken).toBe(USDC.toLowerCase());
    expect(result.activeTokens).toContain(USDC.toLowerCase());
    expect(result.activeTokens).toContain(WMATIC.toLowerCase());
    expect(result.activeTokens.length).toBeGreaterThanOrEqual(2);
  });

  it("does not cache when no active base tokens are found", async () => {
    readContract.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "quoteToken") {
        return Promise.resolve(USDC);
      }
      if (args.functionName === "tokenInfos") {
        return Promise.resolve({ reserve: 0n, feeRate: 0 });
      }
      return Promise.reject(new Error(`unexpected ${args.functionName}`));
    });

    const ctx = { log: undefined, cache: true };
    const result = await fetchWooFiTokensHandler({
      input: { pool: WOOFI_PP_V2 },
      context: ctx,
    });

    expect(result).toEqual({ quoteToken: "", activeTokens: [] });
    expect(ctx.cache).toBe(false);
  });
});
