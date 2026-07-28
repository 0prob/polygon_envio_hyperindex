import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";

const FACTORY_ABI = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);
const PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export async function fetchV2FactoryPageHandler({
  input,
  context,
}: {
  input: { factory: string; offset: number; limit: number };
  context: { cache: boolean };
}) {
  const factory = input.factory as `0x${string}`;
  const offset = Math.max(0, input.offset);
  const limit = Math.min(Math.max(1, input.limit), 100);
  try {
    const total = Number(await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "allPairsLength",
    }));
    const count = Math.min(limit, Math.max(0, total - offset));
    if (count === 0) return { total, pools: [] };
    const pairs = await publicClient.multicall({
      contracts: Array.from({ length: count }, (_, i) => ({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "allPairs" as const,
        args: [BigInt(offset + i)] as const,
      })),
      allowFailure: true,
    });
    const addresses = pairs.flatMap((result) =>
      result.status === "success" ? [result.result as `0x${string}`] : [],
    );
    const tokens = await publicClient.multicall({
      contracts: addresses.flatMap((address) => [
        { address, abi: PAIR_ABI, functionName: "token0" as const },
        { address, abi: PAIR_ABI, functionName: "token1" as const },
      ]),
      allowFailure: true,
    });
    const pools = addresses.flatMap((address, i) => {
      const token0 = tokens[i * 2];
      const token1 = tokens[i * 2 + 1];
      if (token0?.status !== "success" || token1?.status !== "success") return [];
      return [{
        address: address.toLowerCase(),
        token0: String(token0.result).toLowerCase(),
        token1: String(token1.result).toLowerCase(),
      }];
    });
    return { total, pools };
  } catch (error) {
    const { isPermanent } = classifyRpcError(error);
    context.cache = isPermanent;
    return { total: 0, pools: [] };
  }
}

export const fetchV2FactoryPage = createEffect(
  {
    name: "fetchV2FactoryPage",
    input: { factory: S.string, offset: S.number, limit: S.number },
    output: {
      total: S.number,
      pools: S.array(S.schema({ address: S.string, token0: S.string, token1: S.string })),
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: false,
  },
  fetchV2FactoryPageHandler,
);
