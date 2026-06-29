import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";

// ponytail: Algebra Integral globalState() (6 return values) works for both
// QuickSwap V3 (Algebra V1.9, 7 return values) and V4 (Algebra Integral, 6).
// Extra bytes from V1.9 are ignored by viem's decoder; fee is uint16 at pos 2
// in both. Source: https://github.com/cryptoalgebra/Algebra integral-v1.2.2
const ALGEBRA_POOL_ABI = parseAbi([
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function tickSpacing() view returns (int24)",
]);

/**
 * Algebra pool metadata (QuickSwap V3 + V4). Fetches fee + tickSpacing via
 * multicall (one RPC round-trip). fee is in hundredths of a bip (same format
 * as Uniswap V3), e.g. 3000 = 0.3%. Stored as-is in PoolMeta.fee.
 */
export const fetchAlgebraPoolMeta = createEffect(
  {
    name: "fetchAlgebraPoolMeta",
    input: {
      pool: S.string,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      fee: S.bigint,
      tickSpacing: S.optional(S.number),
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  async ({ input, context }: {
    input: { pool: string; blockNumber?: bigint };
    context: { cache: boolean };
  }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const blockTag = input.blockNumber ? { blockNumber: input.blockNumber } as const : undefined;
      const [state, tickSpacing] = await Promise.all([
        publicClient.readContract({
          address: pool,
          abi: ALGEBRA_POOL_ABI,
          functionName: "globalState",
          ...blockTag,
        }),
        publicClient.readContract({
          address: pool,
          abi: ALGEBRA_POOL_ABI,
          functionName: "tickSpacing",
          ...blockTag,
        }),
      ]);
      // globalState returns [uint160, int24, uint16, uint8, uint16, bool]
      const fee = BigInt((state as readonly unknown[])[2] as number);
      const ts = (tickSpacing as number);
      return { fee, tickSpacing: ts };
    } catch (err: unknown) {
      const { isPermanent } = classifyRpcError(err);
      context.cache = isPermanent;
      return { fee: 0n };
    }
  },
);
