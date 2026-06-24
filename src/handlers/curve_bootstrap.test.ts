import { describe, expect, it } from "vitest";
import { shouldAdvanceBootstrapPage } from "./curve_bootstrap";

describe("shouldAdvanceBootstrapPage", () => {
  it("advances when every pool on the page was already indexed", () => {
    expect(shouldAdvanceBootstrapPage(0, 0)).toBe(true);
  });

  it("advances when at least one new pool had usable metadata", () => {
    expect(shouldAdvanceBootstrapPage(40, 1)).toBe(true);
    expect(shouldAdvanceBootstrapPage(40, 40)).toBe(true);
  });

  it("does not advance when every new pool failed metadata (retry page later)", () => {
    expect(shouldAdvanceBootstrapPage(40, 0)).toBe(false);
  });
});
