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

  try {
    const total = Number(await publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "pool_count",
    }));

    const end = Math.min(total, offset + limit);
    const count = end - offset;
    if (count <= 0) return { total, pools: [] };

    // Round 1: fetch all pool addresses in this page concurrently.
    // viem batches these into a single multicall window (~16 ms).
    const addresses = (await Promise.all(
      Array.from({ length: count }, (_, j) =>
        publicClient.readContract({
          address: registry,
          abi: REGISTRY_ABI,
          functionName: "pool_list",
          args: [BigInt(offset + j)],
        }),
      ),
    )) as string[];

    // Round 2: for each pool, fetch get_n_coins + get_coins in parallel.
    // All calls across the page fire concurrently so viem batches them together.
    const poolData = await Promise.all(
      addresses.map(async (poolAddress) => {
        const addr = poolAddress as `0x${string}`;
        const [nCoinsRaw, coinArrRaw] = await Promise.all([
          publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "get_n_coins", args: [addr] }),
          publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "get_coins", args: [addr] }),
        ]);
        return { address: poolAddress, nCoins: Number(nCoinsRaw), coinArr: coinArrRaw as readonly string[] };
      }),
    );

    const pools: CurveRegistryPoolRow[] = [];
    for (const { address, nCoins, coinArr } of poolData) {
      const coinCount = Number(nCoins);
      if (!Number.isFinite(coinCount) || coinCount < 2) continue;
      const coins = coinArr
        .slice(0, coinCount)
        .map((c) => c.toLowerCase())
        .filter((c) => c && c !== ZERO);
      if (coins.length >= 2) {
        pools.push({ address: address.toLowerCase(), coins });
      }
    }

    return { total, pools };
  } catch (err) {
    if (context.log) {
      context.log.warn("fetchCurveRegistryPage failed", {
        offset,
        limit,
        registryAddress: registry,
        error: String(err),
      });
    }
    context.cache = false;
    return { total: 0, pools: [] };
  }
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
