import { describe, expect, it } from "vitest";
import { curveDiscoveryProtocol } from "./curve_registry";

describe("curveDiscoveryProtocol", () => {
  it("returns CURVE for HyperIndex Protocol enum regardless of poolType", () => {
    expect(curveDiscoveryProtocol("stable")).toBe("CURVE");
    expect(curveDiscoveryProtocol("crypto")).toBe("CURVE");
    expect(curveDiscoveryProtocol(undefined)).toBe("CURVE");
  });
});
