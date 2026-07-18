#!/usr/bin/env bun
/**
 * One-shot ops repair: re-probe Balancer pools missing poolType (and optionally fee)
 * and UPDATE PoolMeta via envio-postgres + RPC.
 *
 *   bun scripts/repair-balancer-pooltype.ts
 *   bun scripts/repair-balancer-pooltype.ts --limit 50 --dry-run
 *   bun scripts/repair-balancer-pooltype.ts --null-fee   # also rows missing fee only
 */
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { spawnSync } from "node:child_process";

const CONTAINER = process.env.ENVIO_POSTGRES_CONTAINER ?? "envio-postgres";
const DB = process.env.ENVIO_POSTGRES_DB ?? "envio-dev";
const USER = process.env.ENVIO_POSTGRES_USER ?? "postgres";
const limitArg = process.argv.includes("--limit")
  ? Number(process.argv[process.argv.indexOf("--limit") + 1])
  : 2000;
const dryRun = process.argv.includes("--dry-run");
/** Also select rows that have poolType but null fee. */
const includeNullFee = process.argv.includes("--null-fee");

const rpc =
  process.env.ENVIO_POLYGON_RPC_URLS?.split(",")[0]?.trim() ||
  process.env.POLYGON_RPC_URLS?.split(",")[0]?.trim() ||
  process.env.ENVIO_POLYGON_RPC_URL ||
  process.env.POLYGON_RPC_URL;
if (!rpc) {
  console.error("No Polygon RPC URL in env");
  process.exit(1);
}

const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;
const ABI = parseAbi([
  "function getSwapFeePercentage() view returns (uint256)",
  "function getNormalizedWeights() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getMainToken() view returns (address)",
  "function getWrappedToken() view returns (address)",
]);
const VAULT_ABI = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)",
]);

const client = createPublicClient({
  chain: polygon,
  transport: http(rpc, { timeout: 30_000 }),
});

function psql(sql: string): string {
  const r = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", USER, "-d", DB, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `psql exit ${r.status}`);
  }
  return r.stdout.trim();
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Row = {
  id: string;
  poolId: string;
  createdBlock: number;
  poolType: string;
  fee: string;
};

function loadIncomplete(limit: number): Row[] {
  const where = includeNullFee
    ? `("poolType" IS NULL OR "poolType" = '' OR fee IS NULL)`
    : `("poolType" IS NULL OR "poolType" = '')`;
  const out = psql(`
    SELECT id || '|' || COALESCE("poolId",'') || '|' || "createdBlock"::text
      || '|' || COALESCE("poolType",'') || '|' || COALESCE(fee::text,'')
    FROM "PoolMeta"
    WHERE protocol = 'BALANCER_V2'
      AND ${where}
    ORDER BY "createdBlock"
    LIMIT ${Math.max(1, Math.min(limit, 5000))};
  `);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [id, poolId, createdBlock, poolType, fee] = line.split("|");
    return {
      id: id!,
      poolId: poolId ?? "",
      createdBlock: Number(createdBlock),
      poolType: poolType ?? "",
      fee: fee ?? "",
    };
  });
}

async function probe(pool: `0x${string}`, poolId: `0x${string}` | undefined) {
  const tryRead = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  const pid = poolId && poolId.length >= 10 ? poolId : undefined;

  const [swapFee, weights, ampResult, mainToken, wrappedToken, poolTokens] = await Promise.all([
    tryRead(() =>
      client.readContract({ address: pool, abi: ABI, functionName: "getSwapFeePercentage" }),
    ),
    tryRead(() =>
      client.readContract({ address: pool, abi: ABI, functionName: "getNormalizedWeights" }),
    ),
    tryRead(() =>
      client.readContract({ address: pool, abi: ABI, functionName: "getAmplificationParameter" }),
    ),
    tryRead(() =>
      client.readContract({ address: pool, abi: ABI, functionName: "getMainToken" }),
    ),
    tryRead(() =>
      client.readContract({ address: pool, abi: ABI, functionName: "getWrappedToken" }),
    ),
    pid
      ? tryRead(() =>
          client.readContract({
            address: BALANCER_VAULT,
            abi: VAULT_ABI,
            functionName: "getPoolTokens",
            args: [pid as `0x${string}`],
          }),
        )
      : Promise.resolve(undefined),
  ]);

  const amp = ampResult ? ampResult[0] : undefined;
  const poolType =
    mainToken != null && wrappedToken != null
      ? "linear"
      : amp != null && amp > 0n
        ? "stable"
        : weights && weights.length > 0
          ? "weighted"
          : null;

  const fee =
    swapFee != null && swapFee > 0n ? Number(swapFee / 10n ** 14n) : null;
  const tokens = poolTokens
    ? poolTokens[0].map((t) => t.toLowerCase()).filter(Boolean)
    : null;

  return { poolType, fee: fee && fee > 0 ? fee : null, tokens };
}

const rows = loadIncomplete(limitArg);
console.log(
  `incomplete balancer rows: ${rows.length} (limit ${limitArg}, missing ${includeNullFee ? "poolType|fee" : "poolType only"})`,
);

let updated = 0;
let skipped = 0;
for (const row of rows) {
  const result = await probe(
    row.id as `0x${string}`,
    (row.poolId || undefined) as `0x${string}` | undefined,
  );

  const missingType = !row.poolType;
  const missingFee = row.fee === "";
  const sets: string[] = [];

  if (missingType && result.poolType) {
    sets.push(`"poolType" = ${sqlStr(result.poolType)}`);
  }
  if (missingFee && result.fee != null) {
    sets.push(`fee = ${result.fee}`);
  }
  // Only refresh tokens when we already have something useful to write (type/fee)
  // and vault returned a full set.
  if (sets.length > 0 && result.tokens && result.tokens.length >= 2) {
    const arr = result.tokens.map(sqlStr).join(",");
    sets.push(`tokens = ARRAY[${arr}]::text[]`);
  }

  if (sets.length === 0) {
    skipped++;
    continue;
  }

  const sql = `UPDATE "PoolMeta" SET ${sets.join(", ")} WHERE id = ${sqlStr(row.id)} AND protocol = 'BALANCER_V2';`;
  if (dryRun) {
    console.log("dry-run", row.id, result);
  } else {
    psql(sql);
    console.log("updated", row.id, result.poolType, result.fee);
  }
  updated++;
}

const remaining = psql(`
  SELECT COUNT(*)::text FROM "PoolMeta"
  WHERE protocol = 'BALANCER_V2' AND ("poolType" IS NULL OR "poolType" = '');
`);

console.log(
  JSON.stringify(
    { updated, skipped, dryRun, remainingMissingPoolType: Number(remaining) || 0 },
    null,
    2,
  ),
);
