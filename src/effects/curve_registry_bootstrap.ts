import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { CURVE_REGISTRY_LEGACY, ZERO_ADDRESS } from "../utils/constants";
import { getHistoricalMetaEffectRateLimit } from "../utils/pacing";

const REGISTRY_ABI = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256) view returns (address)",
  "function get_n_coins(address) view returns (uint256)",
  "function get_coins(address) view returns (address[8])",
]);

export interface CurveRegistryPoolRow {
  address: string;
  coins: string[];
}

/** Paginated read of Curve legacy registry pool_list + get_coins. */
export async function fetchCurveRegistryPageHandler({
  input,
  context,
}: {
  input: { offset: number; limit: number; registryAddress?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}) {
  const offset = Math.max(0, input.offset);
  const limit = Math.min(Math.max(1, input.limit), 100);
  const registry = (input.registryAddress ?? CURVE_REGISTRY_LEGACY).toLowerCase() as `0x${string}`;
  const ZERO = ZERO_ADDRESS;

  let total: number;
  try {
    total = Number(await publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "pool_count",
    }));
  } catch (err) {
    if (context.log) {
      context.log.warn("fetchCurveRegistryPage: pool_count failed — retrying next stride", {
        offset,
        limit,
        registryAddress: registry,
        error: String(err),
      });
    }
    context.cache = false;
    return { total: 0, pools: [] };
  }

  const end = Math.min(total, offset + limit);
  const count = end - offset;
  if (count <= 0) return { total, pools: [] };

  // Round 1: multicall pool_list with allowFailure — one bad index doesn't kill the page.
  let addresses: string[];
  try {
    const poolListResults = await publicClient.multicall({
      contracts: Array.from({ length: count }, (_, j) => ({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "pool_list",
        args: [BigInt(offset + j)],
      })),
      allowFailure: true,
    });
    addresses = poolListResults
      .map((r, j) => {
        if (r.status === "success") return (r.result as string).toLowerCase();
        if (context.log) {
          context.log.warn("fetchCurveRegistryPage: pool_list failed", {
            index: offset + j,
            registry,
            error: String(r.error),
          });
        }
        return "";
      })
      .filter((a) => a !== "");
  } catch (err) {
    if (context.log) {
      context.log.warn("fetchCurveRegistryPage: pool_list multicall failed", {
        offset, limit, registry,
        error: String(err),
      });
    }
    context.cache = false;
    return { total: 0, pools: [] };
  }

  if (addresses.length === 0) {
    // All pool_list calls failed — retry next stride.
    context.cache = false;
    return { total, pools: [] };
  }

  // Round 2: multicall get_n_coins + get_coins with allowFailure.
  // 2 calls per pool, interleaved: [nCoins_0, coins_0, nCoins_1, coins_1, ...]
  const metaContracts = addresses.flatMap((addr) => [
    { address: registry, abi: REGISTRY_ABI, functionName: "get_n_coins", args: [addr as `0x${string}`] } as const,
    { address: registry, abi: REGISTRY_ABI, functionName: "get_coins", args: [addr as `0x${string}`] } as const,
  ]);

  let metaResults: { status: "success" | "failure"; result: unknown; error: unknown }[];
  try {
    metaResults = (await publicClient.multicall({
      contracts: metaContracts,
      allowFailure: true,
    })) as { status: "success" | "failure"; result: unknown; error: unknown }[];
  } catch (err) {
    if (context.log) {
      context.log.warn("fetchCurveRegistryPage: metadata multicall failed", {
        poolCount: addresses.length, registry,
        error: String(err),
      });
    }
    context.cache = false;
    return { total: 0, pools: [] };
  }

  const pools: CurveRegistryPoolRow[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]!;
    const nCoinsResult = metaResults[i * 2];
    const coinsResult = metaResults[i * 2 + 1];

    if (nCoinsResult?.status !== "success" || coinsResult?.status !== "success") {
      if (context.log) {
        context.log.warn("fetchCurveRegistryPage: metadata read failed — skipping pool", {
          pool: addr,
          nCoinsStatus: nCoinsResult?.status,
          coinsStatus: coinsResult?.status,
        });
      }
      continue;
    }

    const nCoins = Number(nCoinsResult.result as bigint);
    if (!Number.isFinite(nCoins) || nCoins < 2) continue;

    const coinArr = coinsResult.result as readonly string[];
    const coins = coinArr
      .slice(0, Math.min(nCoins, 8))
      .map((c) => c.toLowerCase())
      .filter((c) => c && c !== ZERO);
    if (coins.length >= 2) {
      pools.push({ address: addr, coins });
    }
  }

  return { total, pools };
}

export const fetchCurveRegistryPage = createEffect(
  {
    name: "fetchCurveRegistryPage",
    input: {
      offset: S.number,
      limit: S.number,
      registryAddress: S.optional(S.string),
    },
    output: {
      total: S.number,
      pools: S.array(
        S.schema({
          address: S.string,
          coins: S.array(S.string),
        }),
      ),
    },
    rateLimit: getHistoricalMetaEffectRateLimit(),
    cache: true,
  },
  fetchCurveRegistryPageHandler,
);
