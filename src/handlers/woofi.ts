import { indexer } from "envio";
import { fetchWooFiTokens } from "../effects/woofi_bootstrap";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { WOOFI_PP_V2, WOOFI_PP_V2_DEPLOY_BLOCK, POLYGON_CHAIN_ID } from "../utils/constants";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

/** Minimum token count that signals a completed bootstrap (quoteToken + ≥2 base tokens). */
const BOOTSTRAP_MIN_TOKENS = 3;
/** Re-check interval in blocks; returns immediately once bootstrapped with fee. */
const BOOTSTRAP_EVERY_BLOCKS = 20_000;

/**
 * WooFiBootstrap — sole WOOFi discovery path (no WooSwap subscription).
 * Retries until tokens + fee are both present — fee is required for arb.
 */
indexer.onBlock(
  {
    name: "WooFiBootstrap",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: WOOFI_PP_V2_DEPLOY_BLOCK + 1, _every: BOOTSTRAP_EVERY_BLOCKS } },
      };
    },
  },
  async ({ block, context }) => {
    const existing = await context.PoolMeta.get(WOOFI_PP_V2);
    const tokensOk = (existing?.tokens?.length ?? 0) >= BOOTSTRAP_MIN_TOKENS;
    const feeOk = existing?.fee != null && existing.fee > 0;
    if (tokensOk && feeOk) return;

    const { activeTokens, feeBps } = await context.effect(fetchWooFiTokens, { pool: WOOFI_PP_V2 });

    if (activeTokens.length < 2) return;

    const tokenExisting = new Map<string, { decimals?: number } | undefined>();
    const tokenMetas = await resolveTokenMetasBatch(context, activeTokens, tokenExisting);

    if (context.isPreload) {
      return;
    }

    context.PoolMeta.set(poolMetaEntity({
      id: WOOFI_PP_V2,
      address: WOOFI_PP_V2,
      protocol: "WOOFI" as Protocol,
      tokens: activeTokens.length >= (existing?.tokens?.length ?? 0) ? activeTokens : [...(existing?.tokens ?? [])],
      fee: feeBps > 0 ? feeBps : existing?.fee,
      tickSpacing: undefined,
      createdBlock: existing?.createdBlock ?? Number(block.number),
      updatedAtBlock: Number(block.number),
      poolId: undefined,
    }));

    await setTokenMetasIfMissing(
      context,
      activeTokens,
      tokenMetas.map((m) => m.decimals),
      tokenMetas.map((m) => m.trusted),
      tokenExisting,
    );
  },
);
