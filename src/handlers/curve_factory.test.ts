import { describe, expect, it } from "vitest";
import { nCoinsFromEventParams } from "./curve_factory";

describe("nCoinsFromEventParams", () => {
  it("uses named n_coins from PoolAdded(address,uint256,bool)", () => {
    expect(nCoinsFromEventParams({ pool: "0xabc", n_coins: 3n })).toBe(3);
    expect(nCoinsFromEventParams({ pool: "0xabc", nCoins: 4 })).toBe(4);
  });

  it("reads _1 only for the uint256+bool overload", () => {
    expect(nCoinsFromEventParams({ _0: "0xabc", _1: 3n, _2: true })).toBe(3);
    expect(nCoinsFromEventParams({ _0: "0xabc", _1: 0n, _2: false })).toBe(2);
  });

  it("ignores bytes _1 from PoolAdded(address,bytes)", () => {
    expect(
      nCoinsFromEventParams({
        _0: "0xabc",
        _1: "0x1234567890abcdef",
      }),
    ).toBe(2);
  });

  it("defaults when coin count is missing or invalid", () => {
    expect(nCoinsFromEventParams({ pool: "0xabc" })).toBe(2);
    expect(nCoinsFromEventParams({ pool: "0xabc", n_coins: 0n })).toBe(2);
    expect(nCoinsFromEventParams({ pool: "0xabc", n_coins: 99n })).toBe(8);
  });
});
