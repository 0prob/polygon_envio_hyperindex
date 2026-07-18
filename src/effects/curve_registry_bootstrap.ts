import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";

const FACTORY_ABI = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256) view returns (address)",
]);

export interface CurveFactoryPoolRow {
  address: string;
}

/**
 * Paginated read of a single Curve factory's pool_list.
 * Each Curve factory (Twocrypto, Tricrypto, StableswapNG, Crypto) acts as its own registry.
 * We skip get_coins here — fetchCurveMetadata resolves coins directly from the pool contract.
 */
export async function fetchCurveFactoryPageHandler({
  input,
  context,
}: {
  input: { factory: string; offset: number; limit: number; epoch?: number };
  context: { cache: boolean };
}) {
  const factory = input.factory.toLowerCase() as `0x${string}`;
  const offset = Math.max(0, input.offset);
  const limit = Math.min(Math.max(1, input.limit), 100);
  // epoch busts Envio effect cache when re-probing after completed bootstrap
  void input.epoch;

  let total: number;
  try {
    total = Number(
      await publicClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "pool_count",
      }),
    );
  } catch (err) {
    const { isPermanent } = classifyRpcError(err);
    context.cache = isPermanent;
    return { total: 0, pools: [] };
  }

  const end = Math.min(total, offset + limit);
  const count = end - offset;
  if (count <= 0) return { total, pools: [] };

  try {
    const results = await publicClient.multicall({
      contracts: Array.from({ length: count }, (_, j) => ({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "pool_list" as const,
        args: [BigInt(offset + j)] as const,
      })),
      allowFailure: true,
    });

    const pools: CurveFactoryPoolRow[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "success" && r.result) {
        pools.push({ address: (r.result as string).toLowerCase() });
      }
    }

    return { total, pools };
  } catch (err) {
    const { isPermanent } = classifyRpcError(err);
    context.cache = isPermanent;
    return { total, pools: [] };
  }
}

export const fetchCurveFactoryPage = createEffect(
  {
    name: "fetchCurveFactoryPage",
    input: {
      factory: S.string,
      offset: S.number,
      limit: S.number,
      /** Optional cache-bust key (e.g. block number) for growth re-probes after completed. */
      epoch: S.optional(S.number),
    },
    output: {
      total: S.number,
      pools: S.array(
        S.schema({
          address: S.string,
        }),
      ),
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchCurveFactoryPageHandler,
);
