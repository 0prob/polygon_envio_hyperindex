import { describe, expect, it, vi, beforeEach } from "vitest";
import { USDC, WMATIC, WOOFI_PP_V2, MAJOR_TOKENS } from "../utils/constants";

const multicall = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { multicall: (...args: unknown[]) => multicall(...args) },
}));

import { fetchWooFiTokensHandler } from "./woofi_bootstrap";

describe("fetchWooFiTokens", () => {
  beforeEach(() => {
    multicall.mockReset();
  });

  it("returns quote token plus majors with non-zero reserve", async () => {
    multicall.mockImplementation((args: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
      return args.contracts.map((c) => {
        if (c.functionName === "quoteToken") {
          return { status: "success" as const, result: USDC };
        }
        if (c.functionName === "tokenInfos") {
          const token = String(c.args?.[0]).toLowerCase();
          if (token === WMATIC.toLowerCase()) {
            return { status: "success" as const, result: { reserve: 5_000_000n, feeRate: 25 } };
          }
          return { status: "success" as const, result: { reserve: 0n, feeRate: 0 } };
        }
        return { status: "failure" as const, error: new Error(`unexpected ${c.functionName}`) };
      });
    });

    const result = await fetchWooFiTokensHandler({
      input: { pool: WOOFI_PP_V2 },
      context: { cache: true },
    });

    expect(result.quoteToken).toBe(USDC.toLowerCase());
    expect(result.activeTokens).toContain(USDC.toLowerCase());
    expect(result.activeTokens).toContain(WMATIC.toLowerCase());
    expect(result.activeTokens.length).toBeGreaterThanOrEqual(2);
    expect(result.feeBps).toBe(3); // feeRate 25 → 2.5 bps → round to 3
    // Single multicall for quoteToken + all tokenInfos
    expect(multicall).toHaveBeenCalledTimes(1);
    const contracts = multicall.mock.calls[0][0].contracts;
    expect(contracts.length).toBe(1 + MAJOR_TOKENS.size);
  });

  it("does not cache when no active base tokens are found", async () => {
    multicall.mockImplementation((args: { contracts: { functionName: string }[] }) => {
      return args.contracts.map((c) => {
        if (c.functionName === "quoteToken") {
          return { status: "success" as const, result: USDC };
        }
        if (c.functionName === "tokenInfos") {
          return { status: "success" as const, result: { reserve: 0n, feeRate: 0 } };
        }
        return { status: "failure" as const, error: new Error(`unexpected ${c.functionName}`) };
      });
    });

    const ctx = { log: undefined, cache: true };
    const result = await fetchWooFiTokensHandler({
      input: { pool: WOOFI_PP_V2 },
      context: ctx,
    });

    expect(result).toEqual({ quoteToken: "", activeTokens: [], feeBps: 0 });
    expect(ctx.cache).toBe(false);
  });
});
