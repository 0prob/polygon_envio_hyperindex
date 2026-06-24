import { describe, expect, it, vi, beforeEach } from "vitest";

const readContract = vi.fn();

vi.mock("./rpc_client", () => ({
  publicClient: { readContract: (...args: unknown[]) => readContract(...args) },
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

function mockCurveReads(opts: {
  fee?: bigint;
  gamma?: bigint | null;
  version?: string | null;
  nCoins?: bigint | null;
  coins?: string[];
}) {
  readContract.mockImplementation((args: { functionName: string; args?: readonly unknown[] }) => {
    if (args.functionName === "fee") {
      return Promise.resolve(opts.fee ?? 4_000_000n);
    }
    if (args.functionName === "gamma") {
      if (opts.gamma === null) return Promise.reject(new Error("reverted"));
      return Promise.resolve(opts.gamma ?? 0n);
    }
    if (args.functionName === "version") {
      if (opts.version === null) return Promise.reject(new Error("reverted"));
      return Promise.resolve(opts.version ?? "");
    }
    if (args.functionName === "N_COINS") {
      if (opts.nCoins === null) return Promise.reject(new Error("reverted"));
      return Promise.resolve(opts.nCoins ?? 0n);
    }
    if (args.functionName === "coins") {
      const i = Number(args.args?.[0] ?? 0);
      const coin = opts.coins?.[i] ?? "0x0000000000000000000000000000000000000000";
      return Promise.resolve(coin);
    }
    return Promise.reject(new Error(`unexpected ${args.functionName}`));
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
    readContract.mockReset();
  });

  it("returns discovery fields without balances/rates reads", async () => {
    mockCurveReads({ fee: 4_000_000n, gamma: null, version: null, nCoins: null, coins: [USDC, USDT] });

    const result = await fetchCurveMetadataHandler({
      input: { pool: POOL, nCoins: 2, blockNumber: 58_600_000n },
      context: { log: undefined, cache: true },
    });

    expect(result.poolType).toBe("stable");
    expect(result.coins).toEqual([USDC.toLowerCase(), USDT.toLowerCase()]);
    expect(isCurveMetadataEmpty(result)).toBe(false);

    const functionNames = readContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(functionNames.slice(0, 4)).toEqual(["fee", "gamma", "version", "N_COINS"]);
    expect(functionNames).not.toContain("balances");
    expect(functionNames).not.toContain("rates");
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
    readContract.mockRejectedValue(new Error("timeout"));

    const ctx = { log: undefined, cache: true };
    const result = await fetchCurveMetadataHandler({
      input: { pool: POOL, nCoins: 2 },
      context: ctx,
    });

    expect(isCurveMetadataEmpty(result)).toBe(true);
    expect(ctx.cache).toBe(false);
  });
});
