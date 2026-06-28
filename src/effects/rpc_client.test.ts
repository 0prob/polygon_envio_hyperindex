import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLIC_FALLBACK_RPC_URLS,
  buildPublicClient,
  getRpcTransportTuning,
  getRpcUrls,
  redactRpcUrl,
  resetPublicClientForTest,
} from "./rpc_client";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

function snapshotEnv(keys: readonly string[]): void {
  for (const key of keys) {
    ENV_SNAPSHOT[key] = process.env[key];
  }
}

function restoreEnv(keys: readonly string[]): void {
  for (const key of keys) {
    const value = ENV_SNAPSHOT[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const RPC_ENV_KEYS = [
  "ENVIO_POLYGON_RPC_URLS",
  "ENVIO_POLYGON_RPC_URL",
  "POLYGON_RPC_URLS",
  "POLYGON_RPC_URL",
  "POLYGON_RPC",
  "HYPERSYNC_RPM_TARGET",
  "ENVIO_HYPERSYNC_RPM_TARGET",
  "VITEST",
] as const;

describe("redactRpcUrl", () => {
  it("redacts path-based API keys", () => {
    expect(redactRpcUrl("https://rpc.example.com/v2/secret-key-12345")).toBe(
      "https://rpc.example.com/v2/***",
    );
  });

  it("redacts query-string API keys", () => {
    expect(redactRpcUrl("https://rpc.example.com?apiKey=supersecret")).toBe(
      "https://rpc.example.com/?apiKey=***",
    );
  });
});

describe("getRpcUrls", () => {
  beforeEach(() => {
    snapshotEnv(RPC_ENV_KEYS);
    resetPublicClientForTest();
    for (const key of RPC_ENV_KEYS) delete process.env[key];
    process.env.VITEST = "true";
  });

  afterEach(() => {
    restoreEnv(RPC_ENV_KEYS);
    resetPublicClientForTest();
  });

  it("prefers ENVIO_POLYGON_RPC_URLS over POLYGON_RPC_URLS", () => {
    process.env.POLYGON_RPC_URLS = "https://polygon.example/a";
    process.env.ENVIO_POLYGON_RPC_URLS = "https://envio.example/b";
    expect(getRpcUrls()).toEqual(["https://envio.example/b", ...PUBLIC_FALLBACK_RPC_URLS]);
  });

  it("accepts POLYGON_RPC alias", () => {
    process.env.POLYGON_RPC = "https://alias.example/rpc";
    expect(getRpcUrls()).toEqual(["https://alias.example/rpc", ...PUBLIC_FALLBACK_RPC_URLS]);
  });

  it("falls back to public endpoints when unset", () => {
    expect(getRpcUrls()).toEqual([...PUBLIC_FALLBACK_RPC_URLS]);
  });
});

describe("getRpcTransportTuning", () => {
  it("uses larger multicall batches on high rpm but smaller HTTP batches to limit queue stalls", () => {
    const high = getRpcTransportTuning(200);
    const mid = getRpcTransportTuning(160);
    const low = getRpcTransportTuning(100);
    expect(high.multicallBatchSize).toBeGreaterThan(low.multicallBatchSize);
    expect(high.httpBatchSize).toBe(8);
    expect(mid.httpBatchSize).toBeGreaterThan(high.httpBatchSize);
  });
});

describe("buildPublicClient", () => {
  beforeEach(() => {
    snapshotEnv(RPC_ENV_KEYS);
    resetPublicClientForTest();
    for (const key of RPC_ENV_KEYS) delete process.env[key];
    process.env.VITEST = "true";
    process.env.POLYGON_RPC_URL = "https://rpc.example.com/v2/test-key";
  });

  afterEach(() => {
    restoreEnv(RPC_ENV_KEYS);
    resetPublicClientForTest();
  });

  it("returns a viem public client with readContract", () => {
    const client = buildPublicClient();
    expect(typeof client.readContract).toBe("function");
    expect(client.chain?.id).toBe(137);
  });
});
