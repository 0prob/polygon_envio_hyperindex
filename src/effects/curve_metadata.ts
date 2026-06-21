import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { getCurveMetaEffectRateLimit } from "../utils/pacing";

/** Discovery-only reads — PoolMeta needs coins, fee, crypto vs stable (gamma), and NG subtype. */
const CURVE_DISCOVERY_ABI = parseAbi([
  "function fee() view returns (uint256)",
  "function gamma() view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function version() view returns (string)",
  "function N_COINS() view returns (uint256)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_CURVE_COINS = 8;

export type CurveDiscoveryPoolType = "stable" | "crypto" | "stable_ng" | "crypto_ng";

export const EMPTY_CURVE_RESULT = {
  fee: 0n,
  coins: [] as string[],
  poolType: "stable" as const satisfies CurveDiscoveryPoolType,
};

/** Both fee + all coin reads failed — do not cache for preload replay. */
export function isCurveMetadataEmpty(meta: { fee: bigint; coins: string[] }): boolean {
  return meta.fee === 0n && meta.coins.length === 0;
}

/** Curve on-chain fee is 1e-10 fraction; convert to basis points for PoolMeta.fee. */
export function curveFeeToBps(fee: bigint): number {
  if (fee <= 0n) return 4;
  const bps = Number(fee / 1_000_000n);
  return bps > 0 ? bps : 4;
}

export function curvePoolTypeFromGamma(gamma: bigint | null): "stable" | "crypto" {
  return gamma != null && gamma > 0n ? "crypto" : "stable";
}

/** Classify legacy vs NG Curve pools from discovery probes. */
export function curveDiscoveryPoolType(gamma: bigint | null, isNg: boolean): CurveDiscoveryPoolType {
  const base = curvePoolTypeFromGamma(gamma);
  if (!isNg) return base;
  return base === "crypto" ? "crypto_ng" : "stable_ng";
}

/** Resolve coin count from MetaRegistry event hint or on-chain N_COINS(). */
export function resolveCurveNCoins(eventNCoins: number, onChainNCoins: bigint | null): number {
  const fromEvent = Number.isFinite(eventNCoins) && eventNCoins >= 2 ? Math.floor(eventNCoins) : 0;
  const fromChain = onChainNCoins != null && onChainNCoins >= 2n ? Number(onChainNCoins) : 0;
  const n = Math.max(fromEvent, fromChain, 2);
  return Math.min(n, MAX_CURVE_COINS);
}

const inFlightCurve = new Map<
  string,
  Promise<{
    fee: bigint;
    coins: string[];
    poolType: CurveDiscoveryPoolType;
  }>
>();

export async function fetchCurveMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; nCoins: number; blockNumber?: bigint };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}) {
  const poolAddr = input.pool.toLowerCase();
  const blockKey = input.blockNumber ? String(input.blockNumber) : "";
  const key = `${poolAddr}-${blockKey}-${input.nCoins}`;

  let promise = inFlightCurve.get(key);
  if (promise) {
    return promise;
  }

  promise = (async () => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;

      const [fee, gamma, version, nCoinsOnChain] = await Promise.all([
        publicClient.readContract({ address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "fee", ...opts }).catch(() => 0n),
        publicClient.readContract({ address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "gamma", ...opts }).catch(() => null),
        publicClient
          .readContract({ address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "version", ...opts })
          .catch(() => null),
        publicClient
          .readContract({ address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "N_COINS", ...opts })
          .catch(() => null),
      ]);

      const nCoins = resolveCurveNCoins(input.nCoins, nCoinsOnChain as bigint | null);
      const coinResults = await Promise.all(
        Array.from({ length: nCoins }, (_, i) =>
          publicClient
            .readContract({
              address: pool,
              abi: CURVE_DISCOVERY_ABI,
              functionName: "coins",
              args: [BigInt(i)],
              ...opts,
            })
            .catch(() => ZERO_ADDRESS),
        ),
      );

      const coins = coinResults
        .map((c) => (c as string).toLowerCase())
        .filter((c) => c && c !== ZERO_ADDRESS);

      const isNg = typeof version === "string" && version.length > 0;
      const poolType = curveDiscoveryPoolType(gamma as bigint | null, isNg);
      const result = { fee: fee as bigint, coins, poolType };

      if (isCurveMetadataEmpty(result)) {
        if (context.log) {
          context.log.warn("Curve metadata reads returned empty — not caching", { pool: input.pool });
        }
        context.cache = false;
      } else if (context.log) {
        context.log.info("Fetched Curve pool metadata", { pool: input.pool, nCoins, poolType });
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
            "Alchemy quota / monthly capacity exceeded while fetching Curve metadata. Add more RPC providers to POLYGON_RPC_URLS.",
          );
        } else {
          context.log.warn("Failed to fetch Curve metadata", {
            pool: input.pool,
            error: errStr,
          });
        }
      }
      context.cache = false;
      return { ...EMPTY_CURVE_RESULT };
    } finally {
      inFlightCurve.delete(key);
    }
  })();

  inFlightCurve.set(key, promise);
  return promise;
}

export const fetchCurveMetadata = createEffect(
  {
    name: "fetchCurveMetadata",
    input: {
      pool: S.string,
      nCoins: S.number,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      fee: S.bigint,
      coins: S.array(S.string),
      poolType: S.string,
    },
    rateLimit: getCurveMetaEffectRateLimit(),
    cache: true,
  },
  fetchCurveMetadataHandler,
);
