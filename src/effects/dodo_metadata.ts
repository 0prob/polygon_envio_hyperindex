import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";
import { ZERO_ADDRESS } from "../utils/constants";

const DODO_FEE_ABI = parseAbi([
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_MODEL_() view returns (address)",
]);

const FEE_MODEL_ABI = parseAbi([
  "function getFeeRate(address) view returns (uint256)",
]);

export const fetchDodoMetadata = createEffect(
  {
    name: "fetchDodoMetadata",
    input: {
      pool: S.string,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      fee: S.bigint,
      anyFailed: S.boolean,
    },
    rateLimit: { calls: 60, per: "second" as const },
    cache: true,
  },
  fetchDodoMetadataHandler,
);

export function dodoFeeToBps(totalFeeRate: bigint): number {
  if (totalFeeRate <= 0n) return 0;
  const bps = Number(totalFeeRate / 10n ** 14n);
  return Math.max(1, bps);
}



const inFlightDodo = new Map<string, Promise<{ fee: bigint; anyFailed: boolean }>>();

async function readDodoFeeRates(
  address: `0x${string}`,
  blockNumber?: bigint,
): Promise<{ fee: bigint; anyFailed: boolean }> {
  const opts = blockNumber != null ? { blockNumber } : undefined;
  let results;
  try {
    results = await publicClient.multicall({
      contracts: [
        { address, abi: DODO_FEE_ABI, functionName: "_LP_FEE_RATE_" as const },
        { address, abi: DODO_FEE_ABI, functionName: "_MT_FEE_RATE_MODEL_" as const },
      ],
      allowFailure: true,
      ...opts,
    });
  } catch {
    return { fee: 0n, anyFailed: true };
  }

  const lp = results[0]!.status === "success" ? BigInt(results[0]!.result as bigint) : 0n;
  let mt = 0n;
  let mtFailed = results[1]!.status !== "success";

  if (!mtFailed) {
    const mtModel = results[1]!.result as `0x${string}`;
    if (mtModel !== ZERO_ADDRESS) {
      try {
        // ponytail: getFeeRate passes msg.sender as pool to impl.
        // From outside msg.sender != pool, but most models ignore it.
        const mtResult = await publicClient.readContract({
          address: mtModel,
          abi: FEE_MODEL_ABI,
          functionName: "getFeeRate",
          args: [ZERO_ADDRESS],
          ...opts,
        }) as bigint;
        mt = mtResult;
      } catch {
        mtFailed = true;
      }
    }
  }

  return {
    fee: lp + mt,
    anyFailed: results[0]!.status !== "success" || mtFailed,
  };
}

async function fetchDodoMetadataHandler({
  input,
  context,
}: {
  input: { pool: string; blockNumber?: bigint };
  context: { cache: boolean };
}) {
  const poolAddr = input.pool.toLowerCase();
  const blockKey = input.blockNumber != null ? String(input.blockNumber) : "";
  const key = `${poolAddr}-${blockKey}`;

  let promise = inFlightDodo.get(key);
  if (promise) {
    return promise;
  }

  promise = (async () => {
    try {
      const address = input.pool as `0x${string}`;
      let anyFailed = false;
      let fee = 0n;

      {
        const r = await readDodoFeeRates(address, input.blockNumber);
        anyFailed = r.anyFailed;
        fee = r.fee;
      }

      if (fee === 0n && input.blockNumber !== undefined) {
        const latest = await readDodoFeeRates(address);
        if (latest.fee !== 0n) {
          anyFailed = latest.anyFailed;
          fee = latest.fee;
        }
      }

      if (fee === 0n || anyFailed) {
        context.cache = false;
      }

      return { fee, anyFailed };
    } catch (err) {
      const { isPermanent } = classifyRpcError(err);
      context.cache = isPermanent;
      return { fee: 0n, anyFailed: true };
    } finally {
      inFlightDodo.delete(key);
    }
  })();

  inFlightDodo.set(key, promise);
  return promise;
}
