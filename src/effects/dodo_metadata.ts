import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { getHistoricalMetaEffectRateLimit } from "../utils/pacing";

/** Fee fields only — reserves/i/k are unused by PoolMeta discovery handlers. */
const DODO_FEE_ABI = parseAbi([
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_() view returns (uint256)",
]);

/**
 * DODO V2 pool metadata. Indexer only needs LP/MT fee rates for PoolMeta.fee.
 * Two parallel reads (LP + MT fee rate) per pool at the creation block; viem
 * auto-batches them into a multicall when the chain/block supports it.
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
export const DEFAULT_DODO_FEE_BPS = 10;

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

function readFeeBigint(
  result: { status: "success"; result: unknown } | { status: "failure"; error: Error },
): bigint {
  if (result.status !== "success") return 0n;
  return BigInt(result.result as bigint | number | string);
}

const inFlightDodo = new Map<string, Promise<{
  fee: bigint;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
}>>();

async function fetchDodoMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; blockNumber?: bigint };
  context: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
  const poolAddr = input.pool.toLowerCase();
  const blockKey = input.blockNumber ? String(input.blockNumber) : "";
  const key = `${poolAddr}-${blockKey}`;

  let promise = inFlightDodo.get(key);
  if (promise) {
    return promise;
  }

  promise = (async () => {
    try {
      const address = input.pool as `0x${string}`;
      const blockNumber = input.blockNumber;

      const blockOpts = blockNumber ? { blockNumber } : {};
      const settle = (p: Promise<unknown>) =>
        p
          .then((result) => ({ status: "success" as const, result }))
          .catch((error: unknown) => ({ status: "failure" as const, error: error as Error }));

      const [lpResult, mtResult] = await Promise.all([
        settle(
          publicClient.readContract({
            address,
            abi: DODO_FEE_ABI,
            functionName: "_LP_FEE_RATE_",
            ...blockOpts,
          }),
        ),
        settle(
          publicClient.readContract({
            address,
            abi: DODO_FEE_ABI,
            functionName: "_MT_FEE_RATE_",
            ...blockOpts,
          }),
        ),
      ]);

      const lp = readFeeBigint(lpResult);
      const mt = readFeeBigint(mtResult);

      const result = {
        ...EMPTY_DODO_RESULT,
        fee: lp + mt,
        lpFeeRate: lp,
        mtFeeRate: mt,
      };

      if (isDodoMetadataEmpty(result)) {
        if (context.log) {
          context.log.warn("DODO metadata reads returned empty — not caching", { pool: input.pool });
        }
        context.cache = false;
      } else if (context.log) {
        context.log.info("Fetched DODO pool metadata", { pool: input.pool });
      }

      return result;
    } catch (err) {
      const errStr = String(err);
      const isQuota =
        errStr.includes("Monthly") ||
        errStr.includes("capacity") ||
        errStr.includes("quota") ||
        errStr.includes("rate");

      if (context.log) {
        if (isQuota) {
          context.log.warn(
            "Alchemy quota / monthly capacity exceeded while fetching DODO metadata. Add more RPC providers to POLYGON_RPC_URLS.",
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
