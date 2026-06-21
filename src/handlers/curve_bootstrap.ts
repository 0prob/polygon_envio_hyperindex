import { indexer } from "envio";
import { curveFeeToBps, fetchCurveMetadata, isCurveMetadataEmpty } from "../effects/curve_metadata";
import { fetchCurveRegistryPage } from "../effects/curve_registry_bootstrap";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { CURVE_REGISTRY_SOURCES, curveDiscoveryProtocol } from "../utils/curve_registry";

const POLYGON_CHAIN_ID = 137;
const PAGE_SIZE = 40;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_N_COINS = 4;

const bootstrapState = new Map<string, { lastIndex: number; total: number; completed: boolean }>();

const chainStart = (() => {
  const v = process.env.POLYGON_START_BLOCK || process.env.ENVIO_POLYGON_START_BLOCK;
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const earliestCurveDeployBlock = Math.min(...CURVE_REGISTRY_SOURCES.map((s) => s.deployBlock));
const bootstrapStartBlock = Math.max(earliestCurveDeployBlock + 1, chainStart);

interface TokenMetaResult {
  decimals: number;
  trusted: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootstrapRegistryPage(
  context: any,
  block: { number: bigint },
  source: { id: string; address: string; deployBlock: number },
): Promise<void> {
  if (Number(block.number) <= source.deployBlock) return;

  const state = bootstrapState.get(source.id);
  if (state?.completed) return;

  const offset = state?.lastIndex ?? 0;
  const page = await context.effect(fetchCurveRegistryPage, {
    offset,
    limit: PAGE_SIZE,
    registryAddress: source.address,
  });

  if (page.total === 0 || page.pools.length === 0) {
    if (page.total === 0) return;
    bootstrapState.set(source.id, { lastIndex: offset, total: page.total, completed: offset >= page.total });
    return;
  }

  for (const row of page.pools) {
    const existing = await context.PoolMeta.get(row.address);
    if (existing) continue;

    const meta = await context.effect(fetchCurveMetadata, {
      pool: row.address,
      nCoins: DEFAULT_N_COINS,
      blockNumber: block.number,
    });

    const coins = meta.coins.filter((c: string) => c && c !== ZERO);
    if (coins.length < 2) {
      if (isCurveMetadataEmpty(meta) && context.log) {
        context.log.warn("Curve bootstrap metadata unavailable — skipping pool", { pool: row.address });
      }
      continue;
    }

    const coinMetas = (await resolveTokenMetasBatch(context, coins)) as TokenMetaResult[];

    context.PoolMeta.set(poolMetaEntity({
      id: row.address,
      address: row.address,
      protocol: curveDiscoveryProtocol(meta.poolType),
      tokens: coins,
      fee: curveFeeToBps(meta.fee),
      createdBlock: Number(block.number),
      poolId: undefined,
      poolType: meta.poolType,
    }));

    await setTokenMetasIfMissing(
      context,
      coins,
      coinMetas.map((m: TokenMetaResult) => m.decimals),
      coinMetas.map((m: TokenMetaResult) => m.trusted),
    );
  }

  const nextIndex = Math.min(page.total, offset + PAGE_SIZE);
  bootstrapState.set(source.id, { lastIndex: nextIndex, total: page.total, completed: nextIndex >= page.total });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootstrapCurvePools({ block, context }: any) {
  if (context.isPreload) return;

  for (const source of CURVE_REGISTRY_SOURCES) {
    await bootstrapRegistryPage(context, block, source);
  }
}

indexer.onBlock(
  {
    name: "CurveRegistryBootstrap",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: bootstrapStartBlock, _every: 250 } },
      };
    },
  },
  bootstrapCurvePools,
);
