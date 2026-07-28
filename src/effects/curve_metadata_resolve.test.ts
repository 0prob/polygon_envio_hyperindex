import { describe, expect, test } from "vitest";
import {
  resolveCurveDiscoveryFee,
  resolveCurveNCoins,
  curvePoolMetaNeedsEnrich,
  midFeeFromPackedFeeParams,
  feeFromCurveDeployEventParams,
  poolTypeFromCurveDeployEventParams,
} from "./curve_metadata";

describe("resolveCurveDiscoveryFee", () => {
  test("prefers fee() when present", () => {
    expect(resolveCurveDiscoveryFee(19_523_620n, 8_000_000n)).toBe(19_523_620n);
  });

  test("falls back to mid_fee when fee() missing (crypto pools)", () => {
    expect(resolveCurveDiscoveryFee(null, 26_000_000n)).toBe(26_000_000n);
    expect(resolveCurveDiscoveryFee(0n, 26_000_000n)).toBe(26_000_000n);
  });

  test("returns 0 when both missing", () => {
    expect(resolveCurveDiscoveryFee(null, null)).toBe(0n);
    expect(resolveCurveDiscoveryFee(0n, 0n)).toBe(0n);
  });
});

describe("event-embedded Curve deploy fees", () => {
  test("unpacks mid_fee from packed_fee_params (_pack_3)", () => {
    const mid = 26_000_000n;
    const out = 45_000_000n;
    // Factory packs (mid << 128) | (out << 64) | fee_gamma
    const packed = (mid << 128n) | (out << 64n) | 500_000_000n;
    expect(midFeeFromPackedFeeParams(packed)).toBe(mid);
  });

  test("reads PlainPool fee and CryptoPool mid_fee from event params", () => {
    expect(feeFromCurveDeployEventParams({ fee: 10_000_000n })).toBe(10_000_000n);
    expect(feeFromCurveDeployEventParams({ mid_fee: 26_000_000n })).toBe(26_000_000n);
  });

  test("classifies poolType from event fields", () => {
    expect(poolTypeFromCurveDeployEventParams({ fee: 1n, pool: "0x1" })).toBe("stable_ng");
    expect(poolTypeFromCurveDeployEventParams({ mid_fee: 1n, token: "0x1" })).toBe("crypto");
    expect(
      poolTypeFromCurveDeployEventParams({
        packed_fee_params: 1n << 128n,
        pool: "0x1",
      }),
    ).toBe("crypto_ng");
  });
});

describe("resolveCurveNCoins", () => {
  test("uses on-chain N_COINS when available", () => {
    expect(resolveCurveNCoins(2, 3n)).toBe(3);
  });

  test("uses explicit event n_coins > 2 when N_COINS unknown", () => {
    expect(resolveCurveNCoins(3, null)).toBe(3);
  });

  test("probes full window when only default hint (2) and N_COINS unknown", () => {
    // Prevents tricrypto bootstrap from truncating to 2 tokens.
    expect(resolveCurveNCoins(2, null)).toBe(8);
    expect(resolveCurveNCoins(0, null)).toBe(8);
  });
});

describe("curvePoolMetaNeedsEnrich", () => {
  test("missing row needs enrich", () => {
    expect(curvePoolMetaNeedsEnrich(undefined)).toBe(true);
  });

  test("fee null or thin tokens need enrich; fee 0 is valid on-chain zero", () => {
    expect(curvePoolMetaNeedsEnrich({ fee: null, tokens: ["0xa", "0xb"] })).toBe(true);
    expect(curvePoolMetaNeedsEnrich({ fee: 0, tokens: ["0xa", "0xb"] })).toBe(false);
    expect(curvePoolMetaNeedsEnrich({ fee: 26, tokens: ["0xa"] })).toBe(true);
  });

  test("complete row does not need enrich", () => {
    expect(curvePoolMetaNeedsEnrich({ fee: 26, tokens: ["0xa", "0xb"] })).toBe(false);
  });
});
