import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";

import { BALANCER_VAULT } from "../utils/constants";

const BALANCER_ABI = parseAbi([
  "function getPoolId() view returns (bytes32)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getNormalizedWeights() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() view returns (uint256[])",
  "function getMainToken() view returns (address)",
  "function getWrappedToken() view returns (address)",
]);

const VAULT_ABI = parseAbi(["function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)"]);

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
  poolType?: string;
}>>();

export async function fetchBalancerMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; poolId?: string; blockNumber?: bigint };
  context: { cache: boolean };
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

      let requiredReadFailed = false;
      const readRequired = async <T>(fn: () => Promise<T>, onFail: T): Promise<T> => {
        try { return await fn(); }
        catch { requiredReadFailed = true; return onFail; }
      };
      // Pool families expose different capability getters. A revert from one of
      // these probes means "not this pool type", not an RPC failure.
      const readOptional = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
        try { return await fn(); }
        catch { return undefined; }
      };

      let poolId: `0x${string}` | undefined = input.poolId as `0x${string}`;
      if (!poolId) {
        poolId = await readRequired(
          () => publicClient.readContract({
            address: pool,
            abi: BALANCER_ABI,
            functionName: "getPoolId",
            ...opts,
          }),
          undefined,
        );
      }

      if (!poolId) {
        context.cache = false;
        return { poolId: "", tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
      }

      const poolTokensResult = await readRequired(
        () => publicClient.readContract({
          address: BALANCER_VAULT,
          abi: VAULT_ABI,
          functionName: "getPoolTokens",
          args: [poolId!],
          ...opts,
        }),
        undefined,
      );

      const [swapFee, weights, ampResult, scalingFactors, mainToken, wrappedToken] = await Promise.all([
        readRequired(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getSwapFeePercentage", ...opts }),
          0n,
        ),
        readOptional(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getNormalizedWeights", ...opts }),
        ),
        readOptional(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getAmplificationParameter", ...opts }),
        ),
        readOptional(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getScalingFactors", ...opts }),
        ),
        readOptional(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getMainToken", ...opts }),
        ),
        readOptional(
          () => publicClient.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getWrappedToken", ...opts }),
        ),
      ]);

      if (!poolTokensResult) {
        context.cache = false;
        return { poolId: poolId as string, tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
      }

      const [tokens, balances, lastChangeBlock] = poolTokensResult;

      if (requiredReadFailed) {
        context.cache = false;
      }

      const poolType = mainToken && wrappedToken
        ? "linear"
        : ampResult && (ampResult as [bigint, boolean, bigint])[0] > 0n
          ? "stable"
          : weights?.length
            ? "weighted"
            : undefined;

      return {
        poolId: poolId as string,
        tokens: tokens.map((t) => t.toLowerCase()),
        balances: balances.map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock),
        swapFee: swapFee as bigint,
        weights: weights as bigint[] | undefined,
        amp: ampResult ? (ampResult as [bigint, boolean, bigint])[0] : undefined,
        scalingFactors: scalingFactors as bigint[] | undefined,
        poolType,
      };
    } catch (err) {
      const { isPermanent } = classifyRpcError(err);
      context.cache = isPermanent;
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
      poolType: S.optional(S.string),
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchBalancerMetadataHandler,
);
