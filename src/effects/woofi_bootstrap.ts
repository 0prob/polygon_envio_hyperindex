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

/**
 * Bootstraps the WOOFi token list by:
 *   1. Calling quoteToken() to learn which token is the stable side.
 *   2. Probing tokenInfos(t) for every major token — returns (0, 0) for unsupported
 *      tokens without reverting, so this is safe to run for all candidates.
 *   3. Returning the subset that has reserve > 0.
 *
 * WOOFi V2 exposes no factory event and no token enumeration function, so this is the
 * only way to get the full active token set without waiting for WooSwap events.
 * viem multicall batches the N + 1 reads into a single eth_call.
 */
export async function fetchWooFiTokensHandler({
  input,
  context,
}: {
  input: { pool: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}) {
  const poolAddr = input.pool as `0x${string}`;
  const EMPTY = { quoteToken: "", activeTokens: [] as string[] };

  try {
    const rawQuote = (await publicClient.readContract({
      address: poolAddr,
      abi: WOOFI_ABI,
      functionName: "quoteToken",
    })) as string;
    const quoteToken = rawQuote.toLowerCase();

    const candidates = [...MAJOR_TOKENS];

    // Fire all tokenInfos reads concurrently; viem multicall bundles them.
    // Unsupported tokens silently return (0, 0) — no revert risk.
    const settled = await Promise.allSettled(
      candidates.map((t) =>
        publicClient.readContract({
          address: poolAddr,
          abi: WOOFI_ABI,
          functionName: "tokenInfos",
          args: [t as `0x${string}`],
        }),
      ),
    );

    // quoteToken is always included regardless of reserve (it may be probed separately).
    const activeTokens: string[] = [quoteToken];

    for (let i = 0; i < candidates.length; i++) {
      const r = settled[i];
      if (r.status !== "fulfilled") continue;
      const rVal = r.value as { reserve: bigint; feeRate: number } | [bigint, number];
      const reserve = Array.isArray(rVal) ? rVal[0] : rVal.reserve;
      const addr = candidates[i]!.toLowerCase();
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
  }
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
