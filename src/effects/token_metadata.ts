import { createEffect, S } from "envio";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  parseAbi,
} from "viem";
import { publicClient, getRpcTransportTuning } from "./rpc_client";
import {
  DISCOVERED_DECIMALS_NDJSON,
  FAILED_DECIMALS_NDJSON,
  TOKEN_REGISTRY_DB,
} from "../utils/data_paths";
import { getTokenMetaEffectRateLimit } from "../utils/pacing";
import {
  appendDiscoveredDecimals,
  appendFailedTokens,
  loadDiscoveredDecimalsEntries,
  loadFailedTokenEntries,
} from "../utils/token_disk";
import { safeDecimals, DAI, USDC, USDC_E, USDT, WBTC, WETH, WMATIC } from "../utils/constants";
import { isNetworkError, isQuotaError } from "./rpc_client";
import { normalizeTokenAddress } from "../utils/normalize_address";

let db: any = null;

/** Well-known Polygon tokens used by handler tests — avoids RPC when Vitest runs without bun:sqlite. */
const VITEST_TOKEN_DECIMALS: Record<string, number> = {
  [WMATIC]: 18,
  [WETH]: 18,
  [USDC_E]: 6,
  [USDT]: 6,
  [USDC]: 6,
  [DAI]: 18,
  [WBTC]: 8,
};

async function initDb() {
  if (db !== null) return;
  const dbPath = TOKEN_REGISTRY_DB;
  let lastError: unknown;

  // Bun runtime (scripts, direct handler runs)
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
    return;
  } catch (e) {
    lastError = e;
  }

  // Node 22+ built-in sqlite (Envio indexer runtime)
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    return;
  } catch (e) {
    lastError = e;
  }

  db = undefined;
  if (process.env.VITEST !== "true") {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    console.warn(
      `[token_metadata] sqlite unavailable, skipping static registry lookup (${detail}; path=${dbPath})`,
    );
  }
}

const PERSIST_FLUSH_DEBOUNCE_MS = 2000;
// No TTL — a contract that isn't ERC20 will never become one. Permanent blocklist.

// Runtime discovered decimals (persisted across restarts for this indexer instance)
const discoveredDecimals: Record<string, number> = {};
const persistedDiscovered = new Set<string>();
let discoveredLoaded = false;
let discoveredDirty = false;
let discoveredFlushTimer: ReturnType<typeof setTimeout> | null = null;
let discoveredSavePending: Promise<void> | null = null;

const registryCache: Map<string, number> = new Map();
let cacheLoaded = false;

const inFlightDecimals = new Map<string, Promise<{ address: string; decimals: number; trusted: boolean }>>();

export type RegistryDecimalsHit = { decimals: number; trusted: true };

/**
 * Batch lookup from static registry + discovered-decimals overlay (0 RPC, 0 effects).
 * Call once per factory event before fetchTokenMeta to avoid effect overhead on known tokens.
 */
export async function lookupRegistryDecimalsBatch(
  addresses: readonly string[],
): Promise<Map<string, RegistryDecimalsHit>> {
  await warmUpCache();
  const out = new Map<string, RegistryDecimalsHit>();
  const seen = new Set<string>();
  for (const raw of addresses) {
    const addr = normalizeTokenAddress(raw);
    if (seen.has(addr)) continue;
    seen.add(addr);
    const decimals = registryCache.get(addr);
    if (decimals !== undefined) {
      out.set(addr, { decimals, trusted: true });
    }
  }
  return out;
}

const PRELOAD_DECIMALS_DEFAULT = { decimals: 18, trusted: false as const };

/** Placeholder for preload when registry + Hasura have no decimals yet. */
export function preloadTokenDecimalsDefault(): { decimals: number; trusted: false } {
  return PRELOAD_DECIMALS_DEFAULT;
}

function seedVitestRegistry(): void {
  for (const [addr, decimals] of Object.entries(VITEST_TOKEN_DECIMALS)) {
    registryCache.set(addr.toLowerCase(), decimals);
  }
}

let warmUpPromise: Promise<void> | null = null;

async function warmUpCache() {
  if (cacheLoaded) return;
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    // ponytail: reset promise on failure so next caller retries instead of
    // getting a stale rejection that deadlocks all future token lookups.
    try {
      await initDb();
      if (db) {
        const stmt = db.prepare("SELECT address, decimals FROM token_decimals");
        const rows = stmt.all() as { address: string; decimals: number }[];
        for (const row of rows) {
          let addr = row.address.toLowerCase();
          if (addr.startsWith("0x") && addr.length < 42) {
            addr = "0x" + addr.slice(2).padStart(40, "0");
          }
          registryCache.set(addr, row.decimals);
        }
      }
      await loadDiscoveredDecimals();
      for (const [addr, decimals] of Object.entries(discoveredDecimals)) {
        registryCache.set(addr, decimals);
      }
      if (process.env.VITEST === "true") {
        seedVitestRegistry();
      }
      cacheLoaded = true;
    } finally {
      warmUpPromise = null;
    }
  })();

  return warmUpPromise;
}

