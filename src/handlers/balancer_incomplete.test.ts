import { describe, expect, test } from "vitest";
import { isIncompletePoolMeta } from "../utils/balancer_incomplete";

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
