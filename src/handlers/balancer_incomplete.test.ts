import { describe, expect, test } from "vitest";

// Mirror of isIncompletePoolMeta in balancer.ts — keep in sync.
function isIncompletePoolMeta(existing: {
  poolType?: string | null;
  fee?: number | null;
  tokens?: string[] | null;
}): boolean {
  const missingType = existing.poolType == null || existing.poolType === "";
  const missingFee = existing.fee == null;
  const thinTokens = !existing.tokens || existing.tokens.length < 2;
  return missingType || missingFee || thinTokens;
}

describe("balancer incomplete repair gate", () => {
  test("poolType alone is not enough to clear incomplete", () => {
    expect(
      isIncompletePoolMeta({
        poolType: "weighted",
        fee: null,
        tokens: ["0xa", "0xb"],
      }),
    ).toBe(true);
  });

  test("complete row clears incomplete", () => {
    expect(
      isIncompletePoolMeta({
        poolType: "weighted",
        fee: 30,
        tokens: ["0xa", "0xb"],
      }),
    ).toBe(false);
  });
});