let loadDiscoveredPromise: Promise<void> | null = null;

async function loadDiscoveredDecimals() {
  if (discoveredLoaded) return;
  if (loadDiscoveredPromise) return loadDiscoveredPromise;

  loadDiscoveredPromise = (async () => {
    const data = await loadDiscoveredDecimalsEntries(DISCOVERED_DECIMALS_NDJSON);
    Object.assign(discoveredDecimals, data);
    for (const addr of Object.keys(data)) persistedDiscovered.add(addr);
    discoveredLoaded = true;
    loadDiscoveredPromise = null;
  })();

  return loadDiscoveredPromise;
}

function scheduleDiscoveredDecimalsSave(): void {
  discoveredDirty = true;
  if (discoveredFlushTimer) return;
  discoveredFlushTimer = setTimeout(() => {
    discoveredFlushTimer = null;
    void flushDiscoveredDecimals();
  }, PERSIST_FLUSH_DEBOUNCE_MS);
}

async function flushDiscoveredDecimals(): Promise<void> {
  if (discoveredSavePending) return discoveredSavePending;
  if (!discoveredDirty) return;

  discoveredSavePending = (async () => {
    while (discoveredDirty) {
      discoveredDirty = false;
      const pending = Object.entries(discoveredDecimals)
        .filter(([addr]) => !persistedDiscovered.has(addr))
        .map(([address, decimals]) => ({ address, decimals }));
      if (pending.length === 0) continue;

      try {
        await appendDiscoveredDecimals(DISCOVERED_DECIMALS_NDJSON, pending);
        for (const { address } of pending) persistedDiscovered.add(address);
      } catch (e) {
        discoveredDirty = true;
        console.warn("[token_metadata] Failed to persist discovered decimals:", (e as Error).message);
        break;
      }
    }
  })().finally(() => {
    discoveredSavePending = null;
  });

  return discoveredSavePending;
}

// Permanent blocklist of addresses that are not ERC20 (no decimals()).
// A non-ERC20 contract never becomes one, so no TTL — skip forever.
const failedTokens: Set<string> = new Set();
const persistedFailed = new Set<string>();
let failedLoaded = false;
let failedDirty = false;
let failedFlushTimer: ReturnType<typeof setTimeout> | null = null;
let failedSavePending: Promise<void> | null = null;

let loadFailedPromise: Promise<void> | null = null;

async function loadFailedTokens() {
  if (failedLoaded) return;
  if (loadFailedPromise) return loadFailedPromise;

  loadFailedPromise = (async () => {
    const addrs = await loadFailedTokenEntries(FAILED_DECIMALS_NDJSON);
    for (const addr of addrs) {
      failedTokens.add(addr);
      persistedFailed.add(addr);
    }
    failedLoaded = true;
    loadFailedPromise = null;
  })();

  return loadFailedPromise;
}

function scheduleFailedTokensSave(): void {
  failedDirty = true;
  if (failedFlushTimer) return;
  failedFlushTimer = setTimeout(() => {
    failedFlushTimer = null;
    void flushFailedTokens();
  }, PERSIST_FLUSH_DEBOUNCE_MS);
}

async function flushFailedTokens(): Promise<void> {
  if (failedSavePending) return failedSavePending;
  if (!failedDirty) return;

  failedSavePending = (async () => {
    while (failedDirty) {
      failedDirty = false;
      const pending = [...failedTokens].filter((addr) => !persistedFailed.has(addr));
      if (pending.length === 0) continue;

      try {
        await appendFailedTokens(FAILED_DECIMALS_NDJSON, pending);
        for (const addr of pending) persistedFailed.add(addr);
      } catch (e) {
        failedDirty = true;
        console.warn("[token_metadata] Failed to persist failed tokens:", (e as Error).message);
        break;
      }
    }
  })().finally(() => {
    failedSavePending = null;
  });

  return failedSavePending;
}

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

// Dedup warnings for broken/malformed tokens (e.g. factory address emitted as a token).
const failedDecimalsTokens = new Set<string>();

type DecimalsFetchResult = { address: string; decimals: number; trusted: boolean };

