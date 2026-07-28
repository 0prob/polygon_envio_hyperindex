import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import { indexer } from "envio";
import { fetchFactoryEventPage } from "../effects/factory_event_reconciliation";
import { fetchAlgebraPoolMeta } from "../effects/algebra_pool_metadata";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { handleDodoPool } from "./dodo_factory";
import { noteBalancerIncomplete } from "./balancer";
import { noteAlgebraIncomplete, clearAlgebraIncomplete } from "./algebra_factory";
import { BALANCER_POOL_TYPE_UNKNOWN } from "../utils/balancer_incomplete";
import {
  ALGEBRA_FACTORY_PROTOCOLS,
  DEPLOY_START,
  POLYGON_CHAIN_ID,
  V2_FACTORY_PROTOCOLS,
  ZERO_ADDRESS,
  contractStartBlock,
  lookupV3FactoryProtocol,
} from "../utils/constants";
import { persistFactoryPoolMeta } from "../utils/factory_pool_handler";
import { isLikelyGarbagePair, shouldSkipFactoryPool } from "../utils/guards";
import { resolveTokenMetasBatch } from "../utils/factory_token_meta";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
import { poolMetaEntity } from "../utils/pool_meta_entity";
import type { IndexerProtocol as Protocol, PoolMetaWritePayload } from "../utils/indexer_protocol";
import type { Effect } from "envio";

const V2_ABI = parseAbi(["event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"]);
const V3_ABI = parseAbi(["event PoolCreated(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool)"]);
const ALGEBRA_ABI = parseAbi(["event Pool(address indexed token0, address indexed token1, address pool)"]);
const V4_ABI = parseAbi(["event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"]);
const BALANCER_ABI = parseAbi(["event PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)"]);
const DODO_ABI = parseAbi([
  "event NewDVM(address baseToken, address quoteToken, address creator, address dvm)",
  "event NewDPP(address baseToken, address quoteToken, address creator, address dpp)",
  "event NewDSP(address baseToken, address quoteToken, address creator, address dsp)",
]);
type SourceKind = "v2" | "v3" | "algebra" | "v4" | "balancer" | "dvm" | "dpp" | "dsp";
type Source = { id: string; address: string; start: number; topic: Hex; kind: SourceKind };

/** Starts match config.yaml `${ENVIO_POLYGON_START_BLOCK:-N}` via contractStartBlock(). */
const SOURCES: Source[] = [
  ...Object.keys(V2_FACTORY_PROTOCOLS).map((address) => ({
    id: `v2-${address}`,
    address,
    start: contractStartBlock(DEPLOY_START.V2_FACTORY),
    topic: toEventSelector("PairCreated(address,address,address,uint256)"),
    kind: "v2" as const,
  })),
  {
    id: "uniswap-v3",
    address: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    start: contractStartBlock(DEPLOY_START.V3_FACTORY),
    topic: toEventSelector("PoolCreated(address,address,uint24,int24,address)"),
    kind: "v3",
  },
  {
    id: "sushiswap-v3",
    address: "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2",
    start: contractStartBlock(DEPLOY_START.V3_FACTORY),
    topic: toEventSelector("PoolCreated(address,address,uint24,int24,address)"),
    kind: "v3",
  },
  {
    id: "quickswap-v3",
    address: "0x411b0facc3489691f28ad58c47006af5e3ab3a28",
    start: contractStartBlock(DEPLOY_START.ALGEBRA_FACTORY),
    topic: toEventSelector("Pool(address,address,address)"),
    kind: "algebra",
  },
  {
    id: "quickswap-v4",
    address: "0x134c1dbe4860a9caaf89002574ffe814772d9904",
    start: contractStartBlock(DEPLOY_START.ALGEBRA_FACTORY),
    topic: toEventSelector("Pool(address,address,address)"),
    kind: "algebra",
  },
  {
    id: "uniswap-v4",
    address: "0x67366782805870060151383f4bbff9dab53e5cd6",
    start: contractStartBlock(DEPLOY_START.POOL_MANAGER),
    topic: toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
    kind: "v4",
  },
  {
    id: "balancer",
    address: "0xba12222222228d8ba445958a75a0704d566bf2c8",
    start: contractStartBlock(DEPLOY_START.BALANCER_VAULT),
    topic: toEventSelector("PoolRegistered(bytes32,address,uint8)"),
    kind: "balancer",
  },
  {
    id: "dodo-dvm",
    address: "0x79887f65f83bdf15bcc8736b5e5bcdb48fb8fe13",
    start: contractStartBlock(DEPLOY_START.DODO_FACTORY),
    topic: toEventSelector("NewDVM(address,address,address,address)"),
    kind: "dvm",
  },
  {
    id: "dodo-dpp",
    address: "0xd24153244066f0afa9415563bfc7ba248bfb7a51",
    start: contractStartBlock(DEPLOY_START.DODO_FACTORY),
    topic: toEventSelector("NewDPP(address,address,address,address)"),
    kind: "dpp",
  },
  {
    id: "dodo-dsp",
    address: "0x43c49f8dd240e1545f147211ec9f917376ac1e87",
    start: contractStartBlock(DEPLOY_START.DODO_FACTORY),
    topic: toEventSelector("NewDSP(address,address,address,address)"),
    kind: "dsp",
  },
];
const EVERY = Number(process.env.FACTORY_EVENT_RECONCILIATION_EVERY ?? "10000");
/**
 * HyperSync page effects are rate-limited (1–N/sec). Firing every EVERY blocks from
 * genesis queues thousands of fetches and freezes the first processing batch
 * (progress_block stuck at start while fetchFactoryEventPage queue grows).
 * Defer until near tip — same pattern as CURVE_BOOTSTRAP_FROM_BLOCK.
 */
