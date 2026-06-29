import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { CURVE_REGISTRY_LEGACY, ZERO_ADDRESS } from "../utils/constants";

const REGISTRY_ABI = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256) view returns (address)",
  "function get_n_coins(address) view returns (uint256, uint256)",
  "function get_coins(address) view returns (address[8])",
]);

export interface CurveRegistryPoolRow {
  address: string;
  coins: string[];
}

/** Paginated read of Curve MetaRegistry pool_list + get_coins. */
export async function fetchCurveRegistryPageHandler({
  input,
  context,
}: {
  input: { offset: number; limit: number; registryAddress?: string };
  context: { cache: boolean };
}) {
  const offset = Math.max(0, input.offset);
  const limit = Math.min(Math.max(1, input.limit), 100);
  const registry = (input.registryAddress ? input.registryAddress.toLowerCase() : CURVE_REGISTRY_LEGACY) as `0x${string}`;

  let total: number;
  try {
    total = Number(await publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "pool_count",
    }));
  } catch (err) {
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
        if (r.status === "success") return String(r.result).toLowerCase();
        return "";
      })
      .filter((a) => a !== "");
  } catch (err) {
    context.cache = false;
    return { total, pools: [] };
  }

  if (addresses.length === 0) {
    // All pool_list calls failed — retry next stride.
    context.cache = false;
    return { total, pools: [] };
  }

  // Round 2: multicall get_n_coins + get_coins with allowFailure.
  // 2 calls per pool, interleaved: [nCoins_0, coins_0, nCoins_1, coins_1, ...]
    const metaContracts = addresses.flatMap((addr) => [
    { address: registry, abi: REGISTRY_ABI, functionName: "get_n_coins", args: [addr as `0x${string}`] },
    { address: registry, abi: REGISTRY_ABI, functionName: "get_coins", args: [addr as `0x${string}`] },
  ]);

  let metaResults: { status: "success" | "failure"; result: unknown; error: unknown }[];
  try {
    metaResults = (await publicClient.multicall({
      contracts: metaContracts,
      allowFailure: true,
    })) as { status: "success" | "failure"; result: unknown; error: unknown }[];
  } catch (err) {
    context.cache = false;
    return { total, pools: [] };
  }

  const pools: CurveRegistryPoolRow[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]!;
    const nCoinsResult = metaResults[i * 2];
    const coinsResult = metaResults[i * 2 + 1];

    if (nCoinsResult?.status !== "success" || coinsResult?.status !== "success") {
      continue;
    }

    const nCoins = Number((nCoinsResult.result as readonly bigint[])[0]);
    if (!Number.isFinite(nCoins) || nCoins < 2) continue;

    const coinArr = coinsResult.result as readonly string[];
    const coins = coinArr
      .slice(0, Math.min(nCoins, 8))
      .map((c) => c.toLowerCase())
      .filter((c) => c && c !== ZERO_ADDRESS);
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
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchCurveRegistryPageHandler,
);
