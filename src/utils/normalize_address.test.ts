import { describe, expect, it } from "vitest";
import { normalizeTokenAddress } from "./normalize_address";

describe("normalizeTokenAddress", () => {
  it("lowercases and pads short addresses", () => {
    expect(normalizeTokenAddress("0xAbC")).toBe(`0x${"abc".padStart(40, "0")}`);
  });

  it("leaves full-length lowercase addresses unchanged", () => {
    const addr = "0x1234567890123456789012345678901234567890";
    expect(normalizeTokenAddress(addr)).toBe(addr);
  });
});
