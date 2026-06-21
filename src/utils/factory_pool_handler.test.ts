import { describe, it, expect, vi } from "vitest";
import { persistFactoryPoolMeta } from "./factory_pool_handler";

const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T0 = "0x1111111111111111111111111111111111111111";
const T1 = "0x2222222222222222222222222222222222222222";

describe("persistFactoryPoolMeta", () => {
  it("returns without effects when PoolMeta already exists", async () => {
    const effect = vi.fn();
    const poolSet = vi.fn();
    const context = {
      isPreload: false,
      effect,
      PoolMeta: {
        get: vi.fn(async () => ({ id: POOL })),
        set: poolSet,
      },
      TokenMeta: { get: vi.fn(), set: vi.fn() },
    };

    await persistFactoryPoolMeta(context, {
      poolAddr: POOL,
      protocol: "QUICKSWAP_V2",
      token0: T0,
      token1: T1,
      blockNumber: 100,
      txHash: "0xabc",
      fee: 3000,
    });

    expect(effect).not.toHaveBeenCalled();
    expect(poolSet).not.toHaveBeenCalled();
  });

  it("runs token resolution but skips writes during preload", async () => {
    const effect = vi.fn();
    const poolSet = vi.fn();
    const tokenSet = vi.fn();
    const context = {
      isPreload: true,
      effect,
      PoolMeta: {
        get: vi.fn(async () => undefined),
        set: poolSet,
      },
      TokenMeta: {
        get: vi.fn(async () => ({ decimals: 18 })),
        set: tokenSet,
      },
    };

    await persistFactoryPoolMeta(context, {
      poolAddr: POOL,
      protocol: "QUICKSWAP_V2",
      token0: T0,
      token1: T1,
      blockNumber: 100,
      txHash: "0xabc",
      fee: 3000,
    });

    expect(poolSet).not.toHaveBeenCalled();
    expect(tokenSet).not.toHaveBeenCalled();
  });

  it("writes PoolMeta and trusted TokenMeta rows in execution phase", async () => {
    const effect = vi.fn();
    const poolSet = vi.fn();
    const tokenSet = vi.fn();
    const context = {
      isPreload: false,
      effect,
      PoolMeta: {
        get: vi.fn(async () => undefined),
        set: poolSet,
      },
      TokenMeta: {
        get: vi.fn(async (id: string) => {
          if (id === T0.toLowerCase()) return { decimals: 18 };
          if (id === T1.toLowerCase()) return { decimals: 6 };
          return undefined;
        }),
        set: tokenSet,
      },
    };

    await persistFactoryPoolMeta(context, {
      poolAddr: POOL,
      protocol: "QUICKSWAP_V2",
      token0: T0,
      token1: T1,
      blockNumber: 100,
      txHash: "0xabc",
      fee: 3000,
    });

    expect(effect).not.toHaveBeenCalled();
    expect(poolSet).toHaveBeenCalledTimes(1);
    expect(poolSet.mock.calls[0]?.[0]).toMatchObject({
      id: POOL,
      protocol: "QUICKSWAP_V2",
      tokens: [T0, T1],
      fee: 3000,
      createdBlock: 100,
    });
    expect(tokenSet).not.toHaveBeenCalled();
  });

  it("passes optional V4 poolId and hooks through to PoolMeta", async () => {
    const poolSet = vi.fn();
    const context = {
      isPreload: false,
      effect: vi.fn(),
      PoolMeta: {
        get: vi.fn(async () => undefined),
        set: poolSet,
      },
      TokenMeta: {
        get: vi.fn(async () => ({ decimals: 18 })),
        set: vi.fn(),
      },
    };

    await persistFactoryPoolMeta(context, {
      poolAddr: POOL,
      protocol: "UNISWAP_V4",
      token0: T0,
      token1: T1,
      blockNumber: 100,
      txHash: "0xabc",
      fee: 500,
      tickSpacing: 10,
      poolId: POOL,
      hooks: "0x0000000000000000000000000000000000000000",
    });

    expect(poolSet.mock.calls[0]?.[0]).toMatchObject({
      protocol: "UNISWAP_V4",
      poolId: POOL,
      hooks: "0x0000000000000000000000000000000000000000",
      tickSpacing: 10,
    });
  });
});
