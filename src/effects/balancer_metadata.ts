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

export type BalancerPoolType = "weighted" | "stable" | "linear";

export type BalancerMetadataResult = {
  poolId: string;
  balances: bigint[];
  tokens: string[];
  lastChangeBlock: bigint;
  swapFee: bigint;
  weights?: bigint[];
  amp?: bigint;
  scalingFactors?: bigint[];
  poolType?: BalancerPoolType;
  /** True when a type/fee probe failed for a transient RPC reason (retry later). */
  incompleteTransient?: boolean;
};

/**
 * Balancer pool metadata via batched RPC.
 * Tuned for paid archival providers (multiple reads per pool at historical blocks).
 *
 * Type probes treat permanent reverts (method not on this pool) as "not this type".
 * Transient RPC failures set incompleteTransient so callers can leave poolType unset
 * without caching a permanent wrong answer.
 */
const inFlightBalancer = new Map<string, Promise<BalancerMetadataResult>>();

type ProbeOk<T> = { status: "ok"; value: T };
type ProbeMiss = { status: "miss" }; // permanent: not this interface
type ProbeTransient = { status: "transient" };
type ProbeResult<T> = ProbeOk<T> | ProbeMiss | ProbeTransient;

async function probeOptional<T>(fn: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { status: "ok", value: await fn() };
  } catch (err) {
    const { isPermanent } = classifyRpcError(err);
    return isPermanent ? { status: "miss" } : { status: "transient" };
  }
}

export function classifyBalancerPoolType(input: {
  mainToken?: unknown;
  wrappedToken?: unknown;
  amp?: bigint;
  weights?: readonly bigint[];
}): BalancerPoolType | undefined {
  if (input.mainToken != null && input.wrappedToken != null) return "linear";
  if (input.amp != null && input.amp > 0n) return "stable";
  if (input.weights != null && input.weights.length > 0) return "weighted";
  return undefined;
}

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

  promise = (async (): Promise<BalancerMetadataResult> => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;

      let requiredReadFailed = false;
      let incompleteTransient = false;

      const readRequired = async <T>(fn: () => Promise<T>, onFail: T): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          requiredReadFailed = true;
          const { isPermanent } = classifyRpcError(err);
          if (!isPermanent) incompleteTransient = true;
          return onFail;
        }
      };

      let poolId: `0x${string}` | undefined = input.poolId as `0x${string}`;
      if (!poolId) {
        poolId = await readRequired(
          () =>
            publicClient.readContract({
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
        return {
          poolId: "",
          tokens: [],
          balances: [],
          lastChangeBlock: 0n,
          swapFee: 0n,
          incompleteTransient,
        };
      }

      const poolTokensResult = await readRequired(
        () =>
          publicClient.readContract({
            address: BALANCER_VAULT,
            abi: VAULT_ABI,
            functionName: "getPoolTokens",
            args: [poolId!],
            ...opts,
          }),
        undefined,
      );

      const [swapFeeProbe, weightsProbe, ampProbe, scalingProbe, mainProbe, wrappedProbe] =
        await Promise.all([
          readRequired(
            () =>
              publicClient.readContract({
                address: pool,
                abi: BALANCER_ABI,
                functionName: "getSwapFeePercentage",
                ...opts,
              }),
            0n,
          ).then((v) => v as bigint),
          probeOptional(() =>
            publicClient.readContract({
              address: pool,
              abi: BALANCER_ABI,
              functionName: "getNormalizedWeights",
              ...opts,
            }),
          ),
          probeOptional(() =>
            publicClient.readContract({
              address: pool,
              abi: BALANCER_ABI,
              functionName: "getAmplificationParameter",
              ...opts,
            }),
          ),
          probeOptional(() =>
            publicClient.readContract({
              address: pool,
              abi: BALANCER_ABI,
              functionName: "getScalingFactors",
              ...opts,
            }),
          ),
          probeOptional(() =>
            publicClient.readContract({
              address: pool,
              abi: BALANCER_ABI,
              functionName: "getMainToken",
              ...opts,
            }),
          ),
          probeOptional(() =>
            publicClient.readContract({
              address: pool,
              abi: BALANCER_ABI,
              functionName: "getWrappedToken",
              ...opts,
            }),
          ),
        ]);

      if (!poolTokensResult) {
        context.cache = false;
        return {
          poolId: poolId as string,
          tokens: [],
          balances: [],
          lastChangeBlock: 0n,
          swapFee: 0n,
          incompleteTransient,
        };
      }

      const [tokens, balances, lastChangeBlock] = poolTokensResult;

      for (const p of [weightsProbe, ampProbe, scalingProbe, mainProbe, wrappedProbe]) {
        if (p.status === "transient") incompleteTransient = true;
      }

      const weights = weightsProbe.status === "ok" ? (weightsProbe.value as bigint[]) : undefined;
      const ampResult = ampProbe.status === "ok" ? (ampProbe.value as [bigint, boolean, bigint]) : undefined;
      const amp = ampResult ? ampResult[0] : undefined;
      const scalingFactors =
        scalingProbe.status === "ok" ? (scalingProbe.value as bigint[]) : undefined;
      const mainToken = mainProbe.status === "ok" ? mainProbe.value : undefined;
      const wrappedToken = wrappedProbe.status === "ok" ? wrappedProbe.value : undefined;

      const poolType = classifyBalancerPoolType({
        mainToken,
        wrappedToken,
        amp,
        weights,
      });

      // Cache only complete, non-transient results. Transient incomplete → retry later.
      // Permanent unknown type (all probes miss, no type) is still cacheable so we don't
      // hammer RPCs on Gyro/custom pools.
      if (requiredReadFailed || incompleteTransient) {
        context.cache = false;
      }

      return {
        poolId: poolId as string,
        tokens: tokens.map((t) => t.toLowerCase()),
        balances: balances.map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock),
        swapFee: swapFeeProbe,
        weights,
        amp,
        scalingFactors,
        poolType,
        incompleteTransient,
      };
    } catch (err) {
      const { isPermanent } = classifyRpcError(err);
      context.cache = isPermanent;
      return {
        poolId: "",
        tokens: [],
        balances: [],
        lastChangeBlock: 0n,
        swapFee: 0n,
        incompleteTransient: !isPermanent,
      };
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
      incompleteTransient: S.optional(S.boolean),
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchBalancerMetadataHandler,
);