const reconcileStartBlock = (() => {
  const fromEnv = Number(process.env.FACTORY_EVENT_RECONCILIATION_FROM_BLOCK);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 90_000_000;
})();
/** Pages drained per onBlock fire once reconciliation is active. */
const PAGES_PER_FIRE = Math.max(1, Number(process.env.FACTORY_EVENT_RECONCILIATION_PAGES ?? "5"));

type ReconcileContext = {
  isPreload: boolean;
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  PoolMeta: {
    get: (id: string) => Promise<{
      id?: string;
      address?: string;
      protocol?: Protocol;
      fee?: number | null;
      tokens?: readonly string[] | null;
      poolType?: string | null;
      tickSpacing?: number | null;
      createdBlock?: number;
      poolId?: string | null;
    } | undefined>;
    set: (entity: PoolMetaWritePayload) => void;
  };
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    getWhere: (filter: { id: { _in: string[] } }) => Promise<{ id: string; decimals?: number }[]>;
    set: (entity: { id: string; decimals: number }) => void;
  };
  BalancerPoolIdMapping: {
    set: (entity: { id: string; poolAddress: string; updatedAtBlock: number }) => void;
  };
};

function decode(abi: ReturnType<typeof parseAbi>, log: { data: string; topics: string[] }) {
  return decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }).args as unknown as Record<string, unknown>;
}

async function reconcileBalancer(context: ReconcileContext, args: Record<string, unknown>, blockNumber: number): Promise<boolean> {
  // Hypersync-decoded addresses are not Envio address_format-normalized.
  const pool = String(args.poolAddress).toLowerCase();
  const poolId = String(args.poolId);
  const existing = await context.PoolMeta.get(pool);
  if (existing?.poolType && existing.fee != null && (existing.tokens?.length ?? 0) >= 2) return true;
  const meta = await context.effect(fetchBalancerMetadata, { pool, poolId, blockNumber: existing ? undefined : BigInt(blockNumber) });
  // Identity unknown yet and probe empty — hold cursor only on transient; permanent empty advances.
  if (meta.tokens.length < 2) return !meta.incompleteTransient;
  const tokenExisting = new Map<string, { decimals?: number } | undefined>();
  const tokenMetas = await resolveTokenMetasBatch(context, meta.tokens, tokenExisting);
  const fee = meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : 0;
  const feeOut = fee > 0 ? fee : existing?.fee;
  const poolType =
    meta.poolType ??
    existing?.poolType ??
    (!meta.incompleteTransient ? BALANCER_POOL_TYPE_UNKNOWN : undefined);
  if (context.isPreload) return true; // keep scheduling effects for later logs in this page
  context.BalancerPoolIdMapping.set({ id: poolId, poolAddress: pool, updatedAtBlock: blockNumber });
  context.PoolMeta.set(poolMetaEntity({
    id: pool,
    address: pool,
    protocol: "BALANCER_V2",
    tokens: meta.tokens,
    fee: feeOut,
    tickSpacing: undefined,
    createdBlock: existing?.createdBlock ?? blockNumber,
    updatedAtBlock: blockNumber,
    poolId,
    specialization: Number(args.specialization),
    poolType,
  }) as PoolMetaWritePayload);
  await setTokenMetasIfMissing(context, meta.tokens, tokenMetas.map((m) => m.decimals), tokenMetas.map((m) => m.trusted), tokenExisting);
  // Identity known → advance recon. Incomplete fee/type stays on the Balancer repair stride.
  noteBalancerIncomplete(
    pool,
    meta.incompleteTransient
      ? { poolType: undefined, fee: feeOut, tokens: meta.tokens }
      : { poolType, fee: feeOut, tokens: meta.tokens },
  );
  return true;
}

