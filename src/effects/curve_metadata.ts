import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";

import { ZERO_ADDRESS } from "../utils/constants";

/** Discovery-only reads — PoolMeta needs coins, fee, crypto vs stable (gamma), and NG subtype. */
const CURVE_DISCOVERY_ABI = parseAbi([
  "function fee() view returns (uint256)",
  // Crypto pools (esp. older twocrypto/tricrypto) often lack fee() but expose mid_fee.
  "function mid_fee() view returns (uint256)",
  "function gamma() view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function version() view returns (string)",
  "function N_COINS() view returns (uint256)",
]);

const MAX_CURVE_COINS = 8;

export type CurveDiscoveryPoolType = "stable" | "crypto" | "stable_ng" | "crypto_ng";

export const EMPTY_CURVE_RESULT = {
  fee: 0n,
  coins: [] as string[],
  poolType: "stable" as const satisfies CurveDiscoveryPoolType,
  failureReason: undefined as string | undefined,
};

/** Both fee + all coin reads failed — do not cache for preload replay. */
export function isCurveMetadataEmpty(meta: { fee: bigint; coins: string[] }): boolean {
  return meta.fee === 0n && meta.coins.length === 0;
}

// ponytail: inlined curveFeeToBps into curveFeeToPoolMetaInt (was only caller)
/**
 * Curve on-chain fee is 1e-10 fraction; convert to basis points for PoolMeta.fee.
 * Round to Int; sub-bps → 1.
 */
export function curveFeeToPoolMetaInt(fee: bigint): number {
  if (fee <= 0n) return 0;
  const bps = Number(fee) / 1_000_000;
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return bps < 1 ? 1 : Math.round(bps);
}

function curvePoolTypeFromGamma(gamma: bigint | null): "stable" | "crypto" {
  return gamma != null && gamma > 0n ? "crypto" : "stable";
}

/** Classify legacy vs NG Curve pools from discovery probes. */
export function curveDiscoveryPoolType(gamma: bigint | null, isNg: boolean): CurveDiscoveryPoolType {
  const base = curvePoolTypeFromGamma(gamma);
  if (!isNg) return base;
  return base === "crypto" ? "crypto_ng" : "stable_ng";
}

/** Resolve coin count from on-chain N_COINS(), event hint, or full probe window. */
export function resolveCurveNCoins(eventNCoins: number, onChainNCoins: bigint | null): number {
  const fromChain = onChainNCoins != null && onChainNCoins >= 2n ? Number(onChainNCoins) : 0;
  if (fromChain > 0) return Math.min(fromChain, MAX_CURVE_COINS);
  const fromEvent = Number.isFinite(eventNCoins) && eventNCoins >= 2 ? Math.floor(eventNCoins) : 0;
  // Many crypto pools revert N_COINS(). If the caller only has the default hint (2),
  // probe the full window so tricrypto (3) is not truncated; empty slots stop the loop.
  if (fromEvent > 2) return Math.min(fromEvent, MAX_CURVE_COINS);
  return MAX_CURVE_COINS;
}

/**
 * Prefer fee() when present; fall back to mid_fee for crypto pools where fee() reverts.
 * Both use Curve's 1e-10 fee fraction encoding.
 */
export function resolveCurveDiscoveryFee(fee: bigint | null, midFee: bigint | null): bigint {
  if (fee != null && fee > 0n) return fee;
  if (midFee != null && midFee > 0n) return midFee;
  return 0n;
}

/** TwocryptoFactory._pack_3([mid_fee, out_fee, fee_gamma]) → mid_fee in bits [128..192). */
export function midFeeFromPackedFeeParams(packed: bigint): bigint {
  return (packed >> 128n) & ((1n << 64n) - 1n);
}

function asBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.length > 0) {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fee (1e-10 units) embedded in Curve factory deploy events — avoids eth_call when
 * archival RPC is unavailable. Prefer explicit fee/mid_fee; unpack packed_fee_params.
 */
export function feeFromCurveDeployEventParams(params: Record<string, unknown>): bigint {
  const direct = resolveCurveDiscoveryFee(asBigInt(params.fee), asBigInt(params.mid_fee));
  if (direct > 0n) return direct;
  const packed = asBigInt(params.packed_fee_params);
  if (packed == null || packed <= 0n) return 0n;
  return midFeeFromPackedFeeParams(packed);
}

/** Best-effort poolType from deploy event fields (no RPC). */
export function poolTypeFromCurveDeployEventParams(
  params: Record<string, unknown>,
): CurveDiscoveryPoolType {
  const gamma = asBigInt(params.gamma) ?? asBigInt(params.packed_A_gamma);
  const hasPacked = asBigInt(params.packed_fee_params) != null;
  const hasMid = asBigInt(params.mid_fee) != null;
  const isCrypto = (gamma != null && gamma > 0n) || hasPacked || hasMid;
  // NG factories emit packed_* / Twocrypto|Tricrypto|PlainPool; legacy crypto has mid_fee only.
  const isNg = hasPacked || params.pool != null;
  if (!isCrypto) return isNg ? "stable_ng" : "stable";
  return isNg ? "crypto_ng" : "crypto";
}

const inFlightCurve = new Map<
  string,
  Promise<{
    fee: bigint;
    coins: string[];
    poolType: CurveDiscoveryPoolType;
  }>
>();

function normalizeKnownCoins(coins: string[] | undefined): string[] {
  if (!coins?.length) return [];
  return coins
    .map((c) => c.toLowerCase())
    .filter((c) => c && c !== ZERO_ADDRESS);
}

/** True when a persisted Curve PoolMeta row should be re-probed/rewritten. */
export function curvePoolMetaNeedsEnrich(e: {
  fee?: number | null;
  tokens?: readonly string[] | null;
} | undefined): boolean {
  if (!e) return true;
  if (e.fee == null || e.fee === 0) return true;
  if (!e.tokens || e.tokens.length < 2) return true;
  return false;
}

export async function fetchCurveMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; nCoins: number; blockNumber?: bigint; knownCoins?: string[] };
  context: { cache: boolean };
}) {
  const poolAddr = input.pool.toLowerCase();
  const blockKey = input.blockNumber != null ? String(input.blockNumber) : "";
  const knownCoins = normalizeKnownCoins(input.knownCoins);
  const key = `${poolAddr}-${blockKey}-${input.nCoins}-${knownCoins.join(",")}`;

  let promise = inFlightCurve.get(key);
  if (promise) {
    return promise;
  }

  promise = (async () => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber != null ? { blockNumber: input.blockNumber } : undefined;

      const skipCoinProbes = knownCoins.length >= 2;
      const contracts = [
        { address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "fee" as const },
        { address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "mid_fee" as const },
        { address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "gamma" as const },
        { address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "version" as const },
        ...(skipCoinProbes
          ? []
          : [
              { address: pool, abi: CURVE_DISCOVERY_ABI, functionName: "N_COINS" as const },
              ...Array.from({ length: MAX_CURVE_COINS }, (_, i) => ({
                address: pool,
                abi: CURVE_DISCOVERY_ABI,
                functionName: "coins" as const,
                args: [BigInt(i)] as const,
              })),
            ]),
      ];

      let results;
      try {
        results = await publicClient.multicall({ contracts, allowFailure: true, ...opts });
      } catch (err) {
        // Multicall itself failed (network, rate-limit, etc.)
        const { reason, isPermanent } = classifyRpcError(err);
        context.cache = isPermanent;
        return { ...EMPTY_CURVE_RESULT, failureReason: reason };
      }

      const feeResult = results[0]!;
      const midFeeResult = results[1]!;
      const gammaResult = results[2]!;
      const versionResult = results[3]!;
      const nCoinsResult = skipCoinProbes ? null : results[4]!;
      const coinRawResults = skipCoinProbes ? [] : results.slice(5, 5 + MAX_CURVE_COINS);

      // Classify per-call failures for actionable error reasons
      const failures: string[] = [];
      if (feeResult.status !== "success" && midFeeResult.status !== "success") {
        const { reason } = classifyRpcError(
          feeResult.error ?? midFeeResult.error ?? new Error("fee()/mid_fee() call failed"),
        );
        failures.push(`fee()/mid_fee(): ${reason}`);
      }
      if (!skipCoinProbes && nCoinsResult?.status !== "success") {
        const { reason } = classifyRpcError(nCoinsResult?.error ?? new Error("N_COINS() call failed"));
        failures.push(`N_COINS(): ${reason}`);
      }

      const feeRaw = feeResult.status === "success" ? (feeResult.result as bigint) : null;
      const midFeeRaw = midFeeResult.status === "success" ? (midFeeResult.result as bigint) : null;
      const fee = resolveCurveDiscoveryFee(feeRaw, midFeeRaw);
      const gamma = gammaResult.status === "success" ? (gammaResult.result as bigint) : null;
      const version = versionResult.status === "success" ? (versionResult.result as string) : null;
      const nCoinsOnChain =
        !skipCoinProbes && nCoinsResult?.status === "success"
          ? (nCoinsResult.result as bigint)
          : null;

      const nCoins = skipCoinProbes
        ? Math.min(Math.max(knownCoins.length, input.nCoins, 2), MAX_CURVE_COINS)
        : resolveCurveNCoins(input.nCoins, nCoinsOnChain);
      let anyCoinFailed = false;
      const coins: string[] = skipCoinProbes ? knownCoins.slice(0, nCoins) : [];
      if (!skipCoinProbes) {
        for (let i = 0; i < nCoins && i < coinRawResults.length; i++) {
          const r = coinRawResults[i]!;
          if (r.status === "success") {
            const addr = (r.result as string).toLowerCase();
            if (addr && addr !== ZERO_ADDRESS) coins.push(addr);
            else break; // contiguous coin slots; stop at first empty
          } else {
            // Trailing reverts after ≥2 coins are expected when N_COINS is unknown.
            if (coins.length < 2) {
              anyCoinFailed = true;
              const { reason } = classifyRpcError(r.error ?? new Error(`coins(${i}) call failed`));
              failures.push(`coins(${i}): ${reason}`);
            }
            break;
          }
        }
      }

      const isNg = typeof version === "string" && version.length > 0;
      const poolType = curveDiscoveryPoolType(gamma, isNg);

      const isIncomplete = fee === 0n || coins.length < 2;
      const failureReason = failures.length > 0 ? failures.join(" | ") : undefined;

      // Permanent failures (reverted, zero-data, malformed input) → cache so
      // the bootstrap doesn't retry them forever. Transient failures (network,
      // rate-limit) → don't cache, so they get retried next stride.
      if (isIncomplete || anyCoinFailed) {
        const allPermanent = failures.every((f) =>
          f.includes("ZERO_DATA") || f.includes("REVERTED") || f.includes("MALFORMED_INPUT"),
        );
        context.cache = allPermanent && failures.length > 0;
      }

      return { fee, coins, poolType, failureReason };
    } catch (err) {
      const { reason, isPermanent } = classifyRpcError(err);
      context.cache = isPermanent;
      return { ...EMPTY_CURVE_RESULT, failureReason: reason };
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
      knownCoins: S.optional(S.array(S.string)),
    },
    output: {
      fee: S.bigint,
      coins: S.array(S.string),
      poolType: S.string,
      failureReason: S.optional(S.string),
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchCurveMetadataHandler,
);
