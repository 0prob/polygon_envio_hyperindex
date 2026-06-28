import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { getHistoricalMetaEffectRateLimit } from "../utils/pacing";

const ALGEBRA_POOL_ABI = parseAbi([
  "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
]);

/**
 * Algebra pool fee (QuickSwap V3). globalState().fee is in hundredths of a
 * basis point (same format as Uniswap V3 PoolCreated event fee), e.g. 3000 = 0.3%.
 * Stored as-is in PoolMeta.fee (no conversion needed).
 */
export const fetchAlgebraPoolFee = createEffect(
  {
    name: "fetchAlgebraPoolFee",
    input: {
      pool: S.string,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      fee: S.bigint,
    },
    rateLimit: getHistoricalMetaEffectRateLimit(),
    cache: true,
  },
  async ({ input, context }: {
    input: { pool: string; blockNumber?: bigint };
    context: any;
  }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;
      const state = await publicClient.readContract({
        address: pool,
        abi: ALGEBRA_POOL_ABI,
        functionName: "globalState",
        ...opts,
      }) as [bigint, number, number, number, number, number, boolean];
      return { fee: BigInt(state[2]) };
    } catch (err: unknown) {
      if (context.log) {
        context.log.warn("Failed to fetch Algebra pool fee", {
          pool: input.pool,
          error: String(err),
        });
      }
      context.cache = false;
      return { fee: 0n };
    }
  },
);