async function reconcileLog(context: ReconcileContext, source: Source, log: { data: string; topics: string[]; blockNumber: number }): Promise<boolean> {
  const args = source.kind === "v2" ? decode(V2_ABI, log)
    : source.kind === "v3" ? decode(V3_ABI, log)
      : source.kind === "algebra" ? decode(ALGEBRA_ABI, log)
        : source.kind === "v4" ? decode(V4_ABI, log)
          : source.kind === "balancer" ? decode(BALANCER_ABI, log)
            : decode(DODO_ABI, log);
  if (source.kind === "v2") {
    const token0 = String(args.token0).toLowerCase();
    const token1 = String(args.token1).toLowerCase();
    if (shouldSkipFactoryPool(token0, token1, source.address)) return true;
    const info = V2_FACTORY_PROTOCOLS[source.address];
    if (!info) return true;
    await persistFactoryPoolMeta(context, {
      poolAddr: String(args.pair).toLowerCase(),
      protocol: info.protocol as Protocol,
      token0,
      token1,
      blockNumber: log.blockNumber,
      fee: info.feeBps,
    });
    return true;
  }
  if (source.kind === "v3") {
    const token0 = String(args.token0).toLowerCase();
    const token1 = String(args.token1).toLowerCase();
    if (shouldSkipFactoryPool(token0, token1, source.address)) return true;
    const protocol = lookupV3FactoryProtocol(source.address);
    if (!protocol) return true;
    await persistFactoryPoolMeta(context, {
      poolAddr: String(args.pool).toLowerCase(),
      protocol: protocol as Protocol,
      token0,
      token1,
      blockNumber: log.blockNumber,
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
    });
    return true;
  }
  if (source.kind === "algebra") {
    const token0 = String(args.token0).toLowerCase();
    const token1 = String(args.token1).toLowerCase();
    if (shouldSkipFactoryPool(token0, token1, source.address)) return true;
    const pool = String(args.pool).toLowerCase();
    const existing = await context.PoolMeta.get(pool);
    if (existing?.fee != null && existing.tickSpacing != null) return true;
    const protocol = ALGEBRA_FACTORY_PROTOCOLS[source.address] as Protocol | undefined;
    if (!protocol) return true;

    // Recon is archival-heavy — schedule hist + head concurrently for preload batching.
    const [hist, head] = await Promise.all([
      context.effect(fetchAlgebraPoolMeta, { pool, blockNumber: BigInt(log.blockNumber) }),
      context.effect(fetchAlgebraPoolMeta, { pool }),
    ]);
    const meta =
      hist.fee > 0n && hist.tickSpacing != null
        ? hist
        : head.fee > 0n && head.tickSpacing != null
          ? head
          : hist;

    const fee = meta.fee > 0n ? Number(meta.fee) : undefined;
    const tickSpacing = meta.tickSpacing ?? undefined;

    if (context.isPreload) return true; // keep scheduling effects for later logs in this page

    if (existing) {
      context.PoolMeta.set(poolMetaEntity({
        id: pool,
        address: existing.address ?? pool,
        protocol: existing.protocol ?? protocol,
        tokens: existing.tokens?.length ? [...existing.tokens] : [token0, token1],
        fee: fee ?? existing.fee ?? undefined,
        tickSpacing: tickSpacing ?? existing.tickSpacing ?? undefined,
        createdBlock: existing.createdBlock ?? log.blockNumber,
        updatedAtBlock: log.blockNumber,
        poolId: existing.poolId ?? undefined,
      }) as PoolMetaWritePayload);
    } else {
      await persistFactoryPoolMeta(context, {
        poolAddr: pool,
        protocol,
        token0,
        token1,
        blockNumber: log.blockNumber,
        fee,
        tickSpacing,
      });
    }

    // Identity always known from the event — advance recon. Fee/tick repaired onBlock.
    if (fee == null || tickSpacing == null) {
      noteAlgebraIncomplete(pool, {
        token0,
        token1,
        protocol,
        createdBlock: existing?.createdBlock ?? log.blockNumber,
      });
    } else {
      clearAlgebraIncomplete(pool);
    }
    return true;
  }
  if (source.kind === "v4") {
    const token0 = String(args.currency0).toLowerCase();
    const token1 = String(args.currency1).toLowerCase();
    if (isLikelyGarbagePair(token0, token1)) return true;
    const poolId = String(args.id);
    await persistFactoryPoolMeta(context, {
      poolAddr: poolId,
      protocol: "UNISWAP_V4",
      token0,
      token1,
      blockNumber: log.blockNumber,
      fee: Number(args.fee) === 0x800000 ? undefined : Number(args.fee), // dynamic fee → bot hydrates
      tickSpacing: Number(args.tickSpacing),
      poolId,
      hooks: String(args.hooks).toLowerCase(),
    });
    return true;
  }
  if (source.kind === "balancer") return reconcileBalancer(context, args, log.blockNumber);
  const base = String(args.baseToken).toLowerCase();
  const quote = String(args.quoteToken).toLowerCase();
  if (shouldSkipFactoryPool(base, quote, source.address)) return true;
  const poolField = source.kind === "dvm" ? "dvm" : source.kind === "dpp" ? "dpp" : "dsp";
  return handleDodoPool(context, String(args[poolField]).toLowerCase(), base, quote, log.blockNumber, poolField);
}