/** Coalesce concurrent cold-token RPC reads into one multicall per tick. */
type RpcBatchWaiter = { context: any; resolve: (value: DecimalsFetchResult) => void };
let pendingRpcBatch = new Map<string, RpcBatchWaiter[]>();
let rpcBatchTimer: ReturnType<typeof setTimeout> | null = null;
let rpcBatchFlushPromise: Promise<void> | null = null;

function rpcBatchWaitMs(): number {
  if (process.env.VITEST === "true") return 0;
  return getRpcTransportTuning().multicallWait;
}

function scheduleDecimalsRpcBatch(): void {
  if (rpcBatchTimer !== null) return;
  rpcBatchTimer = setTimeout(() => {
    rpcBatchTimer = null;
    void flushDecimalsRpcBatch();
  }, rpcBatchWaitMs());
}

function classifyDecimalsError(err: unknown): {
  isZeroData: boolean;
  isReverted: boolean;
  isMalformedInput: boolean;
  isQuota: boolean;
  isNetwork: boolean;
  isDefinitiveError: boolean;
} {
  const errStr = String(err);
  const cause = err instanceof BaseError ? err.walk() : err;
  const isZeroData =
    cause instanceof ContractFunctionZeroDataError ||
    (err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
  const isReverted =
    cause instanceof ContractFunctionRevertedError ||
    (err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionRevertedError) !== null);
  const isMalformedInput =
    errStr.includes("Invalid address") ||
    errStr.includes("odd length") ||
    errStr.includes("cannot unmarshal");
  const isQuota = isQuotaError(err);
  const isNetwork = isNetworkError(err);
  const isDefinitiveError = isZeroData || isReverted || isMalformedInput;
  return { isZeroData, isReverted, isMalformedInput, isQuota, isNetwork, isDefinitiveError };
}

function handleDecimalsFetchFailure(addr: string, err: unknown, context: any): DecimalsFetchResult {
  const { isDefinitiveError, isQuota, isNetwork } = classifyDecimalsError(err);
  const errStr = String(err);

  if (isDefinitiveError && !isQuota && !isNetwork) {
    failedTokens.add(addr);
    scheduleFailedTokensSave();
  }

  if (context.log && !failedDecimalsTokens.has(addr)) {
    failedDecimalsTokens.add(addr);
    if (isQuota) {
      context.log.warn(
        `Alchemy quota / monthly capacity exceeded while fetching decimals. ` +
          `Add more providers to POLYGON_RPC_URLS (comma-separated) or lower effect rateLimits temporarily. ` +
          `Defaulting to 18 for this token (will retry in ~5min).`,
        { token: addr },
      );
    } else if (isNetwork) {
      context.log.warn(`Network error fetching decimals for token — defaulting to 18 (will retry in ~5min)`, {
        token: addr,
        error: errStr.split("\n")[0],
      });
    } else if (isDefinitiveError) {
      context.log.warn(
        `Definitive failure fetching decimals for token — defaulting to 18 (added to permanent blocklist)`,
        { token: addr, error: errStr.split("\n")[0] },
      );
    }
  }

  context.cache = false;
  return { address: addr, decimals: 18, trusted: false };
}

function handleDecimalsFetchSuccess(addr: string, rawDecimals: unknown, context: any): DecimalsFetchResult {
  const decimals = safeDecimals(Number(rawDecimals));
  registryCache.set(addr, decimals);
  discoveredDecimals[addr] = decimals;
  scheduleDiscoveredDecimalsSave();
  if (context.log) {
    context.log.info(`Fetched decimals for new token via RPC (persisted)`, {
      token: addr,
      decimals,
    });
  }
  return { address: addr, decimals, trusted: true };
}

async function flushDecimalsRpcBatch(): Promise<void> {
  if (rpcBatchFlushPromise) return rpcBatchFlushPromise;
  if (pendingRpcBatch.size === 0) return;

  const batch = pendingRpcBatch;
  pendingRpcBatch = new Map();
  const addrs = [...batch.keys()];

  rpcBatchFlushPromise = (async () => {
    try {
      const results = await publicClient.multicall({
        contracts: addrs.map((address) => ({
          address: address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "decimals",
        })),
        allowFailure: true,
      });

      for (let i = 0; i < addrs.length; i++) {
        const addr = addrs[i]!;
        const waiters = batch.get(addr) ?? [];
        const item = results[i];
        for (const waiter of waiters) {
          if (item?.status === "success") {
            waiter.resolve(handleDecimalsFetchSuccess(addr, item.result, waiter.context));
          } else {
            waiter.resolve(handleDecimalsFetchFailure(addr, item?.error ?? new Error("multicall failure"), waiter.context));
          }
        }
        inFlightDecimals.delete(addr);
      }
    } catch (err) {
      for (const [addr, waiters] of batch) {
        for (const waiter of waiters) {
          waiter.resolve(handleDecimalsFetchFailure(addr, err, waiter.context));
        }
        inFlightDecimals.delete(addr);
      }
    }
  })().finally(() => {
    rpcBatchFlushPromise = null;
  });

  return rpcBatchFlushPromise;
}

