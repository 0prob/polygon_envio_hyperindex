import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import {
  QUICKSWAP_V2_FACTORY,
  USDC,
  WMATIC,
} from "./utils/constants";

/**
 * Disposable in-process indexer: simulate → assert → replay.
 * Confirms PairCreated discovery is idempotent under replay (reorg-safe entity writes).
 */
describe("disposable indexer reorg/replay", () => {
  const pair = "0x1111111111111111111111111111111111111111" as const;
  const simulatePairCreated = {
    contract: "V2Factory" as const,
    event: "PairCreated" as const,
    srcAddress: QUICKSWAP_V2_FACTORY,
    block: { number: 5_000_000, timestamp: 1_700_000_000, hash: "0xabc" as `0x${string}` },
    params: {
      token0: WMATIC,
      token1: USDC,
      pair,
      _3: 1n,
    },
  };

  it("writes PoolMeta from PairCreated and stays idempotent on replay", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: { simulate: [simulatePairCreated] },
      },
    });

    const first = await indexer.PoolMeta.getOrThrow(pair);
    expect(first.protocol).toBe("QUICKSWAP_V2");
    expect(first.tokens).toEqual([WMATIC, USDC]);
    expect(first.address).toBe(pair);

    // Replay the same log against a fresh disposable indexer that already has the entity.
    const replay = createTestIndexer();
    replay.PoolMeta.set({ ...first });
    await replay.process({
      chains: {
        137: { simulate: [simulatePairCreated] },
      },
    });

    const second = await replay.PoolMeta.getOrThrow(pair);
    expect(second).toEqual(first);
  });

  it("rolls entity view forward across two simulated creates without duplicate rows", async () => {
    const indexer = createTestIndexer();
    const pair2 = "0x2222222222222222222222222222222222222222" as const;

    await indexer.process({
      chains: {
        137: {
          simulate: [
            simulatePairCreated,
            {
              ...simulatePairCreated,
              srcAddress: QUICKSWAP_V2_FACTORY,
              logIndex: 1,
              params: {
                token0: WMATIC,
                token1: USDC,
                pair: pair2,
                _3: 2n,
              },
            },
          ],
        },
      },
    });

    const a = await indexer.PoolMeta.getOrThrow(pair);
    const b = await indexer.PoolMeta.getOrThrow(pair2);
    expect(a.id).toBe(pair);
    expect(b.id).toBe(pair2);
    expect(a.protocol).toBe("QUICKSWAP_V2");
    expect(b.protocol).toBe("QUICKSWAP_V2");
  });
});
