import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient, isQuotaError } from "./rpc_client";
import { BALANCER_VAULT } from "../utils/constants";
import { getHistoricalMetaEffectRateLimit } from "../utils/pacing";

const BALANCER_ABI = parseAbi([
  "function getPoolId() view returns (bytes32)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getNormalizedWeights() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() view returns (uint256[])",
]);

const VAULT_ABI = parseAbi(["function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)"]);

function isRetryableRpcError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("timeout") ||
    msg.includes("HTTP") ||
    msg.includes("fetch failed") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("429")
  );
}

/** One retry on transient network errors — getPoolTokens is required for token discovery. */
async function readVaultPoolTokens(
  poolId: `0x${string}`,
  opts: { blockNumber?: bigint } | undefined,
): Promise<[string[], bigint[], bigint] | undefined> {
  const call = () =>
    publicClient.readContract({
      address: BALANCER_VAULT,
      abi: VAULT_ABI,
      functionName: "getPoolTokens",
      args: [poolId],
      ...opts,
    }) as Promise<[string[], bigint[], bigint]>;

  try {
    return await call();
  } catch (err) {
    if (!isRetryableRpcError(err)) return undefined;
    try {
      return await call();
    } catch {
      return undefined;
    }
  }
}

/**
 * Balancer pool metadata via batched RPC.
 * Tuned for paid archival providers (multiple reads per pool at historical blocks).
 */
const inFlightBalancer = new Map<string, Promise<{
  poolId: string;
  balances: bigint[];
  tokens: string[];
  lastChangeBlock: bigint;
  swapFee: bigint;
  weights?: bigint[];
  amp?: bigint;
  scalingFactors?: bigint[];
}>>();

export async function fetchBalancerMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; poolId?: string; blockNumber?: bigint };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}) {
  const poolAddr = input.pool.toLowerCase();
  const blockKey = input.blockNumber != null ? String(input.blockNumber) : "";
  const key = `${poolAddr}-${blockKey}`;

  let promise = inFlightBalancer.get(key);
  if (promise) {
    return promise;
  }

  promise = (async () => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;

      const poolId =
        (input.poolId as `0x${string}`) ||
        ((await publicClient
          .readContract({
            address: pool,
            abi: BALANCER_ABI,
            functionName: "getPoolId",
            ...opts,
          })
          .catch(() => undefined)) as `0x${string}` | undefined);

      if (!poolId) {
        context.cache = false;
        return { poolId: "", tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
      }

      let anyReadFailed = false;
      const readSafe = async <T>(fn: () => Promise<T>, onFail: T): Promise<T> => {
        try { return await fn(); }
        catch { anyReadFailed = true; return onFail; }
      };

      const [poolTokensResult, swapFee, weights, ampResult, scalingFactors] = await Promise.all([
        readVaultPoolTokens(poolId, opts),
        readSafe(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getSwapFeePercentage", ...opts }),
          0n,
        ),
        readSafe(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getNormalizedWeights", ...opts }),
          undefined,
        ),
        readSafe(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getAmplificationParameter", ...opts }),
          undefined,
        ),
        readSafe(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getScalingFactors", ...opts }),
          undefined,
        ),
      ]);

      if (!poolTokensResult) {
        if (context.log) {
          context.log.warn("Failed to fetch Balancer vault pool tokens — skipping pool metadata", {
            pool: input.pool,
            poolId,
          });
        }
        context.cache = false;
        return { poolId: poolId as string, tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
      }

      const [tokens, balances, lastChangeBlock] = poolTokensResult;

      if (anyReadFailed) {
        if (context.log?.debug) {
          context.log.debug("Balancer metadata reads partially failed — not caching", { pool: input.pool, poolId });
        }
        context.cache = false;
      } else {
        context.log?.info?.("Fetched Balancer pool metadata", { pool: input.pool });
      }

      return {
        poolId: poolId as string,
        tokens: tokens.map((t) => t.toLowerCase()),
        balances: balances.map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock),
        swapFee: BigInt(swapFee as bigint),
        weights: weights as bigint[] | undefined,
        amp: ampResult ? (ampResult as [bigint, boolean, bigint])[0] : undefined,
        scalingFactors: scalingFactors as bigint[] | undefined,
      };
    } catch (err) {
      const errStr = String(err);

      if (context.log) {
        if (isQuotaError(err)) {
          context.log.warn(
            `RPC quota / monthly capacity exceeded while fetching Balancer metadata. ` +
              `Add more providers to POLYGON_RPC_URLS or reduce effect rateLimits.`,
          );
        } else {
          context.log.warn("Failed to fetch Balancer metadata", {
            pool: input.pool,
            error: errStr,
          });
        }
      }
      context.cache = false;
      return { poolId: "", tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
    } finally {
      inFlightBalancer.delete(key);
    }
  })();

  inFlightBalancer.set(key, promise);
  return promise;
}

export const fetchBalancerMetadata = createEffect(
  {
    name: "fetchBalancerMetadata",
    input: {
      pool: S.string,
      poolId: S.optional(S.string),
      blockNumber: S.optional(S.bigint),
    },
    output: {
      poolId: S.string,
      balances: S.array(S.bigint),
      tokens: S.array(S.string),
      lastChangeBlock: S.bigint,
      swapFee: S.bigint,
      weights: S.optional(S.array(S.bigint)),
      amp: S.optional(S.bigint),
      scalingFactors: S.optional(S.array(S.bigint)),
    },
    rateLimit: getHistoricalMetaEffectRateLimit(),
    cache: true,
  },
  fetchBalancerMetadataHandler,
);