indexer.onBlock(
  {
    name: "FactoryEventReconciliation",
    where: ({ chain }) => {
      if (chain.id !== POLYGON_CHAIN_ID) return false;
      return {
        block: { number: { _gte: reconcileStartBlock, _every: EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    const blockNumber = Number(block.number);
    const source = SOURCES[Math.floor(blockNumber / EVERY) % SOURCES.length]!;
    const id = `${context.chain.id}-${source.id}`;
    const state = await context.FactoryEventReconciliationProgress.get(id);
    // Clamp to effective start so a raised ENVIO_POLYGON_START_BLOCK can't resume
    // HyperSync replay from a stale pre-override cursor.
    let fromBlock = Math.max(state?.nextBlock ?? source.start, source.start);
    if (fromBlock >= blockNumber) return;

    let nextBlock = fromBlock;
    for (let pageIdx = 0; pageIdx < PAGES_PER_FIRE; pageIdx++) {
      if (fromBlock >= blockNumber) break;
      // Schedule effect before isPreload gate so preload batching can run.
      const page = await context.effect(fetchFactoryEventPage, {
        address: source.address,
        topic: source.topic,
        fromBlock,
        toBlock: blockNumber + 1,
      });
      if (page.nextBlock <= fromBlock) break;
      for (const log of page.logs) {
        if (!(await reconcileLog(context, source, log))) {
          if (context.isPreload) return;
          if (nextBlock > (state?.nextBlock ?? source.start)) {
            context.FactoryEventReconciliationProgress.set({
              id,
              nextBlock,
              updatedAtBlock: blockNumber,
            });
          }
          return;
        }
      }
      nextBlock = page.nextBlock;
      fromBlock = page.nextBlock;
    }

    if (context.isPreload) return;
    if (nextBlock > (state?.nextBlock ?? source.start)) {
      context.FactoryEventReconciliationProgress.set({
        id,
        nextBlock,
        updatedAtBlock: blockNumber,
      });
    }
  },
);
