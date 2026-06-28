import { indexer } from "envio";
import { fetchWooFiTokens } from "../effects/woofi_bootstrap";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { WOOFI_PP_V2, WOOFI_PP_V2_DEPLOY_BLOCK, ZERO_ADDRESS, POLYGON_CHAIN_ID } from "../utils/constants";
import type { IndexerProtocol as Protocol } from "../utils/indexer_protocol";

const ZERO = ZERO_ADDRESS;
/** WOOFi fee rate in 1e5 units: 25 = 0.025% = 2.5 bps → rounded to 3 for PoolMeta.fee. */
const DEFAULT_WOOFI_FEE_BPS = 3;

function mergeTokensDiff(
  existing: readonly string[] | undefined,
  ...add: string[]
): { merged: string[]; added: string[] } {
  const existingSet = new Set(existing ?? []);
  const merged = [...(existing ?? [])];
  const added: string[] = [];
  for (const t of add) {
    if (t === ZERO || existingSet.has(t)) continue;
    existingSet.add(t);
    merged.push(t);
    added.push(t);
  }
  return { merged, added };
}

/** Minimum token count that signals a completed bootstrap (quoteToken + ≥2 base tokens). */
const BOOTSTRAP_MIN_TOKENS = 3;
/** Re-check interval in blocks; returns immediately once bootstrapped. */
const BOOTSTRAP_EVERY_BLOCKS = 20_000;

/**
 * WooFiBootstrap — one-shot startup discovery of the full WOOFi token set.
 *
 * WOOFi V2 has no factory event and no on-chain token enumeration, so the
 * WooSwap handler below can only discover tokens lazily (one pair per swap).
 * This block handler runs at startup and probes tokenInfos() for every major
 * token to build the complete active-token list immediately — the same pattern
 * used by CurveRegistryBootstrap.
 *
 * It fires every BOOTSTRAP_EVERY_BLOCKS blocks but returns early once
 * PoolMeta.tokens reaches BOOTSTRAP_MIN_TOKENS, so repeat cost is minimal
 * (one context.PoolMeta.get() per stride after the first successful run).
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
    if ((existing?.tokens?.length ?? 0) >= BOOTSTRAP_MIN_TOKENS) {
      return;
    }

    const { quoteToken, activeTokens } = await context.effect(fetchWooFiTokens, { pool: WOOFI_PP_V2 });

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
      tokens: activeTokens,
      fee: existing?.fee && existing.fee > 0 ? existing.fee : DEFAULT_WOOFI_FEE_BPS,
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

    if (context.log) {
      context.log.info("WooFiBootstrap: discovered tokens", {
        pool: WOOFI_PP_V2,
        quoteToken,
        tokenCount: activeTokens.length,
        tokens: activeTokens,
      });
    }
  },
);

/**
 * WooSwap — incremental discovery for any token not already in the active set.
 *
 * Handles tokens that aren't in MAJOR_TOKENS (WooFiBootstrap's probe list) and
 * acts as a fallback if the bootstrap effect fails or the pool gains new tokens
 * after the initial bootstrap. Repeat swaps with no new tokens are a no-op.
 */
indexer.onEvent(
  {
    contract: "WooPPV2",
    event: "WooSwap",
  },
  async ({ event, context }) => {
    const poolAddr = event.srcAddress;
    const t0 = event.params.fromToken;
    const t1 = event.params.toToken;
    const blockNumber = Number(event.block.number);

    const meta = await context.PoolMeta.get(poolAddr);
    const { merged: mergedTokens, added: newTokens } = mergeTokensDiff(
      meta?.tokens, t0, t1,
    );
    if (mergedTokens.length < 2) return;

    // After a successful bootstrap the token list is already complete; this path
    // is a no-op for known tokens and only fires for genuinely new ones.
    if (newTokens.length === 0) return;

    const tokenExisting = new Map<string, { decimals?: number } | undefined>();
    const tokenMetas = await resolveTokenMetasBatch(context, newTokens, tokenExisting);

    if (context.isPreload) {
      return;
    }

    context.PoolMeta.set(poolMetaEntity({
      id: poolAddr,
      address: poolAddr,
      protocol: "WOOFI" as Protocol,
      tokens: mergedTokens,
      fee: meta?.fee && meta.fee > 0 ? meta.fee : DEFAULT_WOOFI_FEE_BPS,
      tickSpacing: undefined,
      createdBlock: meta?.createdBlock ?? blockNumber,
      updatedAtBlock: blockNumber,
      poolId: undefined,
    }));

    await setTokenMetasIfMissing(
      context,
      newTokens,
      tokenMetas.map((m) => m.decimals),
      tokenMetas.map((m) => m.trusted),
      tokenExisting,
    );
  },
);
