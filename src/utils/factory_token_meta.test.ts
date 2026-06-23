import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveFactoryPairTokenMetas, resolveTokenMetasBatch } from "./factory_token_meta";

const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const COLD = "0x1111111111111111111111111111111111111111";

const lookupRegistryDecimalsBatchMock = vi.fn(async (_addresses: readonly string[]) => new Map());

vi.mock("../effects/token_metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../effects/token_metadata")>();
  return {
    ...actual,
    lookupRegistryDecimalsBatch: (addresses: readonly string[]) =>
      lookupRegistryDecimalsBatchMock(addresses),
  };
});

describe("resolveFactoryPairTokenMetas", () => {
  beforeEach(() => {
    lookupRegistryDecimalsBatchMock.mockReset();
    lookupRegistryDecimalsBatchMock.mockResolvedValue(new Map());
  });

  it("reuses trusted TokenMeta rows including decimals=18 without calling fetchTokenMeta", async () => {
    const effect = vi.fn();
    const context = {
      effect,
      TokenMeta: {
        get: vi.fn(async (id: string) => {
          if (id === WETH) return { decimals: 18 };
          if (id === USDC) return { decimals: 6 };
          return undefined;
        }),
      },
    } as Parameters<typeof resolveFactoryPairTokenMetas>[0];

    const [t0, t1] = await resolveFactoryPairTokenMetas(context, WETH, USDC);

    expect(t0).toEqual({ decimals: 18, trusted: true });
    expect(t1).toEqual({ decimals: 6, trusted: true });
    expect(effect).not.toHaveBeenCalled();
    expect(lookupRegistryDecimalsBatchMock).toHaveBeenCalledTimes(1);
  });

  it("uses batch registry lookup before fetchTokenMeta", async () => {
    lookupRegistryDecimalsBatchMock.mockResolvedValue(
      new Map([[COLD, { decimals: 9, trusted: true as const }]]),
    );
    const effect = vi.fn();
    const context = {
      effect,
      TokenMeta: {
        get: vi.fn(async (id: string) => (id === USDC ? { decimals: 6 } : undefined)),
      },
    } as Parameters<typeof resolveFactoryPairTokenMetas>[0];

    const [t0, t1] = await resolveFactoryPairTokenMetas(context, COLD, USDC);

    expect(t0).toEqual({ decimals: 9, trusted: true });
    expect(t1).toEqual({ decimals: 6, trusted: true });
    expect(lookupRegistryDecimalsBatchMock).toHaveBeenCalledWith([COLD, USDC]);
    expect(effect).not.toHaveBeenCalled();
  });

  it("fetches only tokens missing from Hasura and registry", async () => {
    const effect = vi.fn(async (_eff: unknown, input: { address: string }) => ({
      address: input.address.toLowerCase(),
      decimals: 9,
      trusted: true,
    }));
    const context = {
      effect,
      TokenMeta: {
        get: vi.fn(async (id: string) => (id === USDC ? { decimals: 6 } : undefined)),
      },
    } as Parameters<typeof resolveFactoryPairTokenMetas>[0];

    const [t0, t1] = await resolveFactoryPairTokenMetas(context, COLD, USDC);

    expect(t0).toMatchObject({ decimals: 9, trusted: true });
    expect(t1).toEqual({ decimals: 6, trusted: true });
    expect(lookupRegistryDecimalsBatchMock).toHaveBeenNthCalledWith(2, [COLD]);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("skips fetchTokenMeta during preload when registry lookup misses", async () => {
    const effect = vi.fn();
    const context = {
      isPreload: true,
      effect,
      TokenMeta: { get: vi.fn(async () => undefined) },
    } as Parameters<typeof resolveFactoryPairTokenMetas>[0];

    const [t0, t1] = await resolveFactoryPairTokenMetas(context, COLD, "0x2222222222222222222222222222222222222222");

    expect(t0).toEqual({ decimals: 18, trusted: false });
    expect(t1).toEqual({ decimals: 18, trusted: false });
    expect(lookupRegistryDecimalsBatchMock).toHaveBeenCalledTimes(2);
    expect(effect).not.toHaveBeenCalled();
  });
});

describe("resolveTokenMetasBatch", () => {
  beforeEach(() => {
    lookupRegistryDecimalsBatchMock.mockReset();
    lookupRegistryDecimalsBatchMock.mockResolvedValue(new Map());
  });

  it("dedupes tokens and reuses cached TokenMeta rows", async () => {
    const effect = vi.fn();
    const context = {
      effect,
      TokenMeta: {
        get: vi.fn(async (id: string) => {
          if (id === WETH) return { decimals: 18 };
          if (id === USDC) return { decimals: 6 };
          return undefined;
        }),
      },
    } as Parameters<typeof resolveTokenMetasBatch>[0];

    const metas = await resolveTokenMetasBatch(context, [WETH, USDC, WETH]);

    expect(metas).toHaveLength(3);
    expect(metas[0]).toEqual({ decimals: 18, trusted: true });
    expect(metas[1]).toEqual({ decimals: 6, trusted: true });
    expect(metas[2]).toEqual({ decimals: 18, trusted: true });
    expect(effect).not.toHaveBeenCalled();
  });
});
