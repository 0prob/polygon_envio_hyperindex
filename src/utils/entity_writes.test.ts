import { describe, expect, it, vi } from "vitest";
import { setTokenMetaEntriesIfMissing, setTokenMetasIfMissing } from "./entity_writes";

const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";

describe("setTokenMetasIfMissing", () => {
  it("skips writes when TokenMeta already has the same decimals", async () => {
    const set = vi.fn();
    const context = {
      TokenMeta: {
        get: vi.fn(async (id: string) => (id === USDC ? { decimals: 6 } : undefined)),
        getWhere: vi.fn(async (f: { id: { _in: string[] } }) =>
          f.id._in.map((id) => ({ id, decimals: 6 })),
        ),
        set,
      },
    };

    await setTokenMetasIfMissing(context, [USDC], [6], [true]);

    expect(set).not.toHaveBeenCalled();
  });

  it("upgrades stale default 18-dec rows when trusted decimals differ", async () => {
    const set = vi.fn();
    const context = {
      TokenMeta: {
        get: vi.fn(async () => ({ decimals: 18 })),
        getWhere: vi.fn(async (f: { id: { _in: string[] } }) =>
          f.id._in.map((id) => ({ id, decimals: 18 })),
        ),
        set,
      },
    };

    await setTokenMetasIfMissing(context, [USDC], [6], [true]);

    expect(set).toHaveBeenCalledWith({
      id: USDC,
      decimals: 6,
    });
  });

  it("dedupes duplicate addresses in one batch", async () => {
    const set = vi.fn();
    const context = {
      TokenMeta: {
        get: vi.fn(async () => undefined),
        getWhere: vi.fn(async () => []),
        set,
      },
    };

    await setTokenMetaEntriesIfMissing(context, [
      { address: WETH, decimals: 18, trusted: true },
      { address: WETH.toUpperCase(), decimals: 18, trusted: true },
    ]);

    expect(set).toHaveBeenCalledTimes(1);
  });

  it("does not persist untrusted 18-dec defaults for new tokens", async () => {
    const set = vi.fn();
    const context = {
      TokenMeta: {
        get: vi.fn(async () => undefined),
        getWhere: vi.fn(async () => []),
        set,
      },
    };

    await setTokenMetasIfMissing(context, [WETH], [18], [false]);

    expect(set).not.toHaveBeenCalled();
  });
});
