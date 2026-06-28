import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient, isQuotaError } from "./rpc_client";
import { getHistoricalMetaEffectRateLimit } from "../utils/pacing";

/** Fee fields only — reserves/i/k are unused by PoolMeta discovery handlers. */
const DODO_FEE_ABI = parseAbi([
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_() view returns (uint256)",
]);

/**
 * DODO V2 pool metadata. Indexer only needs LP/MT fee rates for PoolMeta.fee.
 * Uses single multicall for both reads.
 */
export const fetchDodoMetadata = createEffect(
  {
    name: "fetchDodoMetadata",
    input: {
      pool: S.string,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      fee: S.bigint,
      lpFeeRate: S.bigint,
      mtFeeRate: S.bigint,
    },
    rateLimit: getHistoricalMetaEffectRateLimit(),
    cache: true,
  },
  fetchDodoMetadataHandler,
);
export { fetchDodoMetadataHandler };

/** Both fee reads failed or reverted — do not cache for preload replay. */
export function isDodoMetadataEmpty(meta: { lpFeeRate: bigint; mtFeeRate: bigint }): boolean {
  return meta.lpFeeRate === 0n && meta.mtFeeRate === 0n;
}

/** Default PoolMeta.fee when block-pinned RPC metadata is unavailable. */
export const DEFAULT_DODO_FEE_BPS = 0;

/**
 * DODO LP/MT fee rates are 1e18 fractions (see dodo.ts mulFloor). PoolMeta.fee stores
 * combined LP+MT in basis points for routing weights; simulation still reads raw rates from RPC.
 */
export function dodoFeeToBps(totalFeeRate: bigint): number {
  if (totalFeeRate <= 0n) return DEFAULT_DODO_FEE_BPS;
  const bps = Number(totalFeeRate / 10n ** 14n);
  return bps > 0 ? Math.max(1, bps) : DEFAULT_DODO_FEE_BPS;
}

const EMPTY_DODO_RESULT = {
  fee: 0n,
  lpFeeRate: 0n,
  mtFeeRate: 0n,
};

const inFlightDodo = new Map<string, Promise<{
  fee: bigint;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
}>>();

async function readDodoFeeRates(
  address: `0x${string}`,
  blockNumber?: bigint,
): Promise<{ fee: bigint; lpFeeRate: bigint; mtFeeRate: bigint; anyFailed: boolean }> {
  const opts = blockNumber ? { blockNumber } : undefined;
  let results;
  try {
    results = await publicClient.multicall({
      contracts: [
        { address, abi: DODO_FEE_ABI, functionName: "_LP_FEE_RATE_" as const },
        { address, abi: DODO_FEE_ABI, functionName: "_MT_FEE_RATE_" as const },
      ],
      allowFailure: true,
      ...opts,
    });
  } catch {
    return { fee: 0n, lpFeeRate: 0n, mtFeeRate: 0n, anyFailed: true };
  }

  const lp = results[0]!.status === "success" ? BigInt(results[0]!.result as bigint) : 0n;
  const mt = results[1]!.status === "success" ? BigInt(results[1]!.result as bigint) : 0n;

  return {
    fee: lp + mt,
    lpFeeRate: lp,
    mtFeeRate: mt,
    anyFailed: results[0]!.status !== "success" || results[1]!.status !== "success",
  };
}

async function fetchDodoMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; blockNumber?: bigint };
  context: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
  const poolAddr = input.pool.toLowerCase();
  const blockKey = input.blockNumber != null ? String(input.blockNumber) : "";
  const key = `${poolAddr}-${blockKey}`;

  let promise = inFlightDodo.get(key);
  if (promise) {
    return promise;
  }

  promise = (async () => {
    try {
      const address = input.pool as `0x${string}`;
      let { anyFailed, ...result } = await readDodoFeeRates(address, input.blockNumber);

      // Creation-block reads often return empty (same-block deploy, archive gaps). Latest state is
      // sufficient for discovery PoolMeta.fee; the arb bot reads live rates via RPC anyway.
      if (isDodoMetadataEmpty(result) && input.blockNumber !== undefined) {
        const latest = await readDodoFeeRates(address);
        if (!isDodoMetadataEmpty(latest)) {
          anyFailed = latest.anyFailed;
          const { anyFailed: _, ...clean } = latest;
          result = clean;
          if (context.log) {
            context.log.info("DODO metadata: block-pinned read empty, used latest state", {
              pool: input.pool,
              blockNumber: String(input.blockNumber),
            });
          }
        }
      }

      if (isDodoMetadataEmpty(result)) {
        if (context.log) {
          context.log.warn("DODO metadata reads returned empty — not caching", { pool: input.pool });
        }
        context.cache = false;
      } else if (anyFailed) {
        if (context.log?.debug) {
          context.log.debug("DODO metadata read partially failed — not caching", { pool: input.pool });
        }
        context.cache = false;
      } else if (context.log) {
        context.log.info("Fetched DODO pool metadata", { pool: input.pool });
      }

      return result;
    } catch (err) {
      const errStr = String(err);

      if (context.log) {
        if (isQuotaError(err)) {
          context.log.warn(
            "RPC quota / monthly capacity exceeded while fetching DODO metadata. Add more RPC providers to POLYGON_RPC_URLS.",
          );
        } else {
          context.log.warn("Failed to fetch DODO metadata", {
            pool: input.pool,
            error: errStr,
          });
        }
      }
      context.cache = false;
      return { ...EMPTY_DODO_RESULT };
    } finally {
      inFlightDodo.delete(key);
    }
  })();

  inFlightDodo.set(key, promise);
  return promise;
}
