import { describe, expect, it } from "vitest";
import { isNetworkError, isQuotaError } from "../effects/rpc_client";

describe("rpc_errors", () => {
  it("isQuotaError avoids bare 'rate' substring false positives", () => {
    expect(isQuotaError(new Error("operate on separate pool"))).toBe(false);
    expect(isQuotaError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isQuotaError(new Error("Monthly capacity exceeded"))).toBe(true);
  });

  it("isNetworkError detects transport failures", () => {
    expect(isNetworkError(new Error("HTTP request failed. Status code: 503"))).toBe(true);
    expect(isNetworkError(new Error("execution reverted"))).toBe(false);
  });
});
