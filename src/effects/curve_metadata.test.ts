import { describe, expect, it, vi, beforeEach } from "vitest";

const multicall = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { multicall: (...args: unknown[]) => multicall(...args) },
}));

import {
  curveDiscoveryPoolType,
  curveFeeToBps,
  curveFeeToPoolMetaInt,
  curvePoolTypeFromGamma,
  fetchCurveMetadataHandler,
  isCurveMetadataEmpty,
  resolveCurveNCoins,
} from "./curve_metadata";

const POOL = "0xabc1234567890123456789012345678901234567";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const ZERO = "0x0000000000000000000000000000000000000000";

function toMulticallResult(value: unknown) {
  return { status: "success" as const, result: value };
}

function toMulticallError() {
  return { status: "failure" as const, error: new Error("reverted") };
}

function mockCurveReads(opts: {
  fee?: bigint;
  gamma?: bigint | null;
  version?: string | null;
  nCoins?: bigint | null;
  coins?: (string | null)[];
}) {
  multicall.mockImplementation((args: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
    const byName = new Map<string, unknown>();
    for (const c of args.contracts) {
      if (c.functionName === "fee") byName.set("fee", toMulticallResult(opts.fee ?? 4_000_000n));
      else if (c.functionName === "gamma") byName.set("gamma", opts.gamma === null ? toMulticallError() : toMulticallResult(opts.gamma ?? 0n));
      else if (c.functionName === "version") byName.set("version", opts.version === null ? toMulticallError() : toMulticallResult(opts.version ?? ""));
      else if (c.functionName === "N_COINS") byName.set("N_COINS", opts.nCoins === null ? toMulticallError() : toMulticallResult(opts.nCoins ?? 0n));
      else if (c.functionName === "coins") {
        const i = Number(c.args?.[0] ?? 0);
        const coin: string | null | undefined = opts.coins?.[i];
        // null = RPC failure, undefined = not specified (returns ZERO)
        byName.set(`coins:${i}`, coin === null ? toMulticallError() : toMulticallResult(coin ?? ZERO));
      }
    }
    return args.contracts.map((c) => {
      if (c.functionName === "coins") {
        const i = Number(c.args?.[0] ?? 0);
        return byName.get(`coins:${i}`) ?? toMulticallResult(ZERO);
      }
      if (c.functionName === "gamma" || c.functionName === "version" || c.functionName === "N_COINS") {
        const v = byName.get(c.functionName);
        return v ?? toMulticallResult(undefined);
      }
      return byName.get(c.functionName) ?? toMulticallResult(0n);
    });
  });
}

describe("curveFeeToBps", () => {
  it("converts 1e-10 fee units to basis points", () => {
    expect(curveFeeToBps(4_000_000n)).toBe(4);
    expect(curveFeeToBps(0n)).toBe(4);
  });

  it("handles sub-bps fees without truncating to default", () => {
    expect(curveFeeToBps(500_000n)).toBe(0.5);
    expect(curveFeeToBps(100_000n)).toBe(0.1);
    expect(curveFeeToBps(1_000_000n)).toBe(1);
  });

  it("preserves multi-bps precision", () => {
    expect(curveFeeToBps(10_000_000n)).toBe(10);
    expect(curveFeeToBps(999_999n)).toBe(0.999999);
  });
});

describe("curveFeeToPoolMetaInt", () => {
  it("rounds fractional bps to GraphQL Int with minimum 1", () => {
    expect(curveFeeToPoolMetaInt(500_000n)).toBe(1);
    expect(curveFeeToPoolMetaInt(1_500_000n)).toBe(2);
    expect(curveFeeToPoolMetaInt(4_000_000n)).toBe(4);
  });
});

describe("curvePoolTypeFromGamma", () => {
  it("classifies crypto only when gamma is positive", () => {
    expect(curvePoolTypeFromGamma(null)).toBe("stable");
    expect(curvePoolTypeFromGamma(0n)).toBe("stable");
    expect(curvePoolTypeFromGamma(1n)).toBe("crypto");
  });
});

describe("curveDiscoveryPoolType", () => {
  it("maps NG probes to stable_ng and crypto_ng", () => {
    expect(curveDiscoveryPoolType(null, true)).toBe("stable_ng");
    expect(curveDiscoveryPoolType(1n, true)).toBe("crypto_ng");
    expect(curveDiscoveryPoolType(1n, false)).toBe("crypto");
  });
});

describe("resolveCurveNCoins", () => {
  it("caps coin reads at eight", () => {
    expect(resolveCurveNCoins(10, 6n)).toBe(8);
    expect(resolveCurveNCoins(2, 5n)).toBe(5);
  });
});

describe("fetchCurveMetadata", () => {
  beforeEach(() => {
    multicall.mockReset();
  });

  it("returns discovery fields via single multicall", async () => {
    mockCurveReads({ fee: 4_000_000n, gamma: null, version: null, nCoins: null, coins: [USDC, USDT] });

    const result = await fetchCurveMetadataHandler({
      input: { pool: POOL, nCoins: 2, blockNumber: 58_600_000n },
      context: { log: undefined, cache: true },
    });

    expect(result.poolType).toBe("stable");
    expect(result.coins).toEqual([USDC.toLowerCase(), USDT.toLowerCase()]);
    expect(isCurveMetadataEmpty(result)).toBe(false);

    // Single multicall call, not individual readContract calls
    expect(multicall).toHaveBeenCalledTimes(1);
    const contracts = multicall.mock.calls[0][0].contracts;
    const fns = contracts.map((c: { functionName: string }) => c.functionName);
    expect(fns).toContain("fee");
    expect(fns).toContain("gamma");
    expect(fns).toContain("version");
    expect(fns).toContain("N_COINS");
    expect(fns.filter((f: string) => f === "coins")).toHaveLength(8);
  });

  it("classifies NG pools when version() succeeds", async () => {
    mockCurveReads({ fee: 4_000_000n, gamma: 0n, version: "v1.0.0", nCoins: 2n, coins: [USDC, USDT] });

    const result = await fetchCurveMetadataHandler({
      input: { pool: POOL, nCoins: 2 },
      context: { log: undefined, cache: true },
    });

    expect(result.poolType).toBe("stable_ng");
  });

  it("does not cache when every read fails", async () => {
    multicall.mockRejectedValue(new Error("timeout"));

    const ctx = { log: undefined, cache: true };
    const result = await fetchCurveMetadataHandler({
      input: { pool: POOL, nCoins: 2 },
      context: ctx,
    });

    expect(isCurveMetadataEmpty(result)).toBe(true);
    expect(ctx.cache).toBe(false);
  });

  it("does not cache when coin reads partially fail", async () => {
    mockCurveReads({ fee: 4_000_000n, gamma: 0n, version: null, nCoins: 2n, coins: [USDC, null] });

    const ctx = { log: undefined, cache: true };
    const result = await fetchCurveMetadataHandler({
      input: { pool: POOL, nCoins: 2 },
      context: ctx,
    });

    // fee succeeded but coin[1] read failed → don't cache
    expect(result.fee).toBe(4_000_000n);
    expect(result.coins).toEqual([USDC.toLowerCase()]);
    expect(ctx.cache).toBe(false);
  });
});
