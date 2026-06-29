import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";

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
      anyFailed: S.boolean,
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchDodoMetadataHandler,
);
/**
 * DODO LP/MT fee rates are 1e18 fractions (see dodo.ts mulFloor). PoolMeta.fee stores
 * combined LP+MT in basis points for routing weights; simulation still reads raw rates from RPC.
 * Non-zero fees that truncate to <1 bps round up to 1 (e.g. 0.5 bps → 1).
 */
export function dodoFeeToBps(totalFeeRate: bigint): number {
  if (totalFeeRate <= 0n) return 0;
  const bps = Number(totalFeeRate / 10n ** 14n);
  return Math.max(1, bps);
}

const EMPTY_DODO_RESULT = {
  fee: 0n,
  lpFeeRate: 0n,
  mtFeeRate: 0n,
  anyFailed: true,
};

const inFlightDodo = new Map<string, Promise<{
  fee: bigint;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
  anyFailed: boolean;
}>>();

async function readDodoFeeRates(
  address: `0x${string}`,
  blockNumber?: bigint,
): Promise<{ fee: bigint; lpFeeRate: bigint; mtFeeRate: bigint; anyFailed: boolean }> {
  const opts = blockNumber != null ? { blockNumber } : undefined;
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
  context: { cache: boolean };
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
      let anyFailed = false;
      let fee = 0n;
      let lpFeeRate = 0n;
      let mtFeeRate = 0n;

      {
        const r = await readDodoFeeRates(address, input.blockNumber);
        anyFailed = r.anyFailed;
        fee = r.fee;
        lpFeeRate = r.lpFeeRate;
        mtFeeRate = r.mtFeeRate;
      }

      // Block-pinned reads may return empty at creation block — fall back to latest state.
      if (fee === 0n && input.blockNumber !== undefined) {
        const latest = await readDodoFeeRates(address);
        if (latest.fee !== 0n) {
          anyFailed = latest.anyFailed;
          fee = latest.fee;
          lpFeeRate = latest.lpFeeRate;
          mtFeeRate = latest.mtFeeRate;
        }
      }

      // ponytail: don't cache when metadata is incomplete/useless.
      // fee=0 or any partial read failure → handlers skip the pool. Caching
      // would cause an infinite retry loop.
      if (fee === 0n || anyFailed) {
        context.cache = false;
      }

      return { fee, lpFeeRate, mtFeeRate, anyFailed };
    } catch (err) {
      context.cache = false;
      return { ...EMPTY_DODO_RESULT };
    } finally {
      inFlightDodo.delete(key);
    }
  })();

  inFlightDodo.set(key, promise);
  return promise;
}
