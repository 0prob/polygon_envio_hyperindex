import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { MAJOR_TOKENS } from "../utils/constants";
import { getHistoricalMetaEffectRateLimit } from "../utils/pacing";

const WOOFI_ABI = parseAbi([
  "function quoteToken() external view returns (address)",
  "function tokenInfos(address token) external view returns (uint192 reserve, uint16 feeRate)",
]);
// Keep in sync with src/core/abis/woofi_pool.ts WOOFI_POOL_STATE_ABI (quoteToken + tokenInfos).

const inFlightWooFi = new Map<string, Promise<{ quoteToken: string; activeTokens: string[] }>>();

/**
 * Bootstraps the WOOFi token list by:
 *   1. Calling quoteToken() to learn which token is the stable side.
 *   2. Probing tokenInfos(t) for every major token — returns (0, 0) for unsupported
 *      tokens without reverting, so this is safe to run for all candidates.
 *   3. Returning the subset that has reserve > 0.
 *
 * WOOFi V2 exposes no factory event and no token enumeration function, so this is the
 * only way to get the full active token set without waiting for WooSwap events.
 * Uses single multicall for all reads.
 */
export async function fetchWooFiTokensHandler({
  input,
  context,
}: {
  input: { pool: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}) {
  const poolAddr = input.pool.toLowerCase();
  const EMPTY = { quoteToken: "", activeTokens: [] as string[] };

  let promise = inFlightWooFi.get(poolAddr);
  if (promise) return promise;

  promise = (async () => {
    try {
      const tokenList = [...MAJOR_TOKENS];
      const contracts = [
        { address: poolAddr as `0x${string}`, abi: WOOFI_ABI, functionName: "quoteToken" as const },
        ...tokenList.map((t) => ({
          address: poolAddr as `0x${string}`,
          abi: WOOFI_ABI,
          functionName: "tokenInfos" as const,
          args: [t as `0x${string}`] as const,
        })),
      ];

      const results = await publicClient.multicall({ contracts, allowFailure: true });

      const quoteResult = results[0]!;
      if (quoteResult.status !== "success") {
        context.cache = false;
        return EMPTY;
      }
      const quoteToken = (quoteResult.result as string).toLowerCase();

      const activeTokens: string[] = [quoteToken];
      for (let i = 0; i < tokenList.length; i++) {
        const r = results[1 + i]!;
        if (r.status !== "success") continue;
        const rVal = r.result as { reserve: bigint; feeRate: number } | [bigint, number];
        const reserve = Array.isArray(rVal) ? rVal[0] : rVal.reserve;
        const addr = tokenList[i]!.toLowerCase();
        if (reserve > 0n && !activeTokens.includes(addr)) {
          activeTokens.push(addr);
        }
      }

      if (activeTokens.length < 2) {
        if (context.log) {
          context.log.warn("fetchWooFiTokens: no active base tokens found — pool may be empty", {
            pool: input.pool,
            quoteToken,
          });
        }
        context.cache = false;
        return EMPTY;
      }

      return { quoteToken, activeTokens };
    } catch (err) {
      if (context.log) {
        context.log.warn("fetchWooFiTokens failed", { pool: input.pool, error: String(err) });
      }
      context.cache = false;
      return EMPTY;
    } finally {
      inFlightWooFi.delete(poolAddr);
    }
  })();

  inFlightWooFi.set(poolAddr, promise);
  return promise;
}

export const fetchWooFiTokens = createEffect(
  {
    name: "fetchWooFiTokens",
    input: { pool: S.string },
    output: {
      quoteToken: S.string,
      activeTokens: S.array(S.string),
    },
    rateLimit: getHistoricalMetaEffectRateLimit(),
    cache: true,
  },
  fetchWooFiTokensHandler,
);
