import { describe, expect, it } from "vitest";
import {
  APESWAP_V2_FACTORY,
  QUICKSWAP_V2_FACTORY,
  USDC,
  WETH,
  ZERO_ADDRESS,
} from "./constants";
import { isLikelyGarbagePair, shouldSkipFactoryPool } from "./guards";

describe("isLikelyGarbagePair", () => {
  it("rejects identical tokens and zero addresses", () => {
    expect(isLikelyGarbagePair(USDC, USDC)).toBe(true);
    expect(isLikelyGarbagePair(ZERO_ADDRESS, WETH)).toBe(true);
    expect(isLikelyGarbagePair(WETH, ZERO_ADDRESS)).toBe(true);
  });

  it("rejects known factory addresses used as pool tokens", () => {
    expect(isLikelyGarbagePair(QUICKSWAP_V2_FACTORY, WETH)).toBe(true);
    expect(isLikelyGarbagePair(WETH, APESWAP_V2_FACTORY)).toBe(true);
  });

  it("accepts a normal token pair", () => {
    expect(isLikelyGarbagePair(USDC, WETH)).toBe(false);
  });
});

describe("shouldSkipFactoryPool", () => {
  it("rejects pools where either token is the emitting factory", () => {
    expect(shouldSkipFactoryPool(QUICKSWAP_V2_FACTORY, WETH, QUICKSWAP_V2_FACTORY)).toBe(true);
    expect(shouldSkipFactoryPool(WETH, QUICKSWAP_V2_FACTORY, QUICKSWAP_V2_FACTORY)).toBe(true);
  });

  it("reuses garbage-pair guards for normal factory addresses", () => {
    expect(shouldSkipFactoryPool(USDC, USDC, QUICKSWAP_V2_FACTORY)).toBe(true);
    expect(shouldSkipFactoryPool(USDC, WETH, QUICKSWAP_V2_FACTORY)).toBe(false);
  });
});
