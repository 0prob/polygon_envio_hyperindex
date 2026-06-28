import { describe, expect, it } from "vitest";
import {
  getMetadataConcurrency,
  getTokenMetaEffectRateLimit,
  isLowQuota,
} from "./pacing";

describe("getMetadataConcurrency", () => {
  it("returns tighter concurrency on low HyperSync quotas", () => {
    const prev = process.env.HYPERSYNC_RPM_TARGET;
    try {
      process.env.HYPERSYNC_RPM_TARGET = "200";
      expect(getMetadataConcurrency()).toBe(3);

      process.env.HYPERSYNC_RPM_TARGET = "110";
      expect(getMetadataConcurrency()).toBe(1);
      expect(isLowQuota()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HYPERSYNC_RPM_TARGET;
      else process.env.HYPERSYNC_RPM_TARGET = prev;
    }
  });
});

describe("getTokenMetaEffectRateLimit", () => {
  it("lowers token meta ceiling when quota is tight", () => {
    const prev = process.env.HYPERSYNC_RPM_TARGET;
    try {
      process.env.HYPERSYNC_RPM_TARGET = "200";
      expect(getTokenMetaEffectRateLimit()).toEqual({ calls: 250, per: "second" });

      process.env.HYPERSYNC_RPM_TARGET = "100";
      expect(getTokenMetaEffectRateLimit()).toEqual({ calls: 40, per: "second" });
    } finally {
      if (prev === undefined) delete process.env.HYPERSYNC_RPM_TARGET;
      else process.env.HYPERSYNC_RPM_TARGET = prev;
    }
  });
});