function enqueueDecimalsRpc(addr: string, context: any): Promise<DecimalsFetchResult> {
  const existing = inFlightDecimals.get(addr);
  if (existing) return existing;

  const promise = new Promise<DecimalsFetchResult>((resolve) => {
    const waiters = pendingRpcBatch.get(addr) ?? [];
    waiters.push({ context, resolve });
    pendingRpcBatch.set(addr, waiters);

    const maxBatch = getRpcTransportTuning().multicallBatchSize;
    if (pendingRpcBatch.size >= maxBatch) {
      if (rpcBatchTimer) {
        clearTimeout(rpcBatchTimer);
        rpcBatchTimer = null;
      }
      void flushDecimalsRpcBatch();
    } else {
      scheduleDecimalsRpcBatch();
    }
  });

  inFlightDecimals.set(addr, promise);
  return promise;
}

/**
 * Fetches token decimals — optimized to avoid RPC as much as possible.
 *
 * Only decimals are pre-generated/sourced here because that is the *only*
 * token metadata the arbitrage engine actually uses (for amount scaling,
 * price impact, profit math, etc.).
 *
 * 1. Large static registry (fastest — 6000+ Polygon tokens, 0 RPC)
 * 2. Batched RPC (last resort)
 *
 * Cold tokens discovered via RPC are appended to `data/discovered-decimals.ndjson`
 * and merged into `data/token_registry.db` on the next `bun run generate-tokens` run.
 *
 * This is the #1 lever for V2Factory.PairCreated performance.
 */
const fetchTokenMetaHandler = async ({ input, context }: { input: { address: string }, context: any }) => {
  await warmUpCache();

  const addr = normalizeTokenAddress(input.address);

  const cached = registryCache.get(addr);
  if (cached !== undefined) {
    return { address: addr, decimals: cached, trusted: true };
  }

  // Check if there is already an in-flight request for this token
  let promise = inFlightDecimals.get(addr);
  if (promise) {
    return promise;
  }

  // Preload phase: skip cold RPC for unknown tokens — execution phase will fetch real decimals.
  if (context?.isPreload) {
    context.cache = false;
    return { address: addr, decimals: 18, trusted: false };
  }

  // Layer 3: Permanent blocklist — non-ERC20 contracts never become valid
  if (!failedLoaded) {
    await loadFailedTokens();
  }
  const isFailed = failedTokens.has(addr);
  if (isFailed) {
    return { address: addr, decimals: 18, trusted: false };
  }

  promise = enqueueDecimalsRpc(addr, context);
  return promise;
};

// Preload skips cold-token RPC (returns placeholder 18); execution uses multicall-batched RPC.
// ~99% of lookups hit registryCache before any effect RPC runs.
export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: {
      address: S.string,
    },
    output: { address: S.string, decimals: S.number, trusted: S.boolean },
    rateLimit: getTokenMetaEffectRateLimit(),
    cache: process.env.VITEST === "true" || process.env.NODE_ENV === "test" ? false : true,
  },
  fetchTokenMetaHandler
);
export { fetchTokenMetaHandler };

// Warm registry before first PairCreated burst (backfill throughput).
void warmUpCache().catch(() => {});

/** @internal Vitest-only — resets module caches between isolated test cases. */
export function resetTokenMetadataCachesForTest(): void {
  if (process.env.VITEST !== "true") return;
  cacheLoaded = false;
  discoveredLoaded = false;
  failedLoaded = false;
  warmUpPromise = null;
  loadDiscoveredPromise = null;
  loadFailedPromise = null;
  db = null;
  registryCache.clear();
  for (const key of Object.keys(discoveredDecimals)) delete discoveredDecimals[key];
  persistedDiscovered.clear();
  failedTokens.clear();
  persistedFailed.clear();
  failedDecimalsTokens.clear();
  discoveredDirty = false;
  failedDirty = false;
  if (discoveredFlushTimer) {
    clearTimeout(discoveredFlushTimer);
    discoveredFlushTimer = null;
  }
  if (failedFlushTimer) {
    clearTimeout(failedFlushTimer);
    failedFlushTimer = null;
  }
  pendingRpcBatch.clear();
  if (rpcBatchTimer) {
    clearTimeout(rpcBatchTimer);
    rpcBatchTimer = null;
  }
  rpcBatchFlushPromise = null;
  inFlightDecimals.clear();
}
